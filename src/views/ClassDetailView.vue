<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppIconButton from "../components/ui/AppIconButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppInput from "../components/ui/AppInput.vue";
import AppLink from "../components/ui/AppLink.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import StudentTable from "../components/StudentTable.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import ImportRosterDialog from "../components/ImportRosterDialog.vue";
import ImportTimetableDialog from "../components/ImportTimetableDialog.vue";
import ImportScoreDialog from "../components/ImportScoreDialog.vue";
import ExamScorePanel from "../components/ExamScorePanel.vue";
import ClassFormDialog from "../components/ClassFormDialog.vue";
import QuickBehaviorPopover from "../components/QuickBehaviorPopover.vue";
import ClassBehaviorTimeline from "../components/ClassBehaviorTimeline.vue";
import TimetableGrid from "../components/TimetableGrid.vue";
import TimetableCalendar from "../components/TimetableCalendar.vue";
import {
  addClassPhoto,
  createStudent,
  deleteBehaviorRecord,
  deleteClass,
  findOrCreateTimetable,
  getClassSummary,
  getTimetableWithSlots,
  isTauri,
  listBehaviorRecordsByClass,
  listClasses,
  listExamsByClass,
  listPhotosByClass,
  listStudents,
  listTimetableSlotsWithClass,
  renameClass,
  saveTimetableMySubjects,
} from "../lib/db";
import { currentSemester, resolveClassMySubjects, weekdayOf } from "../lib/timetable";
import { ensureProfile, profile } from "../lib/profile";
import { getPhotosDir, importPhoto, photoUrl } from "../lib/photos";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { RosterImportResult, RosterTable } from "../lib/roster";
import type { BehaviorPolarity, ClassBehaviorRecord, ClassSummary, Photo, StudentInput, StudentRow, Timetable, TimetableSlot, TimetableSlotWithClass } from "../types";

const props = defineProps<{ name: string }>();
const router = useRouter();

const summary = ref<ClassSummary | null>(null);
const students = ref<StudentRow[]>([]);
const classStudents = ref<StudentRow[]>([]);
const photos = ref<Photo[]>([]);
const behaviorRecords = ref<ClassBehaviorRecord[]>([]);
const photosDir = ref("");
const studentNames = ref<Map<number, string>>(new Map());
const existingClasses = ref<ClassSummary[]>([]);

const keyword = ref("");
const activeTab = ref<"students" | "photos" | "behaviors" | "scores" | "timetable">("students");
const photoFilter = ref<"all" | "public" | "student">("all");
const examCount = ref(0);

/* 课程表 Tab：默认直接展示可编辑的周网格；日历承载调课与日程 */
const TIMETABLE_SEMESTER = currentSemester();
const TIMETABLE_TODAY = weekdayOf();
const timetable = ref<(Timetable & { slots: TimetableSlot[] }) | null>(null);
const timetableLoading = ref(false);
const timetableError = ref("");
const timetableView = ref<"calendar" | "grid">("grid");
/** 跨班撞课检测素材：本学期全部班级格子（联班级名/我的科目标记），传给 TimetableGrid */
const conflictRows = ref<TimetableSlotWithClass[]>([]);

async function loadConflictRows(): Promise<void> {
  conflictRows.value = await listTimetableSlotsWithClass(TIMETABLE_SEMESTER).catch(
    () => [] as TimetableSlotWithClass[]
  );
}

/* ---------------- 我的科目标记（班级 × 科目）：胶囊条点选即存 ---------------- */

const markingSaving = ref(false);

/** 本班课表出现过的科目（去重按中文序），作为胶囊候选 */
const classSubjects = computed<string[]>(() => {
  const set = new Set<string>();
  for (const slot of timetable.value?.slots ?? []) {
    const s = slot.subject.trim();
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "zh"));
});

/** 该科目是否算「我的课」：按班级标记（null 回退个人任教学科） */
function isMarkedMine(subject: string): boolean {
  if (!timetable.value) return false;
  const effective = resolveClassMySubjects(
    timetable.value.my_subjects,
    profile.value.my_subjects ?? [],
  );
  return effective.includes(subject);
}

/** 点胶囊切换标记：在「当前生效集合」上增减后落库 */
async function toggleMySubject(subject: string): Promise<void> {
  if (!timetable.value || markingSaving.value) return;
  const effective = resolveClassMySubjects(
    timetable.value.my_subjects,
    profile.value.my_subjects ?? [],
  );
  const next = isMarkedMine(subject)
    ? effective.filter((s) => s !== subject)
    : [...effective, subject];
  markingSaving.value = true;
  try {
    await saveTimetableMySubjects(timetable.value.id, next);
    timetable.value = { ...timetable.value, my_subjects: [...next].sort((a, b) => a.localeCompare(b, "zh")) };
  } finally {
    markingSaving.value = false;
  }
}

async function openTimetableTab() {
  activeTab.value = "timetable";
  if (timetable.value || timetableLoading.value) return;
  timetableLoading.value = true;
  timetableError.value = "";
  try {
    await ensureProfile().catch(() => undefined);
    await findOrCreateTimetable(props.name, TIMETABLE_SEMESTER);
    const [withSlots] = await Promise.all([
      getTimetableWithSlots(props.name, TIMETABLE_SEMESTER),
      loadConflictRows(),
    ]);
    timetable.value = withSlots;
  } catch (e) {
    timetableError.value = `课表加载失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    timetableLoading.value = false;
  }
}

async function refreshTimetable() {
  const [withSlots] = await Promise.all([
    getTimetableWithSlots(props.name, TIMETABLE_SEMESTER),
    loadConflictRows(),
  ]);
  timetable.value = withSlots;
}

const importOpen = ref(false);
const timetableImportOpen = ref(false);
const createDialogOpen = ref(false);
const renameDialogOpen = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);
// 花名册对话框检测到成绩单后交接进来：携带已解析表格直接进入成绩导入
const scoreImportOpen = ref(false);
const scoreHandoff = ref<{ table: RosterTable; fileName: string } | null>(null);

function switchToScoreImport(payload: { table: RosterTable; fileName: string }) {
  importOpen.value = false;
  scoreHandoff.value = payload;
  scoreImportOpen.value = true;
  activeTab.value = "scores";
}

function closeScoreImport() {
  scoreImportOpen.value = false;
  scoreHandoff.value = null;
}

/** 花名册导入完成：无失败行 → 关闭对话框回到学生条目；有失败行 → 留在对话框看明细 */
function onRosterImported(payload: { result: RosterImportResult; targetClass: string | null }) {
  void refresh();
  if (payload.result.failed.length > 0) {
    showToast(`导入完成，但有 ${payload.result.failed.length} 行失败，请在对话框中查看明细`);
    return;
  }
  importOpen.value = false;
  activeTab.value = "students";
  showToast(
    `花名册导入完成：成功 ${payload.result.imported} · 更新 ${payload.result.updated} · 跳过 ${payload.result.skipped.length}`,
  );
}

/** 成绩导入完成：关闭对话框，回到考试成绩 Tab（若归属其他班级则跳过去） */
function onScoreImported(payload: { className: string | null }) {
  closeScoreImport();
  void refresh();
  if (payload.className && payload.className !== props.name) {
    router.push({ name: "class-detail", params: { name: payload.className } });
    return;
  }
  activeTab.value = "scores";
  showToast("成绩导入完成，已关联到学生档案");
}

const quickOpen = ref(false);
const quickStudent = ref<StudentRow | null>(null);
const quickAnchor = ref<{ x: number; y: number } | null>(null);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const filterOptions: { label: string; value: "all" | "public" | "student" }[] = [
  { label: "全部", value: "all" },
  { label: "班级公共", value: "public" },
  { label: "学生个人", value: "student" },
];

async function refresh() {
  const [sum, studentList, photoList, allStudents, pDir, classList, bList, examList] = await Promise.all([
    getClassSummary(props.name),
    listStudents(keyword.value, props.name),
    listPhotosByClass(props.name, photoFilter.value),
    listStudents(),
    getPhotosDir(),
    listClasses(),
    listBehaviorRecordsByClass(props.name),
    listExamsByClass(props.name),
  ]);
  summary.value = sum;
  students.value = studentList;
  photos.value = photoList;
  photosDir.value = pDir;
  studentNames.value = new Map(allStudents.map((s) => [s.id, s.name]));
  classStudents.value = allStudents.filter((s) => s.grade_class === props.name);
  existingClasses.value = classList;
  behaviorRecords.value = bList;
  examCount.value = examList.length;
}

function openQuickBehavior(targetStudentId?: number) {
  quickAnchor.value = null;
  if (targetStudentId) {
    quickStudent.value = classStudents.value.find((s) => s.id === targetStudentId) ?? null;
  } else {
    quickStudent.value = classStudents.value[0] ?? null;
  }
  quickOpen.value = true;
}

function showToast(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2400);
}

/** 仅重拉班级表现流水：局部更新概览卡与日常表现 Tab 的计数，不整页刷新 */
async function refreshBehaviorRecords() {
  behaviorRecords.value = await listBehaviorRecordsByClass(props.name);
}

async function onQuickSaved(payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }) {
  showToast(`已记录 ${payload.studentName} ${payload.dimensionName}`);
  await refreshBehaviorRecords();
}

/** 学生表格内快捷记表现：表格已自带 toast，这里只负责刷新表现数据 */
async function onTableBehaviorSaved() {
  await refreshBehaviorRecords();
}

/** 删除一条表现记录（含评语），并刷新时间轴 */
async function handleRemoveBehavior(recordId: number) {
  await deleteBehaviorRecord(recordId);
  showToast("已删除该条表现记录");
  await refreshBehaviorRecords();
}

function goStudentById(studentId: number) {
  router.push({ name: "student-detail", params: { id: studentId } });
}

async function handleRenameClass(newName: string) {
  if (newName && newName !== props.name) {
    try {
      await renameClass(props.name, newName);
    } catch (e) {
      // 失败保持弹窗打开，错误上浮到 toast——不再静默只进日志
      showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    renameDialogOpen.value = false;
    router.replace({ name: "class-detail", params: { name: newName } });
  } else {
    renameDialogOpen.value = false;
  }
}

/** 删除整个班级：学生/照片/表现记录整体进回收站，保留 7 天可恢复 */
async function onDeleteClass() {
  const message = `删除班级「${props.name}」？班级下的学生、照片与表现记录将移入回收站，保留 7 天，期间可恢复。`;
  const ok = isTauri()
    ? await confirm(message, { title: "删除班级", kind: "warning" })
    : window.confirm(message);
  if (!ok) return;
  try {
    await deleteClass(props.name);
  } catch (e) {
    showToast(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  router.push({ name: "classes" });
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    students.value = await listStudents(keyword.value, props.name);
  }, 200);
});

watch(photoFilter, async () => {
  photos.value = await listPhotosByClass(props.name, photoFilter.value);
});

watch(() => props.name, () => {
  timetable.value = null;
  timetableError.value = "";
  refresh();
});

onMounted(refresh);
onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(toastTimer);
});

function openImportDialog() {
  importOpen.value = true;
}

function openCreateStudentDialog() {
  createDialogOpen.value = true;
}

async function handleCreateStudent(input: StudentInput) {
  await createStudent({ ...input, grade_class: input.grade_class || props.name });
  createDialogOpen.value = false;
  await refresh();
}

async function openAddPhotoDialog() {
  if (isTauri()) {
    const fileName = await importPhoto();
    if (fileName) {
      await addClassPhoto(
        props.name,
        fileName,
        `${props.name}活动照片`,
        new Date().toISOString().slice(0, 10)
      );
      await refresh();
    }
  } else {
    fileInputRef.value?.click();
  }
}

async function onFileSelected(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) {
    await addClassPhoto(
      props.name,
      file.name,
      file.name.replace(/\.[^/.]+$/, "") || `${props.name}照片`,
      new Date().toISOString().slice(0, 10)
    );
    await refresh();
    target.value = "";
  }
}

function goStudentDetail(row: StudentRow) {
  router.push({ name: "student-detail", params: { id: row.id } });
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-parchment">
    <!-- 隐藏的浏览器文件选择器 -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*"
      class="hidden"
      @change="onFileSelected"
    />

    <!-- Header -->
    <header class="border-b border-divider bg-canvas px-8 py-4 shrink-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-4 min-w-0">
          <AppLink to="/classes" icon="back" class="font-medium shrink-0">班级管理</AppLink>
          <span class="text-hairline shrink-0">|</span>
          <div class="min-w-0">
            <div class="flex items-baseline gap-3 flex-wrap">
              <div class="flex items-center gap-2">
                <h1 class="text-display font-semibold text-ink truncate">{{ name }}</h1>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-weak hover:bg-pearl hover:text-ink transition-colors"
                  title="修改班级名称"
                  @click="renameDialogOpen = true"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  type="button"
                  data-test="delete-class-btn"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-weak hover:bg-[#fdeef0] hover:text-danger transition-colors"
                  title="删除班级"
                  @click="onDeleteClass"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
              <span class="text-caption text-weak">
                {{ summary?.studentCount ?? 0 }} 名学生 ({{ summary?.maleCount ?? 0 }} 男 · {{ summary?.femaleCount ?? 0 }} 女) · 照片 {{ summary?.photoCount ?? 0 }} 张
              </span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <AppButton variant="primary" @click="openCreateStudentDialog">新建学生</AppButton>
        </div>
      </div>
    </header>

    <!-- 主体区域 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6 space-y-6">
      <!-- 概览指标卡片 -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <AppCard>
          <div class="text-caption text-weak">本班学生</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.studentCount ?? 0 }} 人
          </div>
          <div class="mt-1 text-fine text-muted">
            男 {{ summary?.maleCount ?? 0 }} · 女 {{ summary?.femaleCount ?? 0 }}
          </div>
        </AppCard>

        <AppCard>
          <div class="text-caption text-weak">班级照片</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.photoCount ?? 0 }} 张
          </div>
          <div class="mt-1 text-fine text-muted">
            公共 {{ summary?.classPhotoCount ?? 0 }} · 个人 {{ summary?.studentPhotoCount ?? 0 }}
          </div>
        </AppCard>

        <AppCard>
          <div class="text-caption text-weak">档案动态</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ students.length }} 名有效学生
          </div>
          <div class="mt-1 text-fine text-muted">已归档 · {{ behaviorRecords.length }} 条表现记录</div>
        </AppCard>
      </div>

      <!-- Tab 切换 -->
      <div class="flex items-center gap-3 border-b border-hairline pb-3">
        <button
          type="button"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'students' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'students'"
        >
          学生条目 ({{ summary?.studentCount ?? students.length }})
        </button>
        <button
          type="button"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'photos' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'photos'"
        >
          班级相册 ({{ summary?.photoCount ?? 0 }})
        </button>
        <button
          type="button"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'behaviors' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'behaviors'"
        >
          日常表现 ({{ behaviorRecords.length }})
        </button>
        <button
          type="button"
          data-test="tab-scores"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'scores' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'scores'"
        >
          考试成绩 ({{ examCount }})
        </button>
        <button
          type="button"
          data-test="tab-timetable"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'timetable' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="openTimetableTab"
        >
          课程表
        </button>
      </div>

      <!-- Tab 1: 学生条目 -->
      <div v-if="activeTab === 'students'" class="space-y-4">
        <div class="flex items-center gap-3">
          <AppInput
            v-model="keyword"
            placeholder="搜索本班学生姓名或学号"
            width="320px"
          />
          <AppIconButton
            label="导入本班花名册"
            data-test="import-roster-btn"
            @click="openImportDialog"
          >
            <!-- 语义图标：上传托盘，表示批量导入花名册 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 8l5-5 5 5" />
              <path d="M12 3v12" />
            </svg>
          </AppIconButton>
        </div>

        <StudentTable
          v-if="students.length"
          :rows="students"
          @open="goStudentDetail"
          @saved="onTableBehaviorSaved"
        />

        <EmptyState
          v-else
          title="暂无学生"
          description="点击上方「导入花名册」图标或右上角「新建学生」为本班添加学生"
        />
      </div>

      <!-- Tab 2: 班级相册 -->
      <div v-else-if="activeTab === 'photos'" class="space-y-4">
        <!-- 筛选标签 -->
        <div class="flex items-center gap-2">
          <button
            v-for="f in filterOptions"
            :key="f.value"
            type="button"
            class="rounded-pill px-3 py-1 text-fine transition-colors"
            :class="photoFilter === f.value ? 'bg-ink text-canvas font-medium' : 'bg-canvas border border-hairline text-weak hover:text-ink hover:border-ink'"
            @click="photoFilter = f.value"
          >
            {{ f.label }}
          </button>
          <AppIconButton
            label="添加班级照片"
            data-test="add-photo-btn"
            class="ml-1.5"
            @click="openAddPhotoDialog"
          >
            <!-- 语义图标：相框留缺角 + 加号，表示向班级相册添加照片 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
              <circle cx="9" cy="10" r="1.5" />
              <path d="M3.5 18.5l4-3.5 3 2.5 3.5-3 5.5 4.5" />
              <path d="M18.5 3v7M15 6.5h7" />
            </svg>
          </AppIconButton>
        </div>

        <!-- 照片卡片列表 -->
        <div
          v-if="photos.length"
          class="grid gap-4"
          style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))"
        >
          <figure
            v-for="photo in photos"
            :key="photo.id"
            class="overflow-hidden rounded-lg border border-hairline bg-canvas"
          >
            <div class="relative h-[160px] overflow-hidden bg-parchment">
              <img
                v-if="photoUrl(photosDir, photo.file_name)"
                class="h-full w-full object-cover"
                :src="photoUrl(photosDir, photo.file_name)"
                :alt="photo.caption ?? ''"
              />
              <div v-else class="flex h-full items-center justify-center text-fine text-weak">
                示例图片
              </div>
              <span
                class="absolute left-2 top-2 rounded-sm px-2 py-0.5 text-fine font-medium shadow-sm"
                :class="photo.student_id == null ? 'bg-primary text-canvas' : 'bg-canvas/90 text-ink'"
              >
                {{ photo.student_id == null ? "班级公共" : "个人归档" }}
              </span>
            </div>
            <figcaption class="space-y-1 p-3">
              <p class="text-caption font-semibold text-ink truncate">{{ photo.caption || "未命名" }}</p>
              <p class="text-fine text-weak">
                {{ (photo.taken_at || photo.created_at || "").slice(0, 10) }}
                <span v-if="photo.student_id != null && studentNames.get(photo.student_id)">
                  · {{ studentNames.get(photo.student_id) }}
                </span>
              </p>
            </figcaption>
          </figure>
        </div>

        <EmptyState
          v-else
          title="暂无相册照片"
          description="点击上方「添加班级照片」图标上传班级活动照片"
        />
      </div>

      <!-- Tab 3: 日常表现 -->
      <div v-else-if="activeTab === 'behaviors'" class="space-y-4">
          <ClassBehaviorTimeline
            :records="behaviorRecords"
            :class-students="classStudents"
          @add="openQuickBehavior"
          @select-student="goStudentById"
          @remove="handleRemoveBehavior"
        />
      </div>

      <!-- Tab 4: 考试成绩 -->
      <div v-else-if="activeTab === 'scores'">
        <ExamScorePanel :class-name="name" />
      </div>

      <!-- Tab 5: 课程表：默认周网格，日历用于调课与日程 -->
      <div v-else-if="activeTab === 'timetable'" class="space-y-4">
        <p v-if="timetableError" class="rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
          {{ timetableError }}
        </p>
        <p v-else-if="timetableLoading" class="text-caption text-weak">正在载入课表…</p>
        <template v-else-if="timetable">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
              <button
                type="button"
                data-test="timetable-view-grid"
                class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
                :class="timetableView === 'grid' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
                @click="timetableView = 'grid'"
              >
                课表
              </button>
              <button
                type="button"
                data-test="timetable-view-calendar"
                class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
                :class="timetableView === 'calendar' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
                @click="timetableView = 'calendar'"
              >
                日历
              </button>
            </div>
            <div class="flex items-center gap-3">
              <p v-if="timetableView === 'grid'" class="text-fine text-weak">
                换课 / 停课 / 日程在日历视图维护
              </p>
              <AppButton
                variant="pearl"
                data-test="timetable-import-btn"
                @click="timetableImportOpen = true"
              >
                导入课表
              </AppButton>
            </div>
          </div>
          <!-- 我的科目标记：点胶囊即存，勾选科目的格子高亮内描边 -->
          <div
            v-if="classSubjects.length"
            class="flex flex-wrap items-center gap-2 rounded-md bg-parchment p-3"
            data-test="my-subjects-strip"
          >
            <span class="text-caption text-ink">我的科目</span>
            <button
              v-for="s in classSubjects"
              :key="s"
              type="button"
              data-test="my-subject-chip"
              :disabled="markingSaving"
              class="rounded-pill border px-2.5 py-0.5 text-fine transition-colors disabled:opacity-40"
              :class="
                isMarkedMine(s)
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-hairline bg-canvas text-muted hover:border-ink'
              "
              :aria-pressed="isMarkedMine(s)"
              @click="toggleMySubject(s)"
            >
              {{ s }}
            </button>
            <span class="min-w-0 flex-1 text-fine text-weak">
              勾选的科目会高亮并汇入「我的课表」；从没标记过的班级按个人资料的任教学科自动匹配
            </span>
          </div>
          <TimetableCalendar
            v-if="timetableView === 'calendar'"
            :class-name="name"
            :timetable="timetable"
            @edit="timetableView = 'grid'"
          />
          <TimetableGrid
            v-else
            :timetable="timetable"
            :slots="timetable.slots"
            editable
            :my-subjects="profile.my_subjects ?? []"
            :class-marked="timetable.my_subjects"
            :conflict-rows="conflictRows"
            :today="TIMETABLE_TODAY"
            @changed="refreshTimetable"
          />
          <ImportTimetableDialog
            :open="timetableImportOpen"
            :preset-class="name"
            @close="timetableImportOpen = false"
            @imported="refreshTimetable(); timetableImportOpen = false"
          />
        </template>
      </div>
    </div>

    <!-- 对话框 -->
    <ImportRosterDialog
      :open="importOpen"
      :preset-class="name"
      @close="importOpen = false"
      @imported="onRosterImported"
      @switch-to-scores="switchToScoreImport"
    />

    <ImportScoreDialog
      :open="scoreImportOpen"
      :preset-class="name"
      :initial-table="scoreHandoff?.table ?? null"
      :initial-file-name="scoreHandoff?.fileName ?? ''"
      @close="closeScoreImport"
      @imported="onScoreImported"
    />

    <StudentFormDialog
      :open="createDialogOpen"
      :initial="{ grade_class: name }"
      @close="createDialogOpen = false"
      @submit="handleCreateStudent"
    />

    <ClassFormDialog
      :open="renameDialogOpen"
      mode="rename"
      :initial-name="name"
      :existing-classes="existingClasses"
      @close="renameDialogOpen = false"
      @submit="handleRenameClass"
    />

    <QuickBehaviorPopover
      :open="quickOpen"
      :student="quickStudent"
      :students="classStudents"
      :anchor="quickAnchor"
      @close="quickOpen = false"
      @saved="onQuickSaved"
    />

    <!-- 快捷记表现 Toast 提示 -->
    <Transition name="qb-toast">
      <div
        v-if="toast"
        data-test="quick-toast"
        class="fixed inset-x-0 top-4 z-[60] mx-auto w-fit rounded-full bg-tile px-4 py-1.5 text-fine text-white shadow-lg"
      >
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.qb-toast-enter-active,
.qb-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.qb-toast-enter-from,
.qb-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
