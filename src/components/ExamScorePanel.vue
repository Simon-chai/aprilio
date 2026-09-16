<script setup lang="ts">
/**
 * 班级考试成绩面板：班级详情页「考试成绩」Tab 的主体。
 *
 * 两种视角：
 * - 按考试：批次列表（考试名 + 时间 + 科目/学生数）→ 选中考试的明细表
 *   （学生 × 科目 + 总分），支持编辑批次信息、删除批次；
 * - 按学生总览：学生 × 各次考试总分的矩阵，一人一行看每次成绩。
 *
 * 「导入成绩」对话框在本组件内打开，导入完成自动刷新。
 */
import { computed, onMounted, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppDialog from "./ui/AppDialog.vue";
import AppIconButton from "./ui/AppIconButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import ImportScoreDialog from "./ImportScoreDialog.vue";
import SubjectScoreBars from "./SubjectScoreBars.vue";
import { confirmAction } from "../composables/useConfirm";
import {
  deleteExam,
  deleteExamScore,
  getClassScoreOverview,
  getClassScoreTrend,
  getExamScores,
  listExamsByClass,
  updateExam,
  upsertExamScore,
} from "../lib/db";
import { parseScoreCell } from "../lib/scores";
import {
  SCORE_LEVEL_BAR,
  SCORE_LEVEL_TEXT,
  averageOfSubjectAverages,
  computeExamStats,
  formatNumber,
  formatRate,
  rankByTotal,
  round1,
  scoreRatio,
} from "../lib/score-analysis";
import {
  levelNameOfScore,
  levelOf,
  levelValueOf,
  resetScoreLevelConfig,
  saveScoreLevelConfig,
  scoreLevelConfig,
  scoreLines,
  showLevelOnly,
} from "../lib/score-config";
import type {
  ClassExamTrendPoint,
  ClassScoreOverviewRow,
  ExamScoreRow,
  ExamStatSummary,
  ExamType,
  ExamWithStats,
  ScoreLevelBand,
} from "../types";

const props = defineProps<{ className: string }>();

/** 成绩数据发生变更（导入 / 改分 / 删考试）时回传，外层概览卡据此刷新 */
const emit = defineEmits<{ changed: [] }>();

const exams = ref<ExamWithStats[]>([]);
const selectedExamId = ref<number | null>(null);
const scores = ref<ExamScoreRow[]>([]);
const overview = ref<{ exams: ExamWithStats[]; rows: ClassScoreOverviewRow[] }>({
  exams: [],
  rows: [],
});
const trend = ref<ClassExamTrendPoint[]>([]);
const view = ref<"exams" | "overview" | "trend">("exams");
const importOpen = ref(false);
const editOpen = ref(false);
const editName = ref("");
const editDate = ref("");
const editType = ref<ExamType>("minor");
const levelOpen = ref(false);
const levelDraft = ref<ScoreLevelBand[]>([]);
const loading = ref(false);

/** 改分纠错：单科成绩修正 */
const correctOpen = ref(false);
const correctSaving = ref(false);
const correctValue = ref("");
const correctError = ref("");
const correctTarget = ref<{
  examId: number;
  studentId: number;
  studentName: string;
  subject: string;
  current: string;
} | null>(null);

/** 大考 / 小考分组展开状态（默认只展开当前选中考试所在组） */
const expandedTypes = ref<Record<ExamType, boolean>>({ major: true, minor: true });

function toggleType(type: ExamType) {
  expandedTypes.value[type] = !expandedTypes.value[type];
}

/** notify=true 表示这次刷新源于用户改动成绩数据，完成后回传外层刷新概览卡 */
async function refresh(notify = false) {
  loading.value = true;
  hoverStudentId.value = null;
  hoverAnchor.value = null;
  try {
    const [list, ov, tr] = await Promise.all([
      listExamsByClass(props.className),
      getClassScoreOverview(props.className),
      getClassScoreTrend(props.className),
    ]);
    exams.value = list;
    overview.value = ov;
    trend.value = tr;
    // 选中批次被删/不存在时回落到第一场
    if (selectedExamId.value === null || !list.some((e) => e.id === selectedExamId.value)) {
      selectedExamId.value = list[0]?.id ?? null;
    }
    // 只展开当前选中考试所在组，另一组折叠（标题多时更清爽）
    const selectedType = list.find((e) => e.id === selectedExamId.value)?.exam_type;
    if (selectedType) {
      expandedTypes.value = { major: selectedType === "major", minor: selectedType === "minor" };
    }
    scores.value = selectedExamId.value ? await getExamScores(selectedExamId.value) : [];
  } finally {
    loading.value = false;
  }
  if (notify) emit("changed");
}

watch(
  () => props.className,
  () => {
    selectedExamId.value = null;
    void refresh();
  }
);

watch(selectedExamId, async (id) => {
  hoverStudentId.value = null;
  hoverAnchor.value = null;
  scores.value = id ? await getExamScores(id) : [];
});

onMounted(() => void refresh());

/* ---------------- 考试明细：学生 × 科目矩阵 ---------------- */

/** 科目列（按成绩首次出现顺序） */
const subjects = computed(() => {
  const seen: string[] = [];
  for (const s of scores.value) {
    if (!seen.includes(s.subject)) seen.push(s.subject);
  }
  return seen;
});

/** 明细行：每名学生一行，subject → 成绩单元格 */
const detailRows = computed(() => {
  const byStudent = new Map<
    number,
    { id: number; name: string; student_no: string | null; cells: Map<string, ExamScoreRow> }
  >();
  for (const s of scores.value) {
    let row = byStudent.get(s.student_id);
    if (!row) {
      row = { id: s.student_id, name: s.student_name, student_no: s.student_no, cells: new Map() };
      byStudent.set(s.student_id, row);
    }
    row.cells.set(s.subject, s);
  }
  return [...byStudent.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

function cellText(cell: ExamScoreRow | undefined): string {
  if (!cell) return "—";
  if (cell.score !== null) {
    return showLevelOnly.value ? levelNameOfScore(cell.score) : String(cell.score);
  }
  return cell.grade ?? "—";
}

function totalOf(row: { cells: Map<string, ExamScoreRow> }): { score: number | null; grade: string | null } {
  let total = 0;
  let hasNumeric = false;
  const grades: string[] = [];
  for (const cell of row.cells.values()) {
    if (cell.score !== null) {
      total += cell.score;
      hasNumeric = true;
    } else if (cell.grade) {
      grades.push(cell.grade);
    }
  }
  return hasNumeric ? { score: total, grade: null } : { score: null, grade: grades.join("、") || null };
}

/** 大考 / 小考分组（空组不渲染） */
const groupedExams = computed(() => {
  const groups: { type: ExamType; label: string; exams: ExamWithStats[] }[] = [
    { type: "major", label: "大考", exams: [] },
    { type: "minor", label: "小考", exams: [] },
  ];
  for (const exam of exams.value) {
    (exam.exam_type === "major" ? groups[0] : groups[1]).exams.push(exam);
  }
  return groups.filter((g) => g.exams.length);
});

/** 选中考试的班级统计（平均/最高/最低/及格率/优秀率 + 各科统计） */
const examStats = computed(() => computeExamStats(scores.value, scoreLines()));

/** 明细表总分排名（并列同名次） */
const totalRanks = computed(() => {
  const totals = new Map<number, { score: number | null }>();
  for (const row of detailRows.value) totals.set(row.id, { score: totalOf(row).score });
  return rankByTotal(totals);
});

/* ---------------- 视觉辅助：档位配色与进度条 ---------------- */

function levelText(score: number | null | undefined): string {
  const level = levelOf(score);
  return level ? SCORE_LEVEL_TEXT[level] : "";
}

function barClass(score: number | null | undefined): string {
  const level = levelOf(score);
  return level ? SCORE_LEVEL_BAR[level] : "bg-faint";
}

/** 分数对应的等级名（按成绩页「等级映射」配置派生） */
function levelName(score: number | null | undefined): string {
  return levelNameOfScore(score);
}

/** 等级模式下把分数折到档位代表值（同等级同宽/同高）；否则原值透传 */
function plotValue(score: number | null | undefined): number | null | undefined {
  return showLevelOnly.value ? levelValueOf(score) : score;
}

/** 总分按科目数折成单科口径再判档（与总览矩阵同一折算口径） */
function totalLevelName(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  return levelNameOfScore(score / Math.max(1, subjects.value.length));
}

/** 明细表总分列文本：等级模式显示等级名，不显示具体分数 */
function totalDisplayText(score: number | null): string {
  if (score === null) return "";
  return showLevelOnly.value ? totalLevelName(score) : formatNumber(score);
}

/** 班级统计条的总分口径：按科目数折成单科口径再判等级 */
function totalStatLevel(value: number): string {
  return levelNameOfScore(value / Math.max(1, examStats.value.subjects.length));
}

/** 科目统计单元格：各科均分 / 极值本身是 0~100 口径，直接判档 */
function subjectStatText(value: number): string {
  return showLevelOnly.value ? levelNameOfScore(value) : formatNumber(value);
}

/** 总览矩阵是总分口径，先按科目数折成 0~100 再判档，避免总分恒为「优秀」 */
function overviewLevelText(score: number | null | undefined, examId: number): string {
  if (score === null || score === undefined) return "";
  const count = overview.value.exams.find((e) => e.id === examId)?.subject_count ?? 1;
  return levelText(score / Math.max(1, count));
}

/** 总览矩阵单元格文本：等级模式显示等级名，否则显示具体总分 */
function overviewCellText(score: number | null | undefined, examId: number): string {
  if (score === null || score === undefined) return "";
  if (!showLevelOnly.value) return String(score);
  const count = overview.value.exams.find((e) => e.id === examId)?.subject_count ?? 1;
  return levelNameOfScore(score / Math.max(1, count));
}

/** 总览矩阵「班级平均」行文本：等级模式按该场科目数折算判档 */
function overviewAvgText(examId: number): string {
  const stats = overviewStats.value.get(examId);
  if (!stats?.count) return "—";
  if (!showLevelOnly.value) return formatNumber(stats.average);
  const count = overview.value.exams.find((e) => e.id === examId)?.subject_count ?? 1;
  return levelNameOfScore(stats.average / Math.max(1, count));
}

function barWidth(score: number | null | undefined): string {
  return `${Math.round(scoreRatio(score) * 100)}%`;
}

/** 迷你进度条宽度：等级模式按档位代表值（同等级等宽） */
function barWidthFor(score: number | null | undefined): string {
  return barWidth(plotValue(score));
}

/** 总分进度条宽度：先按科目数折算成单科口径再判档 */
function totalBarWidth(score: number | null): string {
  if (score === null) return "0%";
  return barWidthFor(score / Math.max(1, subjects.value.length));
}

/* ---------------- 按学生总览：每次考试的班级均值 ---------------- */

const overviewStats = computed(() => {
  const map = new Map<number, { average: number; count: number }>();
  for (const exam of overview.value.exams) {
    const values = overview.value.rows
      .map((r) => r.cells[exam.id]?.score)
      .filter((v): v is number => v !== null && v !== undefined);
    map.set(exam.id, {
      average: values.length ? round1(values.reduce((a, b) => a + b, 0) / values.length) : 0,
      count: values.length,
    });
  }
  return map;
});

const selectedExam = computed(() => exams.value.find((e) => e.id === selectedExamId.value) ?? null);

/* ---------------- 悬浮学生行：各科柱状图卡片（复用学生面板的柱状图组件） ---------------- */

/** 当前悬浮的学生行 id（null = 不展示卡片） */
const hoverStudentId = ref<number | null>(null);
/** 卡片的 fixed 定位锚点（跟随鼠标；贴边时翻到另一侧） */
const hoverAnchor = ref<{ left: number; top: number } | null>(null);

/** 卡片尺寸估算（视口边界翻转用，与卡片实际宽度一致） */
const HOVER_CARD_W = 264;
const HOVER_CARD_H = 200;

const hoverRow = computed(
  () => detailRows.value.find((r) => r.id === hoverStudentId.value) ?? null
);

/** 跟随鼠标：默认落在光标右下方，贴近视口右/下边缘时翻到左上方 */
function placeCard(clientX: number, clientY: number) {
  const x = Number.isFinite(clientX) ? clientX : 0;
  const y = Number.isFinite(clientY) ? clientY : 0;
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  const gap = 16;
  hoverAnchor.value = {
    left: x + gap + HOVER_CARD_W > vw - 8 ? Math.max(8, x - gap - HOVER_CARD_W) : x + gap,
    top: y + gap + HOVER_CARD_H > vh - 8 ? Math.max(8, y - gap - HOVER_CARD_H) : y + gap,
  };
}

function onRowEnter(row: { id: number }, event: MouseEvent) {
  hoverStudentId.value = row.id;
  placeCard(event.clientX, event.clientY);
}

/** 悬浮中随鼠标移动（卡片 pointer-events-none，不打断行命中） */
function onRowMove(event: MouseEvent) {
  if (!hoverStudentId.value) return;
  placeCard(event.clientX, event.clientY);
}

function onRowLeave() {
  hoverStudentId.value = null;
  hoverAnchor.value = null;
}

/** 卡片里的柱状图分组：本场考试 + 该生各科（按明细列顺序，缺考不画柱） */
const hoverBarGroups = computed(() => {
  const row = hoverRow.value;
  const exam = selectedExam.value;
  if (!row || !exam) return [];
  return [
    {
      label: exam.name,
      sub: fmtDate(exam.exam_date).slice(5),
      items: subjects.value.map((subject) => {
        const cell = row.cells.get(subject);
        return { subject, score: cell?.score ?? null, grade: cell?.grade ?? null };
      }),
    },
  ];
});

/** 卡片右上角的总分（等级模式显示等级文本） */
const hoverTotalText = computed(() => {
  if (!hoverRow.value) return "";
  const total = totalOf(hoverRow.value);
  if (total.score !== null) {
    return showLevelOnly.value
      ? `总分 ${totalLevelName(total.score)}`
      : `总分 ${formatNumber(total.score)}`;
  }
  return total.grade ? `等级 ${total.grade}` : "";
});

/* ---------------- 成绩趋势：各次考试的班级均分与各科走势 ---------------- */

/** 班级平均单科分（0~100，跨考试可比——不受科目数变化影响） */
function classAvgOf(stats: ExamStatSummary): number {
  return averageOfSubjectAverages(stats);
}

/** 班级平均单科分文本：等级模式显示等级名 */
function classAvgText(stats: ExamStatSummary): string {
  const avg = classAvgOf(stats);
  return showLevelOnly.value ? levelNameOfScore(avg) : formatNumber(avg);
}

/** 趋势柱高取值：等级模式按档位代表值（同等级等高） */
function classAvgPlot(stats: ExamStatSummary): number | null {
  const avg = classAvgOf(stats);
  return showLevelOnly.value ? levelValueOf(avg) : avg;
}

/** 趋势矩阵科目：各次考试出现过的科目并集（按首次出现顺序） */
const trendSubjects = computed(() => {
  const seen: string[] = [];
  for (const point of trend.value) {
    for (const stat of point.stats.subjects) {
      if (!seen.includes(stat.subject)) seen.push(stat.subject);
    }
  }
  return seen;
});

function subjectAvgOf(stats: ExamStatSummary, subject: string): number | null {
  const found = stats.subjects.find((s) => s.subject === subject);
  return found ? found.average : null;
}

/** 各科平均分趋势矩阵单元格：等级模式显示等级名 */
function subjectAvgText(stats: ExamStatSummary, subject: string): string {
  const value = subjectAvgOf(stats, subject);
  if (value === null) return "—";
  return showLevelOnly.value ? levelNameOfScore(value) : formatNumber(value);
}

function trendBarHeight(score: number | null): string {
  return `${Math.round(Math.max(6, scoreRatio(score) * 120))}px`;
}

/* ---------------- 批次编辑 / 删除 ---------------- */

function openEditExam() {
  if (!selectedExam.value) return;
  editName.value = selectedExam.value.name;
  editDate.value = selectedExam.value.exam_date;
  editType.value = selectedExam.value.exam_type;
  editOpen.value = true;
}

async function saveExamEdit() {
  if (!selectedExam.value) return;
  const name = editName.value.trim();
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(editDate.value)) return;
  await updateExam(selectedExam.value.id, {
    name,
    exam_date: editDate.value,
    exam_type: editType.value,
  });
  editOpen.value = false;
  await refresh(true);
}

/* ---------------- 改分纠错 ---------------- */

function openCorrect(row: { id: number; name: string }, subject: string) {
  if (!selectedExamId.value) return;
  const cell = detailRows.value.find((r) => r.id === row.id)?.cells.get(subject);
  correctTarget.value = {
    examId: selectedExamId.value,
    studentId: row.id,
    studentName: row.name,
    subject,
    current: cellText(cell),
  };
  correctValue.value =
    cell?.score !== null && cell?.score !== undefined ? String(cell.score) : (cell?.grade ?? "");
  correctError.value = "";
  correctOpen.value = true;
}

/** 保存修正：接受数字分（如 87.5）或文字（缺考/免考），与导入同一套单元格解析 */
async function saveCorrect() {
  const target = correctTarget.value;
  if (!target) return;
  const parsed = parseScoreCell(correctValue.value);
  if (parsed.score === null && parsed.grade === null) {
    correctError.value = "请填写分数，或「缺考」等文字。";
    return;
  }
  correctSaving.value = true;
  try {
    await upsertExamScore(
      target.examId,
      target.studentId,
      target.subject,
      parsed.score,
      parsed.grade
    );
    correctOpen.value = false;
    await refresh(true);
  } catch (e) {
    correctError.value = e instanceof Error ? e.message : String(e);
  } finally {
    correctSaving.value = false;
  }
}

/** 清空该科成绩（录错整条时用） */
async function clearCorrect() {
  const target = correctTarget.value;
  if (!target) return;
  correctSaving.value = true;
  try {
    await deleteExamScore(target.examId, target.studentId, target.subject);
    correctOpen.value = false;
    await refresh(true);
  } finally {
    correctSaving.value = false;
  }
}

/* ---------------- 等级映射配置 ---------------- */

/** 「显示等级」开关草稿：随弹窗打开时同步当前配置，点保存后生效 */
const draftShowLevel = ref(false);

function openLevelConfig() {
  levelDraft.value = scoreLevelConfig.value.bands.map((b) => ({ ...b }));
  draftShowLevel.value = scoreLevelConfig.value.showLevelOnly === true;
  levelOpen.value = true;
}

function saveLevelConfig() {
  saveScoreLevelConfig({ bands: levelDraft.value, showLevelOnly: draftShowLevel.value });
  levelOpen.value = false;
}

function resetLevelConfig() {
  resetScoreLevelConfig();
  levelDraft.value = scoreLevelConfig.value.bands.map((b) => ({ ...b }));
}

async function onDeleteExam() {
  const exam = selectedExam.value;
  if (!exam) return;
  const ok = await confirmAction({
    title: "删除考试",
    message: `删除考试「${exam.name}」（${exam.exam_date}）？该批次的所有成绩将一并删除，且不可恢复。`,
    tone: "danger",
    confirmText: "删除",
  });
  if (!ok) return;
  await deleteExam(exam.id);
  selectedExamId.value = null;
  await refresh(true);
}

function fmtDate(d: string): string {
  return d?.slice(0, 10) ?? "";
}
</script>

<template>
  <div class="space-y-4" data-test="exam-score-panel">
    <!-- 工具行：视角切换 → 「导入成绩」紧挨其右 → 说明文字；「等级映射」单独右对齐 -->
    <div class="scrollbar-none flex items-center gap-3 overflow-x-auto" data-test="score-toolbar">
      <div class="flex shrink-0 flex-wrap items-center gap-2" data-test="score-toolbar-actions">
        <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
          <button
            type="button"
            data-test="view-exams-btn"
            class="whitespace-nowrap rounded-[6px] px-3 py-1.5 text-caption transition-[color,box-shadow]"
            :class="view === 'exams' ? 'grad-border-soft font-medium text-primary' : 'text-weak hover:text-ink'"
            @click="view = 'exams'"
          >
            按考试
          </button>
          <button
            type="button"
            data-test="view-overview-btn"
            class="whitespace-nowrap rounded-[6px] px-3 py-1.5 text-caption transition-[color,box-shadow]"
            :class="view === 'overview' ? 'grad-border-soft font-medium text-primary' : 'text-weak hover:text-ink'"
            @click="view = 'overview'"
          >
            按学生总览
          </button>
          <button
            type="button"
            data-test="view-trend-btn"
            class="whitespace-nowrap rounded-[6px] px-3 py-1.5 text-caption transition-[color,box-shadow]"
            :class="view === 'trend' ? 'grad-border-soft font-medium text-primary' : 'text-weak hover:text-ink'"
            @click="view = 'trend'"
          >
            成绩趋势
          </button>
        </div>

        <AppIconButton
          label="导入成绩"
          data-test="import-score-btn"
          @click="importOpen = true"
        >
          <!-- 语义图标：文件上有对勾勾线，表示成绩单批量导入 -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M9 15l2 2 4-4" />
          </svg>
        </AppIconButton>
      </div>

      <span class="shrink-0 whitespace-nowrap text-fine text-weak">
        {{
          view === "exams"
            ? "每次考试一份成绩单批次 · 点击分数可改分纠错"
            : view === "overview"
              ? "每个学生每次考试的总分"
              : "各次考试的班级均分与各科走势"
        }}
      </span>

      <!-- 等级映射为低频配置项：仅它右对齐到工具行最右，不混进视角 / 导入操作组 -->
      <button
        type="button"
        data-test="level-config-btn"
        class="ml-auto shrink-0 whitespace-nowrap grad-border rounded-md px-3 py-1.5 text-caption text-primary transition-[box-shadow] hover:shadow-[var(--shadow-halo)]"
        @click="openLevelConfig"
      >
        等级映射
      </button>
    </div>

    <p v-if="loading" class="text-caption text-weak">加载中…</p>

    <!-- 空状态 -->
    <EmptyState
      v-if="!loading && !exams.length"
      title="暂无考试成绩"
      description="点击「按学生总览」右侧的「导入成绩」图标，把一份成绩单导入为一次考试（可指定考试名与考试时间）"
    />

    <!-- 视角 1：按考试 -->
    <template v-else-if="view === 'exams'">
      <!-- 批次：按大考 / 小考分组，可折叠，避免标题铺满一屏 -->
      <div class="space-y-2" data-test="exam-groups">
        <div v-for="group in groupedExams" :key="group.type" class="rounded-lg border border-hairline bg-canvas">
          <button
            type="button"
            :data-test="`exam-group-${group.type}`"
            class="flex w-full items-center gap-2 px-3 py-2 text-left"
            @click="toggleType(group.type)"
          >
            <span
              class="text-fine text-weak transition-transform"
              :class="expandedTypes[group.type] ? 'rotate-90' : ''"
              aria-hidden="true"
            >
              ▶
            </span>
            <span class="text-caption font-medium text-ink">{{ group.label }}</span>
            <span class="text-fine text-weak">{{ group.exams.length }} 次</span>
            <span
              v-if="!expandedTypes[group.type] && group.exams.some((e) => e.id === selectedExamId)"
              class="rounded-pill bg-primary-soft px-2 py-0.5 text-fine"
              :class="levelText(null)"
            >
              当前：{{ selectedExam?.name }}
            </span>
          </button>

          <div v-if="expandedTypes[group.type]" class="scrollbar-none flex items-center gap-2 overflow-x-auto border-t border-hairline px-3 py-2.5">
            <button
              v-for="exam in group.exams"
              :key="exam.id"
              type="button"
              :data-test="`exam-chip-${exam.id}`"
              class="whitespace-nowrap rounded-pill px-3 py-1.5 text-caption transition-colors"
              :class="
                exam.id === selectedExamId
                  ? 'grad-border-soft text-primary font-medium'
                  : 'bg-canvas border border-hairline text-weak hover:text-ink hover:border-ink'
              "
              @click="selectedExamId = exam.id"
            >
              {{ exam.name }}
              <span class="opacity-70">· {{ fmtDate(exam.exam_date) }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 班级统计：先看整体（均分/极值/及格率/优秀率），再看明细 -->
      <div v-if="selectedExam" class="space-y-3" data-test="exam-insight">
        <div
          class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-3 lg:grid-cols-6"
          data-test="exam-stat-strip"
        >
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">{{ showLevelOnly ? "平均等级" : "平均分" }}</p>
            <p class="mt-1 text-stat font-semibold text-ink" data-test="stat-average">
              {{ showLevelOnly ? totalStatLevel(examStats.total_average) : formatNumber(examStats.total_average) }}
            </p>
          </div>
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">{{ showLevelOnly ? "最高等级" : "最高分" }}</p>
            <p class="mt-1 text-stat font-semibold text-primary">
              {{ showLevelOnly ? totalStatLevel(examStats.total_max) : formatNumber(examStats.total_max) }}
            </p>
          </div>
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">{{ showLevelOnly ? "最低等级" : "最低分" }}</p>
            <p class="mt-1 text-stat font-semibold text-ink">
              {{ showLevelOnly ? totalStatLevel(examStats.total_min) : formatNumber(examStats.total_min) }}
            </p>
          </div>
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">及格率</p>
            <p class="mt-1 text-stat font-semibold text-ink">{{ formatRate(examStats.total_pass_rate) }}</p>
          </div>
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">优秀率</p>
            <p class="mt-1 text-stat font-semibold text-ink">
              {{ formatRate(examStats.total_excellent_rate) }}
            </p>
          </div>
          <div class="bg-canvas px-4 py-3">
            <p class="text-fine text-weak">参考人数</p>
            <p class="mt-1 text-stat font-semibold text-ink">{{ examStats.student_count }}</p>
          </div>
        </div>

        <div
          v-if="examStats.subjects.length"
          class="rounded-lg border border-hairline bg-canvas"
        >
          <div class="flex items-center justify-between border-b border-hairline px-4 py-2.5">
            <p class="text-caption font-medium text-ink">科目统计</p>
            <p class="text-fine text-weak">单科满分按 100 计</p>
          </div>
          <!-- 与其他成绩表一致：列保持单行，窄容器横向滚动，不裁列 -->
          <div class="scroll-thin overflow-x-auto">
            <table class="w-full text-caption" data-test="subject-stat-table">
            <thead>
              <tr class="bg-pearl text-left">
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">科目</th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">
                  {{ showLevelOnly ? "平均等级" : "平均分" }}
                </th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">
                  {{ showLevelOnly ? "最高等级" : "最高" }}
                </th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">
                  {{ showLevelOnly ? "最低等级" : "最低" }}
                </th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">及格率</th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">优秀率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="stat in examStats.subjects" :key="stat.subject" class="border-t border-hairline">
                <td class="whitespace-nowrap px-4 py-2 text-ink">{{ stat.subject }}</td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span class="font-medium" :class="levelText(stat.average)">
                    {{ subjectStatText(stat.average) }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-muted">{{ subjectStatText(stat.max) }}</td>
                <td class="whitespace-nowrap px-4 py-2 text-muted">{{ subjectStatText(stat.min) }}</td>
                <td class="whitespace-nowrap px-4 py-2 text-muted">{{ formatRate(stat.passRate) }}</td>
                <td class="whitespace-nowrap px-4 py-2 text-muted">{{ formatRate(stat.excellentRate) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>

      <!-- 选中批次明细 -->
      <div v-if="selectedExam" class="rounded-lg border border-hairline bg-canvas">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
          <div class="min-w-0">
            <p class="text-body font-semibold text-ink">
              {{ selectedExam.name }}
              <span class="ml-2 text-caption font-normal text-weak">{{ fmtDate(selectedExam.exam_date) }}</span>
            </p>
            <p class="mt-0.5 text-fine text-weak">
              科目 {{ selectedExam.subject_count }} 个 · 成绩 {{ selectedExam.score_count }} 条 ·
              学生 {{ selectedExam.student_count }} 人 · 悬浮学生行看各科柱状图
            </p>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              data-test="edit-exam-btn"
              class="rounded-md px-2 py-1 text-fine text-weak hover:bg-pearl hover:text-ink transition-colors"
              @click="openEditExam"
            >
              编辑考试信息
            </button>
            <button
              type="button"
              data-test="delete-exam-btn"
              class="rounded-md px-2 py-1 text-fine text-weak hover:bg-danger-soft hover:text-danger transition-colors"
              @click="onDeleteExam"
            >
              删除考试
            </button>
          </div>
        </div>

        <div class="scroll-thin overflow-x-auto">
          <table class="w-full text-caption" data-test="exam-detail-table">
            <thead>
              <tr class="bg-parchment text-left">
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">排名</th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">学生</th>
                <th
                  v-for="subj in subjects"
                  :key="subj"
                  class="whitespace-nowrap px-4 py-2 font-normal text-weak"
                >
                  {{ subj }}
                </th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-ink">总分</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in detailRows"
                :key="row.id"
                class="border-t border-hairline transition-colors hover:bg-pearl"
                @mouseenter="onRowEnter(row, $event)"
                @mousemove="onRowMove"
                @mouseleave="onRowLeave"
              >
                <td class="whitespace-nowrap px-4 py-2 tabular-nums text-weak">
                  {{ totalRanks.get(row.id) ?? "—" }}
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-ink">
                  {{ row.name }}
                  <span v-if="row.student_no" class="ml-1 text-fine text-weak">{{ row.student_no }}</span>
                </td>
                <td v-for="subj in subjects" :key="subj" class="whitespace-nowrap px-4 py-2">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      data-test="edit-score-cell"
                      class="-mx-1 rounded px-1 transition-colors hover:bg-pearl"
                      :class="levelText(row.cells.get(subj)?.score)"
                      :title="`修改 ${row.name} 的${subj}成绩`"
                      @click="openCorrect(row, subj)"
                    >
                      {{ cellText(row.cells.get(subj)) }}
                    </button>
                    <span
                      v-if="row.cells.get(subj)?.score !== null && row.cells.get(subj)?.score !== undefined"
                      class="inline-block h-1 w-10 overflow-hidden rounded-pill bg-divider align-middle"
                    >
                      <span
                        class="block h-full rounded-pill"
                        :class="barClass(row.cells.get(subj)?.score)"
                        :style="{ width: barWidthFor(row.cells.get(subj)?.score) }"
                      />
                    </span>
                  </div>
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold" :class="levelText(totalOf(row).score)">
                      <template v-if="totalOf(row).score !== null">
                        {{ totalDisplayText(totalOf(row).score) }}
                      </template>
                      <template v-else>{{ totalOf(row).grade ?? "—" }}</template>
                    </span>
                    <!-- 等级模式下总分列已显示等级名，徽标省去避免重复 -->
                    <span
                      v-if="totalOf(row).score !== null && !showLevelOnly"
                      class="rounded-pill bg-pearl px-1.5 py-0.5 text-fine"
                      :class="levelText((totalOf(row).score ?? 0) / (subjects.length || 1))"
                      data-test="total-level"
                    >
                      {{ levelName((totalOf(row).score ?? 0) / (subjects.length || 1)) }}
                    </span>
                    <span
                      v-if="totalOf(row).score !== null"
                      class="inline-block h-1 w-14 overflow-hidden rounded-pill bg-divider align-middle"
                    >
                      <span
                        class="block h-full rounded-pill"
                        :class="barClass(totalOf(row).score)"
                        :style="{ width: totalBarWidth(totalOf(row).score) }"
                      />
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 悬浮学生行：该生本场各科柱状图（跟随鼠标；渲染规则复用学生详情页成绩栏目） -->
        <div
          v-if="hoverRow && hoverBarGroups.length && hoverAnchor"
          data-test="student-score-hover-card"
          class="pointer-events-none fixed z-40 w-[264px] rounded-lg border border-hairline bg-canvas px-3 py-2.5 shadow-window"
          :style="{ left: `${hoverAnchor.left}px`, top: `${hoverAnchor.top}px` }"
        >
          <div class="flex items-baseline justify-between gap-2">
            <p class="truncate text-caption font-semibold text-ink">{{ hoverRow.name }}</p>
            <span v-if="hoverTotalText" class="shrink-0 text-fine text-weak">{{ hoverTotalText }}</span>
          </div>
          <p v-if="selectedExam" class="mt-0.5 truncate text-fine text-weak">
            {{ selectedExam.name }} · {{ fmtDate(selectedExam.exam_date).slice(5) }}
          </p>
          <div class="mt-2">
            <SubjectScoreBars :groups="hoverBarGroups" compact fill :show-label="false" />
          </div>
        </div>
      </div>
    </template>

    <!-- 视角 2：按学生总览（学生 × 各次考试总分矩阵） -->
    <template v-else-if="view === 'overview'">
      <EmptyState
        v-if="!overview.rows.length"
        title="暂无成绩数据"
        description="导入成绩后，这里会展示每个学生每次考试的总分"
      />
      <div v-else class="scroll-thin overflow-x-auto rounded-lg border border-hairline bg-canvas">
        <table class="w-full text-caption" data-test="score-overview-table">
          <thead>
            <tr class="bg-parchment text-left">
              <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">学生</th>
              <th
                v-for="exam in overview.exams"
                :key="exam.id"
                class="whitespace-nowrap px-4 py-2 font-normal text-weak"
              >
                {{ exam.name }}
                <span class="ml-1 opacity-70">{{ fmtDate(exam.exam_date).slice(5) }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in overview.rows" :key="row.student_id" class="border-t border-hairline">
              <td class="whitespace-nowrap px-4 py-2 text-ink">
                {{ row.student_name }}
                <span v-if="row.student_no" class="ml-1 text-fine text-weak">{{ row.student_no }}</span>
              </td>
              <td
                v-for="exam in overview.exams"
                :key="exam.id"
                class="whitespace-nowrap px-4 py-2 tabular-nums"
                :class="
                  overviewLevelText(row.cells[exam.id]?.score, exam.id) ||
                  (row.cells[exam.id] ? 'text-muted' : 'text-faint')
                "
              >
                <template v-if="row.cells[exam.id]?.score !== null && row.cells[exam.id]?.score !== undefined">
                  {{ overviewCellText(row.cells[exam.id]?.score, exam.id) }}
                </template>
                <template v-else-if="row.cells[exam.id]?.grade">{{ row.cells[exam.id].grade }}</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t border-hairline bg-pearl">
              <td class="whitespace-nowrap px-4 py-2 font-medium text-ink">班级平均</td>
              <td
                v-for="exam in overview.exams"
                :key="exam.id"
                class="whitespace-nowrap px-4 py-2 tabular-nums text-weak"
              >
                <template v-if="overviewStats.get(exam.id)?.count">
                  {{ overviewAvgText(exam.id) }}
                </template>
                <template v-else>—</template>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>

    <!-- 视角 3：成绩趋势（多次考试同时存在时的班级走势） -->
    <template v-else>
      <EmptyState
        v-if="trend.length < 2"
        title="需要至少两次考试才能看趋势"
        description="导入多份成绩单后，这里会展示班级均分与各科成绩的逐次变化"
      />
      <div v-else class="space-y-3" data-test="class-trend">
        <!-- 班级平均单科分趋势柱状图 -->
        <div class="rounded-lg border border-hairline bg-canvas p-4">
          <div class="flex items-center justify-between">
            <p class="text-caption font-medium text-ink">班级平均单科分趋势</p>
            <p class="text-fine text-weak">0~100，跨考试可比</p>
          </div>
          <div class="mt-4 flex items-end gap-3" data-test="class-trend-chart">
            <div
              v-for="point in trend"
              :key="point.exam.id"
              class="flex flex-1 flex-col items-center gap-1.5"
            >
              <span class="text-fine font-medium" :class="levelText(classAvgOf(point.stats))">
                {{ classAvgText(point.stats) }}
              </span>
              <span
                class="w-full max-w-[56px] rounded-t-sm"
                :class="barClass(classAvgOf(point.stats))"
                :style="{ height: trendBarHeight(classAvgPlot(point.stats)) }"
              />
              <span class="text-center text-fine text-weak">{{ point.exam.name }}</span>
              <span class="text-fine text-faint">{{ fmtDate(point.exam.exam_date).slice(5) }}</span>
            </div>
          </div>
        </div>

        <!-- 逐次考试统计 -->
        <div class="overflow-hidden rounded-lg border border-hairline bg-canvas">
          <div class="border-b border-hairline px-4 py-2.5">
            <p class="text-caption font-medium text-ink">逐次考试统计</p>
          </div>
          <div class="scroll-thin overflow-x-auto">
            <table class="w-full text-caption" data-test="exam-trend-table">
              <thead>
                <tr class="bg-pearl text-left">
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">考试</th>
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">日期</th>
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">参考</th>
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">平均单科分</th>
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">及格率</th>
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">优秀率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="point in trend" :key="point.exam.id" class="border-t border-hairline">
                  <td class="whitespace-nowrap px-4 py-2 text-ink">{{ point.exam.name }}</td>
                  <td class="whitespace-nowrap px-4 py-2 text-muted">{{ fmtDate(point.exam.exam_date) }}</td>
                  <td class="whitespace-nowrap px-4 py-2 tabular-nums text-muted">
                    {{ point.stats.student_count }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-2">
                    <span class="font-medium" :class="levelText(classAvgOf(point.stats))">
                      {{ classAvgText(point.stats) }}
                    </span>
                  </td>
                  <td class="whitespace-nowrap px-4 py-2 text-muted">
                    {{ formatRate(point.stats.total_pass_rate) }}
                  </td>
                  <td class="whitespace-nowrap px-4 py-2 text-muted">
                    {{ formatRate(point.stats.total_excellent_rate) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 各科平均分趋势矩阵 -->
        <div class="overflow-hidden rounded-lg border border-hairline bg-canvas">
          <div class="flex items-center justify-between border-b border-hairline px-4 py-2.5">
            <p class="text-caption font-medium text-ink">各科平均分趋势</p>
            <p class="text-fine text-weak">单科满分按 100 计</p>
          </div>
          <div class="scroll-thin overflow-x-auto">
            <table class="w-full text-caption" data-test="subject-trend-table">
              <thead>
                <tr class="bg-pearl text-left">
                  <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">科目</th>
                  <th
                    v-for="point in trend"
                    :key="point.exam.id"
                    class="whitespace-nowrap px-4 py-2 font-normal text-weak"
                  >
                    {{ point.exam.name }}
                    <span class="ml-1 opacity-70">{{ fmtDate(point.exam.exam_date).slice(5) }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="subj in trendSubjects" :key="subj" class="border-t border-hairline">
                  <td class="whitespace-nowrap px-4 py-2 text-ink">{{ subj }}</td>
                  <td
                    v-for="point in trend"
                    :key="point.exam.id"
                    class="whitespace-nowrap px-4 py-2 tabular-nums"
                    :class="levelText(subjectAvgOf(point.stats, subj)) || 'text-faint'"
                  >
                    {{ subjectAvgText(point.stats, subj) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>

    <!-- 编辑考试信息 -->
    <AppDialog :open="editOpen" title="编辑考试信息" width="sm" @close="editOpen = false">
      <div class="mt-4 space-y-3">
        <label class="block">
          <span class="text-caption text-weak">考试名</span>
          <input
            v-model="editName"
            data-test="edit-exam-name"
            autofocus
            class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          />
        </label>
        <label class="block">
          <span class="text-caption text-weak">考试时间</span>
          <!-- 原生日期选择器：点击日历图标即可选日期，无需手敲 YYYY-MM-DD -->
          <input
            v-model="editDate"
            data-test="edit-exam-date"
            type="date"
            class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          />
        </label>
        <label class="block">
          <span class="text-caption text-weak">考试种类</span>
          <select
            v-model="editType"
            data-test="edit-exam-type"
            class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          >
            <option value="major">大考（期中 / 期末）</option>
            <option value="minor">小考（单元测试 / 月考等）</option>
          </select>
        </label>
      </div>
      <div class="mt-5 flex items-center justify-end gap-3">
        <AppButton variant="pearl" @click="editOpen = false">取消</AppButton>
        <AppButton data-test="save-exam-btn" @click="saveExamEdit">保存</AppButton>
      </div>
    </AppDialog>

    <!-- 改分纠错：修改 / 清空单科成绩 -->
    <AppDialog
      :open="correctOpen && correctTarget !== null"
      title="修改成绩"
      width="sm"
      data-test="correct-score-dialog"
      @close="correctOpen = false"
    >
      <template v-if="correctTarget">
        <p class="mt-3 text-fine text-weak">
          {{ correctTarget.studentName }} · {{ correctTarget.subject }}
          <span class="ml-2">当前：{{ correctTarget.current }}</span>
        </p>

        <label class="mt-4 block">
          <span class="text-caption text-weak">新分数</span>
          <input
            v-model="correctValue"
            data-test="correct-score-input"
            autofocus
            class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
            placeholder="如 87.5；缺考等文字也可"
            @keyup.enter="saveCorrect"
          />
        </label>
        <p v-if="correctError" class="mt-2 text-fine text-danger" data-test="correct-error">
          {{ correctError }}
        </p>

        <div class="mt-5 flex items-center justify-between">
          <button
            type="button"
            data-test="clear-score-btn"
            class="rounded-md px-2 py-1 text-fine text-weak transition-colors hover:text-danger"
            @click="clearCorrect"
          >
            清空该科成绩
          </button>
          <div class="flex items-center gap-3">
            <AppButton variant="pearl" @click="correctOpen = false">取消</AppButton>
            <AppButton data-test="save-correct-btn" :disabled="correctSaving" @click="saveCorrect">
              保存
            </AppButton>
          </div>
        </div>
      </template>
    </AppDialog>

    <!-- 等级映射配置：分数 → 等级，成绩只存分数、等级由此派生 -->
    <AppDialog
      :open="levelOpen"
      title="等级映射"
      width="md"
      data-test="level-config-dialog"
      @close="levelOpen = false"
    >
      <p class="mt-3 text-fine text-weak">
        成绩只记录真实分数，等级由下面的分数线自动判定。改完立即对班级统计与个人成绩生效。
      </p>

      <!-- 显示等级开关：只改展示口径（等级名 / 档位分档图表），落库的仍是真实分数 -->
      <div
        class="mt-4 flex items-center justify-between gap-3 rounded-md bg-pearl px-3 py-2.5"
        data-test="show-level-row"
      >
        <div class="min-w-0">
          <p class="text-caption font-medium text-ink">显示等级</p>
          <p class="mt-0.5 text-fine text-weak">
            打开后成绩只显示等级、不显示具体分数，柱状图与折线图也按等级分档展示
          </p>
        </div>
        <button
          type="button"
          role="switch"
          data-test="show-level-toggle"
          :aria-checked="draftShowLevel"
          class="relative h-5 w-9 shrink-0 rounded-pill transition-colors"
          :class="draftShowLevel ? 'bg-primary' : 'bg-divider'"
          @click="draftShowLevel = !draftShowLevel"
        >
          <span
            class="absolute top-0.5 h-4 w-4 rounded-full bg-canvas shadow-sm transition-[left]"
            :style="{ left: draftShowLevel ? '18px' : '2px' }"
          />
        </button>
      </div>

      <div class="mt-4 space-y-2">
        <div
          v-for="(band, i) in levelDraft"
          :key="band.key"
          class="flex items-center gap-2"
          :data-test="`level-band-${band.key}`"
        >
          <input
            v-model="band.label"
            :data-test="`level-label-${band.key}`"
            class="h-9 w-24 rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          />
          <span class="text-caption text-weak">≥</span>
          <input
            v-model.number="band.min"
            :data-test="`level-min-${band.key}`"
            type="number"
            min="0"
            max="100"
            class="h-9 w-20 rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          />
          <span class="text-caption text-weak">分</span>
          <span class="ml-auto text-fine text-faint">{{ i === 0 ? "最高档" : i === levelDraft.length - 1 ? "最低档" : "" }}</span>
        </div>
      </div>

      <p class="mt-3 text-fine text-faint">
        提示：导入等级制成绩单时，「优/良/合格…」会按这里的分档折算成代表分落库。
      </p>

      <div class="mt-5 flex items-center justify-between">
        <button
          type="button"
          data-test="reset-level-btn"
          class="rounded-md px-2 py-1 text-fine text-weak transition-colors hover:text-ink"
          @click="resetLevelConfig"
        >
          恢复默认
        </button>
        <div class="flex items-center gap-3">
          <AppButton variant="pearl" @click="levelOpen = false">取消</AppButton>
          <AppButton data-test="save-level-btn" @click="saveLevelConfig">保存</AppButton>
        </div>
      </div>
    </AppDialog>

    <!-- 导入成绩对话框 -->
    <ImportScoreDialog
      :open="importOpen"
      :preset-class="props.className"
      @close="importOpen = false"
      @imported="refresh(true)"
    />
  </div>
</template>
