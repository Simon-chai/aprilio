<script setup lang="ts">
/**
 * 各科成绩条形图（横向）：一科一条横条，长度按本次分数区间放大（基准线不钉在 0 分）。
 *
 * 与柱状图同一套口径（见 lib/score-chart.ts）：科目顺序即成绩单顺序，
 * 横条颜色取共享调色板（同科跨图同色），等级模式按档位代表值取长短、文字显示等级名；
 * 缺考等无数字分的科目不画条，只留文字（图下由宿主统一列出未计入科目）。
 */
import { computed } from "vue";
import {
  plotRatioOf,
  plotScaleOf,
  plottedScoreOf,
  scoreTextClassOf,
  scoreTextOf,
  subjectColorOf,
} from "../lib/score-chart";
import type { SubjectScoreBarItem } from "../types";

const props = defineProps<{ items: SubjectScoreBarItem[] }>();

/** 本次全部科目的绘图值 → 放大基准 */
const plotScale = computed(() =>
  plotScaleOf(
    props.items
      .map((item) => plottedScoreOf(item.score))
      .filter((value): value is number => value !== null)
  )
);

/** 横条长度占比：按放大基准折算（无数字分 → 0，不画条） */
function widthOf(item: SubjectScoreBarItem): string {
  const value = plottedScoreOf(item.score);
  if (value === null) return "0%";
  return `${Math.round(plotRatioOf(value, plotScale.value) * 100)}%`;
}

function titleOf(item: SubjectScoreBarItem): string {
  return `${item.subject} ${scoreTextOf(item)}`;
}
</script>

<template>
  <div class="space-y-2" data-test="subject-score-hbar">
    <div
      v-for="item in props.items"
      :key="item.subject"
      data-test="score-hbar-row"
      class="flex items-center gap-3"
      :title="titleOf(item)"
    >
      <span class="w-16 shrink-0 truncate text-caption text-ink" :title="item.subject">
        {{ item.subject }}
      </span>
      <span class="h-3.5 min-w-0 flex-1 overflow-hidden rounded-pill bg-divider">
        <span
          v-if="item.score !== null && item.score !== undefined"
          data-test="score-hbar"
          :data-subject="item.subject"
          :data-score="plottedScoreOf(item.score)"
          class="block h-full rounded-pill transition-[width] duration-300"
          :style="{ width: widthOf(item), backgroundColor: subjectColorOf(props.items, item.subject) }"
        />
      </span>
      <span
        data-test="score-hbar-value"
        class="w-16 shrink-0 text-right text-caption"
        :class="scoreTextClassOf(item.score)"
      >
        {{ scoreTextOf(item) }}
      </span>
    </div>
  </div>
</template>