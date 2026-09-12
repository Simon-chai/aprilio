<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppIconButton from "../components/ui/AppIconButton.vue";
import AppInput from "../components/ui/AppInput.vue";
import AppLink from "../components/ui/AppLink.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import StudentTable from "../components/StudentTable.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import ImportRosterDialog from "../components/ImportRosterDialog.vue";
import ImportScoreDialog from "../components/ImportScoreDialog.vue";
import ExamScorePanel from "../components/ExamScorePanel.vue";
import ScoreTrendSparkline from "../components/ScoreTrendSparkline.vue";
import ClassFormDialog from "../components/ClassFormDialog.vue";
import type { ClassFormValue } from "../components/ClassFormDialog.vue";
import QuickBehaviorPopover from "../components/QuickBehaviorPopover.vue";
import ClassBehaviorTimeline from "../components/ClassBehaviorTimeline.vue";
import {
  addClassPhoto,
  createStudent,
  deleteBehaviorRecord,
  deleteClass,
  getClassMeta,
  getClassScoreTrend,
  getClassSummary,
  isTauri,
  listBehaviorRecordsByClass,
  listClasses,
  listExamsByClass,
  listPhotosByClass,
  listStudents,
  renameClass,
  archiveClass,
  restoreClass,
} from "../lib/db";
import { getPhotosDir, importPhoto, photoUrl } from "../lib/photos";
import { onPageAction } from "../agent/page-action-bus";
import { clearPageContext, reportPageContext } from "../agent/page-context-bus";
import type { ImportRosterMode } from "../agent/page-actions/classes-import-roster";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { RosterImportResult, RosterTable } from "../lib/roster";
import { averageOfSubjectAverages, formatNumber } from "../lib/score-analysis";
import type {
  BehaviorPolarity,
  ClassBehaviorRecord,
  ClassExamTrendPoint,
  ClassMeta,
  ClassSummary,
  Photo,
  StudentInput,
  StudentRow,
} from "../types";

const props = defineProps<{ name: string }>();
const router = useRouter();

const summary = ref<ClassSummary | null>(null);
/** 班级元信息：归档状态 */
const classMeta = ref<ClassMeta>({ archived_at: null });
/** 归档班级为只读态：隐藏全部写入口 */
const readOnly = computed(() => Boolean(classMeta.value.archived_at));
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
type ClassTab = "students" | "photos" | "behaviors" | "scores";
const activeTab = ref<ClassTab>("students");
const photoFilter = ref<"all" | "public" | "student">("all");
const examCount = ref(0);
/** 各次考试的班级统计快照（成绩概览卡的趋势折线用，按考试时间正序） */
const scoreTrend = ref<ClassExamTrendPoint[]>([]);

/** 页签的中文对照：页面上下文摘要里给 Agent 看当前停在哪一块 */
const TAB_LABELS: Record<ClassTab, string> = {
  students: "学生名单",
  photos: "照片",
  behaviors: "日常表现",
  scores: "考试成绩",
};

/** Agent 页面上下文：告诉助手「当前在看哪个班、页面上有什么」，数据与页面同源 */
function reportContext(): void {
  const parts = [classMeta.value.archived_at ? "已归档（只读）" : "在用班级"];
  if (summary.value) parts.push(`学生 ${summary.value.studentCount} 人`);
  parts.push(
    `考试成绩 ${examCount.value} 场`,
    `表现记录 ${behaviorRecords.value.length} 条`,
    `当前页签：${TAB_LABELS[activeTab.value]}`,
  );
  reportPageContext({
    page: "class-detail",
    title: `班级详情 · ${props.name}`,
    params: { name: props.name },
    summary: parts.join(" · "),
  });
}

/** 点击概览卡跳转到对应 Tab */
function goTab(tab: ClassTab): void {
  activeTab.value = tab;
}

/** 概览卡统一样式：整卡是一个跳转按钮（hover / focus 高亮边框，右侧箭头呼应） */
const metricCardClass =
  "group flex h-full flex-col rounded-lg border border-hairline bg-canvas p-6 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15";

const importOpen = ref(false);
const importMode = ref<ImportRosterMode>("smart");
const createDialogOpen = ref(false);
/** 新建学生对话框预填：默认带上本班，Agent 动作可追加字段 */
const createInitial = ref<Partial<StudentInput>>({ grade_class: props.name });
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
  const [sum, studentList, photoList, allStudents, pDir, classList, bList, examList, meta, trend] =
    await Promise.all([
      getClassSummary(props.name),
      listStudents(keyword.value, props.name),
      listPhotosByClass(props.name, photoFilter.value),
      listStudents(),
      getPhotosDir(),
      listClasses(),
      listBehaviorRecordsByClass(props.name),
      listExamsByClass(props.name),
      getClassMeta(props.name),
      getClassScoreTrend(props.name),
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
  scoreTrend.value = trend;
  classMeta.value = meta;
  reportContext();
}

/** 成绩数据在成绩 Tab 内被改动后，只重拉概览卡需要的两项，不整页刷新 */
async function refreshScoreOverview() {
  const [examList, trend] = await Promise.all([
    listExamsByClass(props.name),
    getClassScoreTrend(props.name),
  ]);
  examCount.value = examList.length;
  scoreTrend.value = trend;
  reportContext();
}

/**
 * 成绩概览卡的折线数据：每次考试一个点，取班级平均单科分。
 * 该口径把该班所有考试、所有科目的每一条成绩都算进来（总分随科目数变化不可比，
 * 单科均分恒为 0~100）；某次考试没有任何数字分（全等级制）时该点断开。
 */
const scoreTrendPoints = computed(() =>
  scoreTrend.value.map((point) => ({
    label: point.exam.name,
    value: point.stats.subjects.length ? averageOfSubjectAverages(point.stats) : null,
  }))
);

/** 最近一次有数字分的考试均分（卡片副标题展示） */
const latestScoreAverage = computed<number | null>(() => {
  for (let i = scoreTrendPoints.value.length - 1; i >= 0; i--) {
    const value = scoreTrendPoints.value[i]?.value;
    if (value !== null && value !== undefined) return value;
  }
  return null;
});

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
  reportContext();
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
  try {
    await renameClass(props.name, newName);
  } catch (e) {
    // 失败保持弹窗打开，错误上浮到 toast——不再静默只进日志
    showToast(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  renameDialogOpen.value = false;
  router.replace({ name: "class-detail", params: { name: newName } });
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
  void refresh();
});

// 页签切换即上报：Agent 的页面上下文要跟住「用户现在停在哪一块」
watch(activeTab, () => reportContext());

// Agent 的 ui_action 广播：班级维度动作在本页接住（复用对话框；归档班级只读时不放行写入口）
const offCreateStudentAction = onPageAction<Partial<StudentInput>>(
  "classes/create-student",
  (preset) => {
    if (readOnly.value) {
      showToast("该班级已归档，只读");
      return;
    }
    openCreateStudentDialog(preset);
  },
);

const offImportRosterAction = onPageAction<ImportRosterMode>("classes/import-roster", (mode) => {
  if (readOnly.value) {
    showToast("该班级已归档，只读");
    return;
  }
  openImportDialog(mode ?? "smart");
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
  offCreateStudentAction();
  offImportRosterAction();
  clearPageContext("class-detail");
});

function openImportDialog(mode: ImportRosterMode = "smart") {
  importMode.value = mode;
  importOpen.value = true;
}

function openCreateStudentDialog(preset?: Partial<StudentInput> | null) {
  createInitial.value = { grade_class: props.name, ...(preset ?? {}) };
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
                  title="修改班级名称"
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
              </div>
              <span class="text-caption text-weak">
                {{ summary?.studentCount ?? 0 }} 名学生 ({{ summary?.maleCount ?? 0 }} 男 · {{ summary?.femaleCount ?? 0 }} 女) · 照片 {{ summary?.photoCount ?? 0 }} 张
              </span>
            </div>
          </div>
        </div>

      </div>
    </header>

    <!-- 主体区域 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6 space-y-6">
      <!-- 概览指标卡片：整卡即跳转按钮，点击切到对应 Tab（右侧箭头提示可前往） -->
      <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          data-test="metric-card-students"
          :class="metricCardClass"
          @click="goTab('students')"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-caption text-weak">本班学生</span>
            <span
              data-test="metric-card-arrow"
              class="shrink-0 text-faint transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.studentCount ?? 0 }} 人
          </div>
          <div class="mt-auto pt-1 text-fine text-muted">
            男 {{ summary?.maleCount ?? 0 }} · 女 {{ summary?.femaleCount ?? 0 }}
          </div>
        </button>

        <button
          type="button"
          data-test="metric-card-photos"
          :class="metricCardClass"
          @click="goTab('photos')"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-caption text-weak">班级照片</span>
            <span
              data-test="metric-card-arrow"
              class="shrink-0 text-faint transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.photoCount ?? 0 }} 张
          </div>
          <div class="mt-auto pt-1 text-fine text-muted">
            公共 {{ summary?.classPhotoCount ?? 0 }} · 个人 {{ summary?.studentPhotoCount ?? 0 }}
          </div>
        </button>

        <button
          type="button"
          data-test="metric-card-behaviors"
          :class="metricCardClass"
          @click="goTab('behaviors')"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-caption text-weak">档案动态</span>
            <span
              data-test="metric-card-arrow"
              class="shrink-0 text-faint transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ students.length }} 名有效学生
          </div>
          <div class="mt-auto pt-1 text-fine text-muted">
            已归档 · {{ behaviorRecords.length }} 条表现记录
          </div>
        </button>

        <!-- 成绩卡：迷你趋势折线（每次考试一个点，全部成绩参与计算） -->
        <button
          type="button"
          data-test="metric-card-scores"
          :class="metricCardClass"
          @click="goTab('scores')"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-caption text-weak">考试成绩</span>
            <span
              data-test="metric-card-arrow"
              class="shrink-0 text-faint transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </div>
          <div class="mt-2 min-h-14">
            <ScoreTrendSparkline
              v-if="scoreTrendPoints.length"
              :points="scoreTrendPoints"
              :height="56"
            />
            <p
              v-else
              class="flex h-14 items-center justify-center rounded-sm bg-parchment text-fine text-faint"
            >
              暂无成绩
            </p>
          </div>
          <div class="mt-auto pt-1 text-fine text-muted">
            <template v-if="scoreTrendPoints.length">
              共 {{ examCount }} 次考试<template v-if="latestScoreAverage !== null"> · 最近均分 {{ formatNumber(latestScoreAverage) }}</template>
            </template>
            <template v-else>导入成绩后自动生成趋势</template>
          </div>
        </button>
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
      </div>

      <!-- Tab 1: 学生条目 -->
      <div v-if="activeTab === 'students'" class="space-y-4">
        <!-- 搜索栏右侧并列两个写入口：导入本班花名册（本班导入，区别于班级管理页「导入时自动建班」）/ 新建学生（预填本班） -->
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
            class="bg-gradient-to-b from-white to-mint hover:from-mint"
            @click="openImportDialog"
          >
            <!-- 与班级管理页同款花名册图标：2×3 格表格 + 右上角加号 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2.8" y="11.4" width="17.6" height="9.6" rx="2.4" />
              <path d="M2.8 16.2h17.6M8.67 11.4V21M14.53 11.4V21" />
              <path d="M19.2 3v5.4M16.5 5.7h5.4" />
            </svg>
          </AppIconButton>
          <AppIconButton
            v-if="!readOnly"
            label="新建学生"
            data-test="create-student-btn"
            class="bg-gradient-to-b from-white to-mint hover:from-mint"
            @click="openCreateStudentDialog()"
          >
            <!-- 与班级管理页同款图标：加号 + 学生小人 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="9.2" cy="7.4" r="3.6" />
              <path d="M3 20.6a6.2 6.2 0 0 1 12.4 0" />
              <path d="M18.6 8.4v6.2M15.5 11.5h6.2" />
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
          description="点击搜索栏右侧的「导入本班花名册」批量建档，或「新建学生」手动添加"
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
        <!-- 面板内改分 / 删考试后回传，保证上方概览卡的计数与趋势图不落后 -->
        <ExamScorePanel :class-name="name" @changed="refreshScoreOverview" />
      </div>

    </div>

    <!-- 对话框 -->
    <ImportRosterDialog
      :open="importOpen"
      :initial-mode="importMode"
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
      :initial="createInitial"
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
