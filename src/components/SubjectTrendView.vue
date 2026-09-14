<script setup lang="ts">
/**
 * 单科成绩透视：学生成绩面板走势区的单科下钻视图。
 *
 * 输入当前 Tab（大考/小考）按时间正序的考试报告与所选科目，
 * 自上而下展示：单科统计条（平均/最高/最低/波动/较上次/最近名次）、
 * 「本人 vs 班级均分」双线走势、规则生成的趋势小结、历次名次一览。
 * 点击数据点由父级展开该次考试的完整详情卡。
 */
import { computed } from "vue";
import ScoreLineChart from "./ScoreLineChart.vue";
import { formatNumber, summarizeSubjectTrend } from "../lib/score-analysis";
import {
  levelNameOfScore,
  levelRankOf,
  levelStepText,
  levelValueOf,
  showLevelOnly,
} from "../lib/score-config";
import type { StudentExamReport } from "../types";

const props = withDefaults(
  defineProps<{
    /** 当前 Tab 按时间正序（旧 → 新）的考试报告 */
    exams: StudentExamReport[];
    subject: string;
    /** 该科图表色（与科目芯片色点、全科走势折线一致） */
    color: string;
    /** 当前选中的考试下标（高亮对应列与节点） */
    selectedIndex?: number | null;
  }>(),
  { selectedIndex: null }
);

const emit = defineEmits<{
  "point-click": [payload: { index: number }];
}>();

const summary = computed(() => summarizeSubjectTrend(props.exams, props.subject));

/** 等级模式：只显示等级、不显示具体分数，图表按档位代表值分档 */
const levelMode = showLevelOnly;

/** 折线纵坐标取值：等级模式下按档位代表值（同等级同一水平线） */
function plotValue(value: number | null): number | null {
  if (value === null) return null;
  return levelMode.value ? levelValueOf(value) : value;
}

const labels = computed(() =>
  summary.value.points.map((p) => ({
    label: p.exam_name.length > 8 ? `${p.exam_name.slice(0, 8)}…` : p.exam_name,
    sub: p.exam_date.slice(5, 10),
    full: p.exam_name,
  }))
);

/** 班级均分参照线：灰色虚线，弱于本人成绩线 */
const CLASS_AVG_COLOR = "#7a7a7a";

/** 双线走势：本人该科分数（实线）+ 班级均分（虚线参照；全班无数字分时不画） */
const series = computed(() => {
  const out: { name: string; values: (number | null)[]; dashed?: boolean; color?: string }[] = [
    { name: props.subject, values: summary.value.points.map((p) => plotValue(p.score)) },
  ];
  if (summary.value.points.some((p) => p.class_average !== null)) {
    out.push({
      name: "班级均分",
      values: summary.value.points.map((p) => plotValue(p.class_average)),
      dashed: true,
      color: CLASS_AVG_COLOR,
    });
  }
  return out;
});

/** 最近一次有数字分的成绩点（等级模式下与班均比档位用） */
const latestNumericPoint = computed(() => {
  const numeric = summary.value.points.filter((p) => p.score !== null);
  return numeric.length ? numeric[numeric.length - 1] : null;
});

/** 较上次的档位差（等级模式）：正数提升、负数下滑 */
const latestLevelDelta = computed(() => {
  const numeric = summary.value.points.filter((p) => p.score !== null);
  if (numeric.length < 2) return null;
  const cur = levelRankOf(numeric[numeric.length - 1]!.score);
  const prev = levelRankOf(numeric[numeric.length - 2]!.score);
  return cur !== null && prev !== null ? cur - prev : null;
});

/** 波动的档位跨度：最高档序 - 最低档序（等级模式） */
const levelSpan = computed(() => {
  const ranks = summary.value.points
    .map((p) => levelRankOf(p.score))
    .filter((r): r is number => r !== null);
  if (!ranks.length) return null;
  return Math.max(...ranks) - Math.min(...ranks);
});

/** 波动幅度的等级模式文本：同档 / N 档 */
const levelSpanText = computed(() => {
  if (levelSpan.value === null) return "—";
  return levelSpan.value === 0 ? "同档" : `${levelSpan.value} 档`;
});

/** 统计条数值：等级模式显示等级名，否则显示分数 */
function statText(value: number | null): string {
  if (value === null) return "—";
  return levelMode.value ? levelNameOfScore(value) : formatNumber(value);
}

function deltaWord(delta: number): string {
  if (delta > 0) return `进步 ${formatNumber(delta)} 分`;
  if (delta < 0) return `退步 ${formatNumber(Math.abs(delta))} 分`;
  return "与上次持平";
}

function gapWord(gap: number): string {
  if (gap > 0) return `高于班均 ${formatNumber(gap)} 分`;
  if (gap < 0) return `低于班均 ${formatNumber(Math.abs(gap))} 分`;
  return "与班均持平";
}

/** 规则生成的趋势小结（不调 AI，口径与统计条一致） */
const summaryText = computed(() => {
  const s = summary.value;
  if (!s.count) return `${props.subject} 本阶段暂无数字分成绩`;

  if (levelMode.value) {
    const parts = [`${props.subject} ${s.count} 次考试平均 ${levelNameOfScore(s.average)}`];
    if (s.latestScore !== null) {
      const base = `最近一次 ${levelNameOfScore(s.latestScore)}`;
      parts.push(
        latestLevelDelta.value !== null
          ? `${base}，较上次${levelStepText(latestLevelDelta.value)}`
          : base
      );
    }
    const latest = latestNumericPoint.value;
    if (latest) {
      const mine = levelRankOf(latest.score);
      const avg = levelRankOf(latest.class_average);
      if (mine !== null && avg !== null) {
        const gap = mine - avg;
        parts.push(gap > 0 ? `较班均高 ${gap} 档` : gap < 0 ? `较班均低 ${-gap} 档` : "与班均同档");
      }
    }
    if (s.latestRank !== null) {
      let rankPart = `班级第 ${s.latestRank} 名`;
      if (s.rankDelta !== null && s.rankDelta < 0) rankPart += `，较上次提升 ${Math.abs(s.rankDelta)} 名`;
      else if (s.rankDelta !== null && s.rankDelta > 0) rankPart += `，较上次下滑 ${s.rankDelta} 名`;
      parts.push(rankPart);
    }
    return parts.join("；");
  }

  const parts = [`${props.subject} ${s.count} 次考试平均 ${formatNumber(s.average)} 分`];
  if (s.latestScore !== null) {
    const base = `最近一次 ${formatNumber(s.latestScore)} 分`;
    parts.push(s.latestDelta !== null ? `${base}，较上次${deltaWord(s.latestDelta)}` : base);
  }
  if (s.latestGapToClassAvg !== null) parts.push(gapWord(s.latestGapToClassAvg));
  if (s.latestRank !== null) {
    let rankPart = `班级第 ${s.latestRank} 名`;
    if (s.rankDelta !== null && s.rankDelta < 0) rankPart += `，较上次提升 ${Math.abs(s.rankDelta)} 名`;
    else if (s.rankDelta !== null && s.rankDelta > 0) rankPart += `，较上次下滑 ${s.rankDelta} 名`;
    parts.push(rankPart);
  }
  return parts.join("；");
});

/** 「较上次」格子的箭头文本 */
function scoreDeltaText(delta: number | null): string {
  if (delta === null) return "—";
  if (delta > 0) return `↑ ${formatNumber(delta)}`;
  if (delta < 0) return `↓ ${formatNumber(Math.abs(delta))}`;
  return "持平";
}

function scoreDeltaClass(delta: number | null): string {
  if (delta === null) return "text-weak";
  if (delta > 0) return "text-success";
  if (delta < 0) return "text-danger";
  return "text-weak";
}

/** 历次名次 chips：每场带较上一个有名次场次的升降（跳过无名次的场次） */
const rankChips = computed(() => {
  let prevRank: number | null = null;
  return summary.value.points.map((p) => {
    const delta = p.class_rank !== null && prevRank !== null ? p.class_rank - prevRank : null;
    if (p.class_rank !== null) prevRank = p.class_rank;
    return { ...p, delta };
  });
});

function rankText(point: (typeof rankChips.value)[number]): string {
  if (point.class_rank !== null) return `第 ${point.class_rank} 名`;
  if (point.grade) return point.grade;
  return "—";
}
</script>

<template>
  <div class="space-y-3" data-test="subject-trend-view">
    <!-- 单科统计条 -->
    <div
      class="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-6"
      data-test="subject-trend-stats"
    >
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">{{ levelMode ? "平均等级" : "平均分" }}</p>
        <p class="mt-1 text-stat font-semibold text-ink">{{ statText(summary.average) }}</p>
      </div>
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">{{ levelMode ? "最高等级" : "最高分" }}</p>
        <p class="mt-1 text-stat font-semibold text-primary">{{ statText(summary.max) }}</p>
      </div>
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">{{ levelMode ? "最低等级" : "最低分" }}</p>
        <p class="mt-1 text-stat font-semibold text-ink">{{ statText(summary.min) }}</p>
      </div>
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">波动幅度</p>
        <p class="mt-1 text-stat font-semibold text-ink">
          {{ levelMode ? levelSpanText : summary.range !== null ? formatNumber(summary.range) : "—" }}
        </p>
      </div>
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">较上次</p>
        <p
          class="mt-1 text-stat font-semibold"
          :class="scoreDeltaClass(levelMode ? latestLevelDelta : summary.latestDelta)"
        >
          {{ levelMode ? (latestLevelDelta === null ? "—" : levelStepText(latestLevelDelta)) : scoreDeltaText(summary.latestDelta) }}
        </p>
      </div>
      <div class="bg-canvas px-3 py-2.5">
        <p class="text-fine text-weak">最近名次</p>
        <p class="mt-1 text-stat font-semibold text-ink">
          {{ summary.latestRank !== null ? `第 ${summary.latestRank}` : "—" }}
        </p>
      </div>
    </div>

    <!-- 本人 vs 班级均分 走势 -->
    <div data-test="subject-trend-chart">
      <ScoreLineChart
        :labels="labels"
        :series="series"
        :ids="summary.points.map((p) => p.exam_id)"
        :selected-index="selectedIndex"
        :value-formatter="levelMode ? levelNameOfScore : undefined"
        @point-click="(payload) => emit('point-click', { index: payload.index })"
      />
    </div>

    <!-- 趋势小结 -->
    <p
      class="rounded-lg border border-dashed border-hairline bg-pearl px-4 py-3 text-caption leading-relaxed text-muted"
      data-test="subject-trend-summary"
    >
      {{ summaryText }}
    </p>

    <!-- 历次名次一览 -->
    <div>
      <p class="text-fine text-weak">历次名次（{{ summary.points[0]?.class_student_count ?? "—" }} 人班级）</p>
      <div class="mt-2 flex flex-wrap gap-2" data-test="subject-trend-ranks">
        <div
          v-for="c in rankChips"
          :key="c.exam_id"
          class="rounded-md border border-hairline bg-pearl px-2.5 py-1.5"
        >
          <p class="flex items-center gap-1.5 text-caption font-medium text-ink">
            {{ rankText(c) }}
            <span
              v-if="c.delta !== null && c.delta !== 0"
              class="text-fine font-semibold"
              :class="c.delta < 0 ? 'text-success' : 'text-danger'"
            >
              {{ c.delta < 0 ? `↑${Math.abs(c.delta)}` : `↓${c.delta}` }}
            </span>
          </p>
          <p class="mt-0.5 text-fine text-weak">{{ c.exam_name }} · {{ c.exam_date.slice(5, 10) }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
