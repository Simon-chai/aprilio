<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import type { ClassFormValue } from "../components/ClassFormDialog.vue";
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
  getClassMeta,
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
  archiveClass,
  restoreClass,
  saveClassMeta,
  saveTimetableMySubjects,
} from "../lib/db";
import { currentSemester, resolveClassMySubjects, weekdayOf } from "../lib/timetable";
import { classCurrentLabel } from "../lib/semester";
import { ensureProfile, profile, timetableBgSurfaceClass, timetableBgSurfaceStyle } from "../lib/profile";
import { getPhotosDir, importPhoto, photoUrl } from "../lib/photos";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { RosterImportResult, RosterTable } from "../lib/roster";
import type { BehaviorPolarity, ClassBehaviorRecord, ClassSummary, Photo, StudentInput, StudentRow, Timetable, TimetableSlot, TimetableSlotWithClass } from "../types";

const props = defineProps<{ name: string }>();
const router = useRouter();

const summary = ref<ClassSummary | null>(null);
/** 班级元信息：初始年级 / 起始学期 / 归档状态 */
const classMeta = ref<{ entry_grade: number | null; entry_semester: string | null; archived_at: string | null }>({
  entry_grade: null,
  entry_semester: null,
  archived_at: null,
});
/** 归档班级为只读态：隐藏全部写入口 */
const readOnly = computed(() => Boolean(classMeta.value.archived_at));
/** 当前年级文案（未登记年级为 null） */
const currentGradeLabel = computed(() =>
  classCurrentLabel(classMeta.value.entry_grade, classMeta.value.entry_semester),
);
const students = ref<StudentRow[]>([]);
const classStudents = ref<StudentRow[]>([]);
const photos = ref<Photo[]>([]);
const behaviorRecords = ref<ClassBehaviorRecord[]>([]);
const photosDir = ref("");
const studentNames = ref<Map<number, string>>(new Map());
const existingClasses = ref<ClassSummary[]>([]);

/* ---------------- 班级名下拉：就地切换其他班级 ---------------- */

const classSwitchOpen = ref(false);
const classSwitchRoot = ref<HTMLElement | null>(null);
const classSwitchMenu = ref<HTMLElement | null>(null);

/** 下拉候选：全部班级按名称排序——含当前班级，菜单里高亮打勾，看起来就是「选班级」而不是一串链接 */
const sortedClasses = computed<ClassSummary[]>(() =>
  [...existingClasses.value].sort((a, b) => a.name.localeCompare(b.name, "zh")),
);

/** 展开下拉：滚动到当前班级那一项，班级多时也不会「不知道自己在哪」 */
async function toggleClassSwitch(): Promise<void> {
  classSwitchOpen.value = !classSwitchOpen.value;
  if (!classSwitchOpen.value) return;
  await nextTick();
  const active = classSwitchMenu.value?.querySelector<HTMLElement>('[aria-current="page"]');
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
}

/** 选中班级 → 跳转到该班详情；点当前班级只收起 */
function switchClass(target: string): void {
  classSwitchOpen.value = false;
  if (target === props.name) return;
  router.push({ name: "class-detail", params: { name: target } });
}

/** 点击下拉以外的地方收起 */
function onClassSwitchMouseDown(e: MouseEvent): void {
  if (classSwitchOpen.value && !classSwitchRoot.value?.contains(e.target as Node)) {
    classSwitchOpen.value = false;
  }
}

function onClassSwitchKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") classSwitchOpen.value = false;
}

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

/** 课表请求序号：班级切换时，旧班级的响应不能覆盖新班级的课表 */
let timetableSeq = 0;

async function loadTimetable(): Promise<void> {
  const seq = ++timetableSeq;
  const target = props.name;
  timetableLoading.value = true;
  timetableError.value = "";
  try {
    await ensureProfile().catch(() => undefined);
    await findOrCreateTimetable(target, TIMETABLE_SEMESTER);
    const [withSlots] = await Promise.all([
      getTimetableWithSlots(target, TIMETABLE_SEMESTER),
      loadConflictRows(),
    ]);
    if (seq !== timetableSeq) return;
    timetable.value = withSlots;
  } catch (e) {
    if (seq !== timetableSeq) return;
    timetableError.value = `课表加载失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (seq === timetableSeq) timetableLoading.value = false;
  }
}

async function openTimetableTab(): Promise<void> {
  activeTab.value = "timetable";
  if (timetable.value || timetableLoading.value) return;
  await loadTimetable();
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
  const [sum, studentList, photoList, allStudents, pDir, classList, bList, examList, meta] = await Promise.all([
    getClassSummary(props.name),
    listStudents(keyword.value, props.name),
    listPhotosByClass(props.name, photoFilter.value),
    listStudents(),
    getPhotosDir(),
    listClasses(),
    listBehaviorRecordsByClass(props.name),
    listExamsByClass(props.name),
    getClassMeta(props.name),
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
  classMeta.value = meta;
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

async function handleRenameClass(value: ClassFormValue) {
  const newName = value.name;
  if (newName && newName !== props.name) {
    try {
      await renameClass(props.name, newName);
      await saveClassMeta(newName, {
        entry_grade: value.entry_grade,
        entry_semester: value.entry_semester,
      });
    } catch (e) {
      // 失败保持弹窗打开，错误上浮到 toast——不再静默只进日志
      showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    renameDialogOpen.value = false;
    router.replace({ name: "class-detail", params: { name: newName } });
  } else {
    // 名称未变：仍可能改了年级 / 学期
    try {
      await saveClassMeta(props.name, {
        entry_grade: value.entry_grade,
        entry_semester: value.entry_semester,
      });
    } catch (e) {
      showToast(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    renameDialogOpen.value = false;
  }
}

/** 归档班级：移入「历史带过的班」，数据只读保留；回到班级管理页 */
async function onArchiveClass() {
  const message = `归档班级「${props.name}」？归档后从班级管理移出，进入「历史带过的班」，数据只读保留、可随时恢复。`;
  const ok = isTauri()
    ? await confirm(message, { title: "归档班级", kind: "warning" })
    : window.confirm(message);
  if (!ok) return;
  try {
    await archiveClass(props.name);
  } catch (e) {
    showToast(`归档失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  router.push({ name: "classes" });
}

/** 恢复归档班级：回到在用列表 */
async function onRestoreClass() {
  try {
    await restoreClass(props.name);
  } catch (e) {
    showToast(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  showToast("已恢复到在用班级");
  await refresh();
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
  void refresh();
  // 停留在课程表 Tab 时切换班级：必须重新拉新班级的课表，否则 Tab 整块空白
  if (activeTab.value === "timetable") void loadTimetable();
});

onMounted(() => {
  document.addEventListener("mousedown", onClassSwitchMouseDown);
  document.addEventListener("keydown", onClassSwitchKeydown);
  void refresh();
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onClassSwitchMouseDown);
  document.removeEventListener("keydown", onClassSwitchKeydown);
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
                <!-- 班级名即切换入口：点击下拉列出其他班级，选中跳转 -->
                <div ref="classSwitchRoot" class="relative min-w-0">
                  <h1 class="flex min-w-0 items-center">
                    <!-- 触发器做成「下拉选择器」外形：边框 + 班级徽标 + 箭头，展开时主色描边 -->
                    <button
                      type="button"
                      data-test="class-switch-trigger"
                      class="flex min-w-0 items-center gap-2 rounded-md border py-1 pl-2 pr-2.5 transition-colors"
                      :class="
                        classSwitchOpen
                          ? 'border-primary bg-primary-soft/50 ring-2 ring-primary/15'
                          : 'border-hairline bg-canvas hover:border-primary hover:bg-primary-soft/30'
                      "
                      aria-haspopup="listbox"
                      :aria-expanded="classSwitchOpen"
                      @click="toggleClassSwitch"
                    >
                      <span
                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fine font-semibold"
                        :class="classSwitchOpen ? 'bg-primary text-white' : 'bg-primary-soft text-primary'"
                      >
                        {{ name.slice(0, 1) }}
                      </span>
                      <span class="text-airy font-semibold text-ink truncate">{{ name }}</span>
                      <svg
                        class="shrink-0 transition-transform"
                        :class="classSwitchOpen ? 'rotate-180 text-primary' : 'text-faint'"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </h1>
                  <!-- 班级选择器：列出全部班级，当前项主色高亮 + 打勾 -->
                  <div
                    v-if="classSwitchOpen"
                    ref="classSwitchMenu"
                    data-test="class-switch-menu"
                    role="listbox"
                    class="scroll-thin absolute left-0 top-full z-30 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-lg border border-hairline bg-canvas p-1.5 shadow-lg"
                  >
                    <button
                      v-for="c in sortedClasses"
                      :key="c.name"
                      type="button"
                      role="option"
                      data-test="class-switch-option"
                      :aria-current="c.name === name ? 'page' : undefined"
                      :aria-selected="c.name === name"
                      class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors"
                      :class="c.name === name ? 'bg-primary-soft/60' : 'hover:bg-pearl'"
                      @click="switchClass(c.name)"
                    >
                      <span
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-fine font-semibold"
                        :class="c.name === name ? 'bg-primary text-white' : 'bg-pearl text-muted'"
                      >
                        {{ c.name.slice(0, 1) }}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span
                          class="block truncate text-caption"
                          :class="c.name === name ? 'font-semibold text-ink' : 'text-ink'"
                        >
                          {{ c.name }}
                        </span>
                        <span class="block text-fine text-faint">{{ c.studentCount }} 名学生</span>
                      </span>
                      <svg
                        v-if="c.name === name"
                        class="shrink-0 text-primary"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    </button>
                    <p v-if="!sortedClasses.length" class="px-2 py-1.5 text-fine text-faint">
                      暂无班级
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-weak hover:bg-pearl hover:text-ink transition-colors"
                  title="编辑班级（名称 / 年级 / 学期）"
                  @click="renameDialogOpen = true"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  v-if="!readOnly"
                  type="button"
                  data-test="archive-class-btn"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-weak hover:bg-pearl hover:text-ink transition-colors"
                  title="归档班级（移入历史带过的班）"
                  @click="onArchiveClass"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="4" rx="1" />
                    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
                  </svg>
                </button>
                <button
                  v-if="readOnly"
                  type="button"
                  data-test="restore-class-btn"
                  class="flex h-7 items-center justify-center rounded-md px-2 text-caption text-primary hover:bg-pearl transition-colors"
                  title="恢复班级到在用列表"
                  @click="onRestoreClass"
                >
                  恢复班级
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
              <div class="flex items-center gap-2">
                <span
                  v-if="readOnly"
                  class="rounded-pill bg-parchment px-2 py-0.5 text-fine text-weak"
                >
                  已归档 · 只读
                </span>
                <span
                  v-if="currentGradeLabel"
                  data-test="class-grade-badge"
                  class="rounded-pill bg-primary-soft px-2.5 py-0.5 text-fine font-medium text-primary"
                >
                  {{ currentGradeLabel }}
                </span>
              </div>
              <span class="text-caption text-weak">
                {{ summary?.studentCount ?? 0 }} 名学生 ({{ summary?.maleCount ?? 0 }} 男 · {{ summary?.femaleCount ?? 0 }} 女) · 照片 {{ summary?.photoCount ?? 0 }} 张
              </span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <AppButton v-if="!readOnly" variant="primary" @click="openCreateStudentDialog">新建学生</AppButton>
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
            v-if="!readOnly"
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
          :readonly="readOnly"
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
            v-if="!readOnly"
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
          :readonly="readOnly"
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
            <div class="flex items-center gap-2">
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
              <!-- 导入课表紧贴「日历」切换项右侧：导入的是这张课表，入口跟着视图切换走 -->
              <AppButton
                v-if="!readOnly"
                variant="pearl"
                data-test="timetable-import-btn"
                @click="timetableImportOpen = true"
              >
                导入课表
              </AppButton>
            </div>
            <p v-if="timetableView === 'grid'" class="text-fine text-weak">
              换课 / 停课 / 日程在日历视图维护
            </p>
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
              :disabled="markingSaving || readOnly"
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
            :surface-style="timetableBgSurfaceStyle"
            :surface-class="timetableBgSurfaceClass"
            :readonly="readOnly"
            @edit="timetableView = 'grid'"
          />
          <div
            v-else
            class="rounded-lg border border-hairline bg-canvas p-4"
            :class="timetableBgSurfaceClass"
            :style="timetableBgSurfaceStyle"
            data-test="class-timetable-surface"
          >
            <TimetableGrid
              :timetable="timetable"
              :slots="timetable.slots"
              :editable="!readOnly"
              :my-subjects="profile.my_subjects ?? []"
              :class-marked="timetable.my_subjects"
              :conflict-rows="conflictRows"
              :today="TIMETABLE_TODAY"
              @changed="refreshTimetable"
            />
          </div>
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
      :initial-grade="classMeta.entry_grade"
      :initial-semester="classMeta.entry_semester"
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
