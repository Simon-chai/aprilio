<script setup lang="ts">
/**
 * 各科成绩分布图型下拉（全局偏好）。
 *
 * 五个类型用胶囊并排太占视野，这里收成一个下拉，放成绩卡片标题右侧；
 * 选中即写全局偏好（lib/score-chart-type.ts），所有展示各科成绩分布的页面同步换图。
 */
import { SCORE_CHART_TYPES, scoreChartType, setScoreChartType } from "../lib/score-chart-type";
import type { ScoreChartType } from "../lib/score-chart-type";

function onChange(event: Event): void {
  setScoreChartType((event.target as HTMLSelectElement).value as ScoreChartType);
}
</script>

<template>
  <label class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-caption text-weak">
    图形
    <select
      data-test="chart-type-select"
      :value="scoreChartType"
      class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
      @change="onChange"
    >
      <option v-for="t in SCORE_CHART_TYPES" :key="t.value" :value="t.value">
        {{ t.label }}
      </option>
    </select>
  </label>
</template>