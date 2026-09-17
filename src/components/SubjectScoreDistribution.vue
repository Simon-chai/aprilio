<script setup lang="ts">
/**
 * 各科成绩分布图（一场考试一次）：按全局偏好渲染 + 图下统一说明。
 *
 * - 类型是全局偏好（lib/score-chart-type.ts），切换器在成绩卡片标题右侧（ScoreChartTypeSelect）；
 * - 五种类型口径同源（lib/score-chart.ts），颜色取共享调色板，同科跨图同色；
 * - 除饼状图（看构成，走真实占比）外，其余四图的基准线都按本次分数区间动态上抬，
 *   分数挤在高分段也看得出强弱，具体刻度写在图下；
 * - 柱状图自带图例，其口径说明由这里统一收口（show-hint=false）；
 * - 未计入图形的科目（缺考等无数字分）也在图下列出，避免各图各说各话。
 */
import { computed } from "vue";
import SubjectScoreBars from "./SubjectScoreBars.vue";
import SubjectScoreHBar from "./SubjectScoreHBar.vue";
import SubjectScoreLine from "./SubjectScoreLine.vue";
import SubjectScorePie from "./SubjectScorePie.vue";
import SubjectScoreRadar from "./SubjectScoreRadar.vue";
import { SCORE_CHART_TYPES, scoreChartType } from "../lib/score-chart-type";
import { plotScaleOf, plottedScoreOf, skippedSubjectTexts } from "../lib/score-chart";
import type { SubjectScoreBarItem } from "../types";

const props = defineProps<{ items: SubjectScoreBarItem[] }>();

const activeType = computed(
  () => SCORE_CHART_TYPES.find((t) => t.value === scoreChartType.value) ?? SCORE_CHART_TYPES[0]!
);

/** 本次各科绘图值 → 放大基准（柱状图 / 条形图 / 折线图 / 辐射图共用同一刻度） */
const scale = computed(() =>
  plotScaleOf(
    props.items
      .map((item) => plottedScoreOf(item.score))
      .filter((value): value is number => value !== null)
  )
);

const skipped = computed(() => skippedSubjectTexts(props.items));

/** 图下说明：口径（带实际刻度）+ 未计入图形的科目 */
const note = computed(() => {
  const parts = [
    scoreChartType.value === "pie"
      ? activeType.value.hint
      : `${activeType.value.hint}（刻度 ${scale.value.floor}~${scale.value.ceiling} 分）`,
  ];
  if (skipped.value.length) parts.push(`未计入图形的科目：${skipped.value.join("、")}`);
  return parts.join(" · ");
});

/** 柱状图仍走既有分组组件（一组 = 一场考试）；场次标签由卡片头部承担 */
const barGroups = computed(() => [{ label: "", items: props.items }]);
</script>

<template>
  <div data-test="subject-score-distribution">
    <SubjectScoreBars
      v-if="scoreChartType === 'bar'"
      :groups="barGroups"
      fill
      :show-label="false"
      :show-hint="false"
    />
    <SubjectScoreHBar v-else-if="scoreChartType === 'hbar'" :items="props.items" />
    <SubjectScoreLine v-else-if="scoreChartType === 'line'" :items="props.items" />
    <SubjectScorePie v-else-if="scoreChartType === 'pie'" :items="props.items" />
    <SubjectScoreRadar v-else :items="props.items" />

    <p class="mt-3 text-fine text-faint" data-test="distribution-note">{{ note }}</p>
  </div>
</template>