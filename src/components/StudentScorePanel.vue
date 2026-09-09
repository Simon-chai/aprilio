<script setup lang="ts">
/**
 * 学生成绩面板：学生档案详情页「成绩」Tab 的主体。
 *
 * 数据来自 getStudentScoreReport（按考试时间倒序）：每场给出各科分数
 * （含班级平均分 / 单科排名 + 档位进度条）、总分（含班级平均 / 总分排名）
 * 与相较上一次考试的进退步，一眼看清「单科强弱 + 整体走势」。
 */
import { computed, onMounted, ref, watch } from "vue";
import ScoreLineChart from "./ScoreLineChart.vue";
import { getStudentScoreReport } from "../lib/db";
import { semesterOfDate } from "../lib/semester";
import {
  SCORE_LEVEL_BAR,
  SCORE_LEVEL_TEXT,
  formatNumber,
  round1,
  scoreRatio,
} from "../lib/score-analysis";
import { levelNameOfScore, levelOf } from "../lib/score-config";
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
  } finally {
    loading.value = false;
  }
}

watch(() => props.studentId, refresh);
watch(() => props.semester, () => {
  selectedExamId.value = null;
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

/** 最近一次有名次的考试排名 */
const latestRank = computed(
  () => filteredReport.value?.exams.find((e) => e.class_total_rank !== null)?.class_total_rank ?? null
);

function displayScore(s: StudentExamSubject): string {
  if (s.score !== null) return String(s.score);
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
  if (exam.total !== null) return formatNumber(exam.total);
  return exam.total_grade ?? "—";
}

/** 历次考试按时间正序（旧 → 新）；用于判断是否需要展示走势图 */
const examColumns = computed(() => [...(filteredReport.value?.exams ?? [])].reverse());

/** 单次考试的「平均单科分」（0~100，跨考试可比）；纯等级考试为 null */
function avgSingleOf(exam: StudentExamReport): number | null {
  if (exam.total === null) return null;
  const numeric = exam.subjects.filter((s) => s.score !== null).length;
  return numeric ? round1(exam.total / numeric) : null;
}

/* ---------------- 科目成绩折线图（按大考 / 小考分组） ---------------- */

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
 */
const chartGroups = computed<ScoreChartGroup[]>(() => {
  const exams = filteredReport.value?.exams ?? [];
  const build = (type: ExamType, title: string): ScoreChartGroup | null => {
    const list = exams.filter((e) => e.exam_type === type).slice().reverse();
    if (!list.length) return null;
    const subjectNames: string[] = [];
    for (const exam of list) {
      for (const s of exam.subjects) {
        if (!subjectNames.includes(s.subject)) subjectNames.push(s.subject);
      }
    }
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
        values: list.map((e) => e.subjects.find((s) => s.subject === name)?.score ?? null),
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
          <p class="text-fine text-weak">平均总分</p>
          <p class="mt-1 text-stat font-semibold text-ink">{{ formatNumber(averageTotal) }}</p>
        </div>
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">最好总分</p>
          <p class="mt-1 text-stat font-semibold text-primary">{{ formatNumber(bestTotal) }}</p>
        </div>
        <div class="bg-canvas px-4 py-3">
          <p class="text-fine text-weak">最近排名</p>
          <p class="mt-1 text-stat font-semibold text-ink">
            {{ latestRank !== null ? `第 ${latestRank}` : "—" }}
          </p>
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
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-caption font-medium text-ink">{{ activeGroup.title }}成绩走势</p>
            <div class="flex items-center gap-2">
              <p class="text-fine text-weak">
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

          <div class="mt-3" data-test="student-trend-chart">
            <ScoreLineChart
              :labels="activeGroup.labels"
              :series="activeGroup.series"
              :ids="activeGroup.exams.map((e) => e.exam_id)"
              :selected-index="selectedIndexOf(activeGroup)"
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
              class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3"
            >
              <div class="min-w-0">
                <p class="text-caption font-semibold text-ink">
                  {{ selectedExam.exam_name }}
                  <span class="ml-2 font-normal text-weak">
                    {{ selectedExam.exam_date.slice(0, 10) }}
                  </span>
                  <span class="ml-2 rounded-pill bg-pearl px-2 py-0.5 text-fine font-normal text-weak">
                    {{ selectedExam.exam_type === "major" ? "大考" : "小考" }}
                  </span>
                </p>
                <p class="mt-0.5 text-fine text-weak">
                  <template v-if="selectedExam.class_total_rank !== null">
                    班级第 {{ selectedExam.class_total_rank }} / {{ selectedExam.class_student_count }} 名
                  </template>
                  <template v-else>等级制考试</template>
                  <template v-if="selectedExam.class_total_average !== null">
                    · 班均总分 {{ formatNumber(selectedExam.class_total_average) }}
                  </template>
                </p>
              </div>
              <div class="flex items-center gap-2">
                <span
                  v-if="selectedExam.total_delta !== null"
                  class="text-fine font-medium"
                  :class="deltaClass(selectedExam.total_delta)"
                  data-test="score-delta"
                >
                  {{ deltaText(selectedExam.total_delta) }}
                </span>
                <span
                  class="rounded-pill bg-primary-soft px-2.5 py-0.5 text-caption font-semibold"
                  :class="levelText(selectedExam.total)"
                  data-test="score-total"
                >
                  {{ totalText(selectedExam) }}
                </span>
                <span
                  v-if="avgSingleOf(selectedExam) !== null"
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
              <div v-for="s in selectedExam.subjects" :key="s.subject" class="flex items-center gap-3">
                <span class="w-20 shrink-0 whitespace-nowrap text-caption" :class="levelText(s.score)">
                  {{ s.subject }} {{ displayScore(s) }}
                </span>
                <span class="h-1.5 flex-1 overflow-hidden rounded-pill bg-divider">
                  <span
                    class="block h-full rounded-pill"
                    :class="barClass(s.score)"
                    :style="{ width: barWidth(s.score) }"
                  />
                </span>
                <span class="shrink-0 whitespace-nowrap text-fine text-weak">
                  <template v-if="s.class_average !== null">
                    班均 {{ formatNumber(s.class_average) }}
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
