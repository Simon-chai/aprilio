<script setup lang="ts">
/**
 * 学生成绩面板：学生档案详情页「成绩」Tab 的主体。
 *
 * 数据来自 getStudentScoreReport（按考试时间倒序）：每场给出各科分数
 * （含班级平均分 / 单科排名 + 档位进度条）、总分（含班级平均 / 总分排名）
 * 与相较上一次考试的进退步，一眼看清「单科强弱 + 整体走势」。
 * 走势区可按科目下钻：选单科进入「单科透视」（本人 vs 班级均分、
 * 统计条、趋势小结、历次名次），默认「全部」保持全科折线。
 *
 * 「各科成绩分布」区先选考试场次，图型（柱状 / 条形 / 折线 / 饼状 / 辐射）
 * 取全局偏好（lib/score-chart-type.ts）：任一页切换一次，所有页面同步换图。
 */
import { computed, onMounted, ref, watch } from "vue";
import ScoreLineChart from "./ScoreLineChart.vue";
import ScoreChartTypeSelect from "./ScoreChartTypeSelect.vue";
import SubjectScoreDistribution from "./SubjectScoreDistribution.vue";
import SubjectTrendView from "./SubjectTrendView.vue";
import { getStudentScoreReport } from "../lib/db";
import { semesterOfDate } from "../lib/semester";
import { chartColorOf } from "../lib/chart-palette";
import {
  SCORE_LEVEL_BAR,
  SCORE_LEVEL_TEXT,
  formatNumber,
  round1,
  scoreRatio,
} from "../lib/score-analysis";
import {
  levelNameOfScore,
  levelOf,
  levelRankOf,
  levelStepText,
  levelValueOf,
  showLevelOnly,
} from "../lib/score-config";
import type {
  ExamType,
  StudentExamReport,
  StudentExamSubject,
  StudentScoreReport,
} from "../types";

const props = withDefaults(
  defineProps<{
    studentId: number;
    /** 学期过滤：只统计该学期的考试（由 exam_date 实时推导）；不传 = 全部 */
    semester?: string | null;
  }>(),
  { semester: null }
);

const report = ref<StudentScoreReport | null>(null);
const loading = ref(true);

/** 按学期过滤后的报告（考试按 exam_date 归属学期） */
const filteredReport = computed<StudentScoreReport | null>(() => {
  if (!report.value) return null;
  if (!props.semester) return report.value;
  const exams = report.value.exams.filter(
    (e) => semesterOfDate(e.exam_date) === props.semester
  );
  return { ...report.value, exams };
});

/** 当前展开的单次考试详情（点击折线图节点后才有值） */
const selectedExamId = ref<number | null>(null);

const selectedExam = computed(
  () => filteredReport.value?.exams.find((e) => e.exam_id === selectedExamId.value) ?? null
);

async function refresh() {
  loading.value = true;
  try {
    report.value = await getStudentScoreReport(props.studentId);
    selectedExamId.value = null;
    barExamId.value = null;
    activeSubject.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.studentId, refresh);
watch(() => props.semester, () => {
  selectedExamId.value = null;
  barExamId.value = null;
});
onMounted(refresh);

/** 有数字总分的历次成绩 */
const numericTotals = computed(
  () =>
    filteredReport.value?.exams
      .map((e) => e.total)
      .filter((t): t is number => t !== null && t !== undefined) ?? []
);

const averageTotal = computed(() =>
  numericTotals.value.length
    ? round1(numericTotals.value.reduce((a, b) => a + b, 0) / numericTotals.value.length)
    : null
);

const bestTotal = computed(() =>
  numericTotals.value.length ? Math.max(...numericTotals.value) : null
);

/** 等级模式：总分判档需按科目数折算成单科口径（平均总分按平均科目数折算） */
const avgSubjectCount = computed(() => {
  const exams = (filteredReport.value?.exams ?? []).filter((e) => e.total !== null);
  if (!exams.length) return 1;
  return exams.reduce((a, e) => a + Math.max(1, e.subjects.length), 0) / exams.length;
});

/** 等级模式：最好总分对应场次的科目数 */
const bestSubjectCount = computed(() => {
  const exams = (filteredReport.value?.exams ?? []).filter(
    (e) => e.total !== null && e.total === bestTotal.value
  );
  return exams[0]?.subjects.length ?? 1;
});

/** 总分判档：按科目数折算成单科口径（等级模式展示用） */
function totalLevelText(total: number | null | undefined, subjectCount: number): string {
  if (total === null || total === undefined) return "—";
  return levelNameOfScore(total / Math.max(1, subjectCount));
}

/** 最近一次有名次的考试排名 */
const latestRank = computed(
  () => filteredReport.value?.exams.find((e) => e.class_total_rank !== null)?.class_total_rank ?? null
);

function displayScore(s: StudentExamSubject): string {
  if (s.score !== null) {
    return showLevelOnly.value ? levelNameOfScore(s.score) : String(s.score);
  }
  return s.grade ?? "—";
}

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

function barWidth(score: number | null | undefined): string {
  return `${Math.round(scoreRatio(score) * 100)}%`;
}

/** 进度条宽度：等级模式按档位代表值（同等级等宽） */
function barWidthFor(score: number | null | undefined): string {
  return barWidth(showLevelOnly.value ? levelValueOf(score) : score);
}

/** 班级均分文本：等级模式显示等级名（单科均分本身是 0~100 口径） */
function avgText(value: number | null): string {
  if (value === null) return "—";
  return showLevelOnly.value ? levelNameOfScore(value) : formatNumber(value);
}

function deltaText(delta: number | null): string {
  if (delta === null) return "";
  if (delta > 0) return `↑ ${formatNumber(delta)}`;
  if (delta < 0) return `↓ ${formatNumber(Math.abs(delta))}`;
  return "持平";
}

function deltaClass(delta: number | null): string {
  if (delta === null) return "text-weak";
  if (delta > 0) return "text-success";
  if (delta < 0) return "text-danger";
  return "text-weak";
}

function totalText(exam: StudentExamReport): string {
  if (exam.total === null) return exam.total_grade ?? "—";
  return showLevelOnly.value
    ? totalLevelText(exam.total, exam.subjects.length)
    : formatNumber(exam.total);
}

/** 历次考试按时间正序（旧 → 新）；用于判断是否需要展示走势图 */
const examColumns = computed(() => [...(filteredReport.value?.exams ?? [])].reverse());

/** 单次考试的「平均单科分」（0~100，跨考试可比）；纯等级考试为 null */
function avgSingleOf(exam: StudentExamReport): number | null {
  if (exam.total === null) return null;
  const numeric = exam.subjects.filter((s) => s.score !== null).length;
  return numeric ? round1(exam.total / numeric) : null;
}

/* ---------------- 各科成绩分布（按考试场次；图型由全局偏好决定） ---------------- */

/** 分布图选中的考试场次；null = 默认看最近一场 */
const barExamId = ref<number | null>(null);

/** 当前场次（考试列表按时间倒序，未选择时取最近一场） */
const activeBarExam = computed<StudentExamReport | null>(() => {
  const exams = filteredReport.value?.exams ?? [];
  return exams.find((e) => e.exam_id === barExamId.value) ?? exams[0] ?? null;
});

/** 当前场次各科（顺序即成绩单顺序）：柱状 / 条形 / 折线 / 饼状 / 辐射图共用同一份数据 */
const activeBarItems = computed(() => {
  const exam = activeBarExam.value;
  if (!exam) return [];
  return exam.subjects.map((s) => ({ subject: s.subject, score: s.score, grade: s.grade }));
});

/** 当前场次的摘要行：日期 · 大考/小考 · 总分（或等级）· 排名 · 班均 */
const activeBarMeta = computed(() => {
  const exam = activeBarExam.value;
  if (!exam) return [];
  const parts: string[] = [exam.exam_date.slice(0, 10), exam.exam_type === "major" ? "大考" : "小考"];
  if (exam.total !== null) {
    parts.push(
      showLevelOnly.value
        ? `总分 ${totalLevelText(exam.total, exam.subjects.length)}`
        : `总分 ${formatNumber(exam.total)}`
    );
  } else if (exam.total_grade) {
    parts.push(`等级 ${exam.total_grade}`);
  }
  if (exam.class_total_rank !== null) parts.push(`班级第 ${exam.class_total_rank}`);
  if (exam.class_total_average !== null) {
    parts.push(
      showLevelOnly.value
        ? `班均 ${totalLevelText(exam.class_total_average, exam.subjects.length)}`
        : `班均 ${formatNumber(exam.class_total_average)}`
    );
  }
  return parts;
});

/* ---------------- 科目成绩折线图（按大考 / 小考分组，可下钻单科） ---------------- */

/** 全局科目顺序（报告里按首次出现，最近考试的科目优先）：芯片色点与折线配色共用 */
const globalSubjects = computed(() => {
  const names: string[] = [];
  for (const exam of filteredReport.value?.exams ?? []) {
    for (const s of exam.subjects) {
      if (!names.includes(s.subject)) names.push(s.subject);
    }
  }
  return names;
});

/** 科目图表色：与全局顺序对齐，保证同科目跨图表同色 */
function subjectColorOf(subject: string): string {
  const index = globalSubjects.value.indexOf(subject);
  return chartColorOf(index >= 0 ? index : 0);
}

/** 单科透视选中的科目；null = 全科走势（每科一条线） */
const activeSubject = ref<string | null>(null);

interface ScoreChartGroup {
  type: ExamType;
  title: string;
  /** 该组按时间正序的考试（与 labels / series 下标对齐） */
  exams: StudentExamReport[];
  labels: { label: string; sub: string; full: string }[];
  series: { name: string; values: (number | null)[] }[];
}

/**
 * 每个大类一张折线图：横轴是该类的考试（按时间正序），
 * 每条折线一个科目，缺考的点为空（折线断开）。
 * 科目顺序取全局顺序（过滤掉该组没有的科目），让大考 / 小考两图同科目同色。
 */
const chartGroups = computed<ScoreChartGroup[]>(() => {
  const exams = filteredReport.value?.exams ?? [];
  const build = (type: ExamType, title: string): ScoreChartGroup | null => {
    const list = exams.filter((e) => e.exam_type === type).slice().reverse();
    if (!list.length) return null;
    const subjectNames = globalSubjects.value.filter((name) =>
      list.some((e) => e.subjects.some((s) => s.subject === name))
    );
    return {
      type,
      title,
      exams: list,
      labels: list.map((e) => ({
        label: e.exam_name.length > 8 ? `${e.exam_name.slice(0, 8)}…` : e.exam_name,
        sub: e.exam_date.slice(5, 10),
        full: e.exam_name,
      })),
      series: subjectNames.map((name) => ({
        name,
        values: list.map((e) => {
          const score = e.subjects.find((s) => s.subject === name)?.score ?? null;
          // 等级模式：纵坐标按档位代表值画，同等级同一水平线
          return showLevelOnly.value ? levelValueOf(score) : score;
        }),
      })),
    };
  };
  return [build("major", "大考"), build("minor", "小考")].filter(
    (g): g is ScoreChartGroup => g !== null
  );
});

/** 当前 Tab：大考 / 小考（切换后只展示对应走势图） */
const activeChartType = ref<ExamType>("major");

/** 当前 Tab 对应的走势图数据；该类型没有考试时回退到第一组 */
const activeGroup = computed<ScoreChartGroup | null>(
  () =>
    chartGroups.value.find((g) => g.type === activeChartType.value) ??
    chartGroups.value[0] ??
    null
);

/** 切换大考/小考或学期后，所选科目在该组没有任何成绩时回退「全部」 */
watch(activeGroup, (group) => {
  if (
    activeSubject.value &&
    group &&
    !group.exams.some((e) => e.subjects.some((s) => s.subject === activeSubject.value))
  ) {
    activeSubject.value = null;
  }
});

/** 选中考试在某组里的下标（用于高亮节点）；不在该组则为 null */
function selectedIndexOf(group: ScoreChartGroup): number | null {
  const index = group.exams.findIndex((e) => e.exam_id === selectedExamId.value);
  return index >= 0 ? index : null;
}

/** 点击折线图节点 → 展开该次考试的明细（再点一次收起） */
function onPointClick(group: ScoreChartGroup | null, payload: { index: number }) {
  const exam = group?.exams[payload.index];
  if (!exam) return;
  selectedExamId.value = selectedExamId.value === exam.exam_id ? null : exam.exam_id;
}

/** 详情卡「较上次」数值：等级模式按档位差（正数提升），否则按分差 */
const selectedDelta = computed<number | null>(() => {
  if (!selectedExam.value) return null;
  if (showLevelOnly.value) {
    const exams = filteredReport.value?.exams ?? [];
    const index = exams.findIndex((e) => e.exam_id === selectedExam.value!.exam_id);
    if (index < 0 || index + 1 >= exams.length) return null;
    const cur = exams[index]!;
    const prev = exams[index + 1]!;
    if (cur.total === null || prev.total === null) return null;
    const a = levelRankOf(cur.total / Math.max(1, cur.subjects.length));
    const b = levelRankOf(prev.total / Math.max(1, prev.subjects.length));
    return a !== null && b !== null ? a - b : null;
  }
  return selectedExam.value.total_delta;
});
</script>

<template>
  <div class="space-y-4" data-test="student-score-panel">
    <p v-if="loading" class="py-6 text-center text-caption text-weak">加载中…</p>

    <p v-else-if="!filteredReport || !filteredReport.exams.length" class="py-6 text-center text-caption text-weak">
      这个学期还没有成绩记录。可切换学期查看，或到「班级管理 → 考试成绩」导入成绩单。
    </p>

    <template v-else>
      <!-- 概览：考试次数 / 平均总分 / 最好总分 / 最近排名 -->
      <div
        class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-4"
        data-test="student-score-summary"
      >
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">参考考试</p>
          <p class="mt-1 text-stat font-semibold text-ink">{{ filteredReport.exams.length }}</p>
        </div>
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">{{ showLevelOnly ? "平均等级" : "平均总分" }}</p>
          <p class="mt-1 text-stat font-semibold text-ink">
            {{ showLevelOnly ? totalLevelText(averageTotal, avgSubjectCount) : formatNumber(averageTotal) }}
          </p>
        </div>
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">{{ showLevelOnly ? "最好等级" : "最好总分" }}</p>
          <p class="mt-1 text-stat font-semibold text-primary">
            {{ showLevelOnly ? totalLevelText(bestTotal, bestSubjectCount) : formatNumber(bestTotal) }}
          </p>
        </div>
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">最近排名</p>
          <p class="mt-1 text-stat font-semibold text-ink">
            {{ latestRank !== null ? `第 ${latestRank}` : "—" }}
          </p>
        </div>
      </div>

      <!-- 各科成绩分布：先选考试场次，再看该场各科（图型是全局偏好，切换后所有页面同步） -->
      <div
        v-if="activeBarExam"
        class="rounded-lg border border-hairline bg-canvas p-4"
        data-test="student-subject-bars"
      >
        <!-- 标题 + 图型下拉：下拉收掉五个类型胶囊，视野留给定表格与图表本身 -->
        <div class="scrollbar-none flex items-center justify-between gap-3 overflow-x-auto">
          <p class="shrink-0 whitespace-nowrap text-caption font-medium text-ink">各科成绩分布</p>
          <ScoreChartTypeSelect />
        </div>

        <!-- 场次入口：一次考试一个芯片，默认选中最近一场 -->
        <div class="scroll-thin mt-3 flex items-center gap-2 overflow-x-auto" data-test="subject-bars-exams">
          <button
            v-for="exam in filteredReport.exams"
            :key="exam.exam_id"
            type="button"
            :data-test="`subject-bars-exam-${exam.exam_id}`"
            class="whitespace-nowrap rounded-pill px-3 py-1.5 text-caption transition-colors"
            :class="
              exam.exam_id === activeBarExam.exam_id
                ? 'grad-border-soft text-primary font-medium'
                : 'border border-hairline bg-canvas text-weak hover:border-ink hover:text-ink'
            "
            @click="barExamId = exam.exam_id"
          >
            {{ exam.exam_name }}
            <span class="opacity-70">· {{ exam.exam_date.slice(5, 10) }}</span>
          </button>
        </div>

        <!-- 当前场次摘要 -->
        <p v-if="activeBarMeta.length" class="mt-2.5 text-fine text-weak" data-test="subject-bars-meta">
          {{ activeBarMeta.join(" · ") }}
        </p>

        <div class="mt-3">
          <SubjectScoreDistribution :items="activeBarItems" />
        </div>
      </div>

      <!-- 多次考试对比：走势图（大考 / 小考 分 Tab）+ 逐次矩阵 -->
      <div v-if="examColumns.length > 1" class="space-y-3" data-test="multi-exam-section">
        <!-- 成绩走势：大考 / 小考 用 Tab 切换，不再并排堆在一栏 -->
        <div
          v-if="activeGroup"
          class="rounded-lg border border-hairline bg-canvas p-4"
          :data-test="`line-chart-${activeGroup.type}`"
        >
          <!-- 走势节头：窄容器保持单行横向滚动，Tab 组不换行竖排 -->
          <div class="scrollbar-none flex items-center justify-between gap-2 overflow-x-auto">
            <p class="shrink-0 whitespace-nowrap text-caption font-medium text-ink">
              {{ activeGroup.title }}{{ activeSubject ? `·${activeSubject}` : "" }}成绩走势
            </p>
            <div class="flex shrink-0 items-center gap-2">
              <p class="whitespace-nowrap text-fine text-weak">
                {{ activeGroup.labels.length }} 次 · 悬浮看分数 · 点击看该次考试
              </p>
              <div
                v-if="chartGroups.length > 1"
                class="flex shrink-0 rounded-[6px] bg-pearl p-0.5"
                data-test="chart-tabs"
              >
                <button
                  v-for="g in chartGroups"
                  :key="g.type"
                  type="button"
                  :data-test="`chart-tab-${g.type}`"
                  class="rounded-[5px] px-3 py-1 text-caption transition-colors"
                  :class="
                    g.type === activeGroup.type
                      ? 'bg-canvas font-medium text-primary shadow-sm'
                      : 'text-weak hover:text-ink'
                  "
                  @click="activeChartType = g.type"
                >
                  {{ g.title }}
                </button>
              </div>
            </div>
          </div>

          <!-- 科目维度：全部 = 每科一条线；选单科进入单科透视 -->
          <div class="scroll-thin mt-3 flex items-center gap-2 overflow-x-auto" data-test="subject-trend-chips">
            <button
              type="button"
              data-test="subject-chip-all"
              class="whitespace-nowrap rounded-pill px-3 py-1.5 text-caption transition-colors"
              :class="
                activeSubject === null
                  ? 'grad-border-soft text-primary font-medium'
                  : 'border border-hairline bg-canvas text-weak hover:border-ink hover:text-ink'
              "
              @click="activeSubject = null"
            >
              全部
            </button>
            <button
              v-for="subject in globalSubjects"
              :key="subject"
              type="button"
              :data-test="`subject-chip-${subject}`"
              class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3 py-1.5 text-caption transition-colors"
              :class="
                activeSubject === subject
                  ? 'grad-border-soft text-primary font-medium'
                  : 'border border-hairline bg-canvas text-weak hover:border-ink hover:text-ink'
              "
              @click="activeSubject = subject"
            >
              <span
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                :style="{ backgroundColor: subjectColorOf(subject) }"
              />
              {{ subject }}
            </button>
          </div>

          <div class="mt-3" data-test="student-trend-chart">
            <SubjectTrendView
              v-if="activeSubject"
              :exams="activeGroup.exams"
              :subject="activeSubject"
              :color="subjectColorOf(activeSubject)"
              :selected-index="selectedIndexOf(activeGroup)"
              @point-click="(payload) => onPointClick(activeGroup, payload)"
            />
            <ScoreLineChart
              v-else
              :labels="activeGroup.labels"
              :series="activeGroup.series"
              :ids="activeGroup.exams.map((e) => e.exam_id)"
              :selected-index="selectedIndexOf(activeGroup)"
              :value-formatter="showLevelOnly ? levelNameOfScore : undefined"
              @point-click="(payload) => onPointClick(activeGroup, payload)"
            />
          </div>

          <!-- 点击走势图节点后，该次考试详情直接展示在走势图下方 -->
          <div
            v-if="!selectedExam"
            class="mt-3 rounded-lg border border-dashed border-hairline px-4 py-4 text-center text-caption text-weak"
            data-test="exam-detail-hint"
          >
            点击上方数据点，查看该次考试的详细成绩
          </div>
          <div
            v-else
            :key="selectedExam.exam_id"
            data-test="exam-card"
            class="mt-3 overflow-hidden rounded-lg border border-hairline"
          >
            <div
              class="scrollbar-none flex items-center justify-between gap-2 overflow-x-auto border-b border-hairline px-4 py-3"
            >
              <div class="shrink-0">
                <p class="whitespace-nowrap text-caption font-semibold text-ink">
                  {{ selectedExam.exam_name }}
                  <span class="ml-2 font-normal text-weak">
                    {{ selectedExam.exam_date.slice(0, 10) }}
                  </span>
                  <span class="ml-2 rounded-pill bg-pearl px-2 py-0.5 text-fine font-normal text-weak">
                    {{ selectedExam.exam_type === "major" ? "大考" : "小考" }}
                  </span>
                </p>
                <p class="mt-0.5 whitespace-nowrap text-fine text-weak">
                  <template v-if="selectedExam.class_total_rank !== null">
                    班级第 {{ selectedExam.class_total_rank }} / {{ selectedExam.class_student_count }} 名
                  </template>
                  <template v-else>等级制考试</template>
                  <template v-if="selectedExam.class_total_average !== null">
                    ·
                    {{ showLevelOnly ? "班均等级" : "班均总分" }}
                    {{
                      showLevelOnly
                        ? totalLevelText(selectedExam.class_total_average, selectedExam.subjects.length)
                        : formatNumber(selectedExam.class_total_average)
                    }}
                  </template>
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span
                  v-if="selectedDelta !== null"
                  class="whitespace-nowrap text-fine font-medium"
                  :class="deltaClass(selectedDelta)"
                  data-test="score-delta"
                >
                  {{ showLevelOnly ? levelStepText(selectedDelta) : deltaText(selectedDelta) }}
                </span>
                <span
                  class="rounded-pill bg-primary-soft px-2.5 py-0.5 text-caption font-semibold"
                  :class="levelText(selectedExam.total)"
                  data-test="score-total"
                >
                  {{ totalText(selectedExam) }}
                </span>
                <!-- 等级模式下总分徽标已是等级名，单科口径的等级徽标省去避免重复 -->
                <span
                  v-if="!showLevelOnly && avgSingleOf(selectedExam) !== null"
                  class="text-fine"
                  :class="levelText(avgSingleOf(selectedExam))"
                  data-test="score-level"
                >
                  {{ levelName(avgSingleOf(selectedExam)) }}
                </span>
                <button
                  type="button"
                  data-test="close-exam-detail"
                  class="rounded-md px-1.5 py-0.5 text-fine text-weak transition-colors hover:text-ink"
                  @click="selectedExamId = null"
                >
                  收起
                </button>
              </div>
            </div>

            <div class="space-y-2.5 px-4 py-3">
              <div
                v-for="s in selectedExam.subjects"
                :key="s.subject"
                class="flex items-center gap-3"
                :class="
                  activeSubject === s.subject ? '-mx-2 rounded-md bg-pearl px-2 py-1' : ''
                "
                :data-test="activeSubject === s.subject ? 'exam-card-active-subject' : undefined"
              >
                <span class="w-20 shrink-0 whitespace-nowrap text-caption" :class="levelText(s.score)">
                  {{ s.subject }} {{ displayScore(s) }}
                </span>
                <span class="h-1.5 flex-1 overflow-hidden rounded-pill bg-divider">
                  <span
                    class="block h-full rounded-pill"
                    :class="barClass(s.score)"
                    :style="{ width: barWidthFor(s.score) }"
                  />
                </span>
                <span class="shrink-0 whitespace-nowrap text-fine text-weak">
                  <template v-if="s.class_average !== null">
                    班均 {{ avgText(s.class_average) }}
                    <template v-if="s.class_rank !== null"> · 第 {{ s.class_rank }}</template>
                  </template>
                  <template v-else>—</template>
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>
