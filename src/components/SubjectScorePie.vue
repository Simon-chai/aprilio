<script setup lang="ts">
/**
 * 各科成绩饼状图：每科一个扇区，扇区角度 = 该科得分 ÷ 本次各科得分之和。
 *
 * - 口径与柱状图同源（见 lib/score-chart.ts）：等级模式按档位代表值折算；
 * - 扇区颜色取共享调色板（同科跨图同色），扇区之间留缝（不用描边色，浅底深底都不穿帮）；
 * - 科目名与分值、占比统一放右侧图例，扇区不塞文字（科目多也不糊）；
 * - 只有一个科目时画整圆；缺考科目由宿主统一列出。
 */
import { computed } from "vue";
import { subjectColorOf, plottedScoreOf, scoreTextClassOf, scoreTextOf, hasNumericScore } from "../lib/score-chart";
import type { SubjectScoreBarItem } from "../types";

const props = defineProps<{ items: SubjectScoreBarItem[] }>();

const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 104;
/** 相邻扇区之间的缝（度）：靠底色透出留白，避免给扇区描边额外引色 */
const GAP_DEG = 0.9;

interface Slice {
  subject: string;
  value: number;
  ratio: number;
  color: string;
  path: string;
}

/** 参与画扇区的科目（有数字分且大于 0；0 分画不出角度，只在图例里显示） */
const drawn = computed(() =>
  props.items
    .map((item) => ({ item, value: plottedScoreOf(item.score) }))
    .filter((row): row is { item: SubjectScoreBarItem; value: number } => row.value !== null && row.value > 0)
);

const totalValue = computed(() => drawn.value.reduce((sum, row) => sum + row.value, 0));

function pointOn(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

/** 从圆心到扇区两端的扇形路径（12 点方向为 0°，顺时针增大） */
function slicePath(startDeg: number, endDeg: number): string {
  const a = pointOn(startDeg, R);
  const b = pointOn(endDeg, R);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${CX} ${CY} L ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${R} ${R} 0 ${largeArc} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)} Z`;
}

const slices = computed<Slice[]>(() => {
  const total = totalValue.value;
  if (!drawn.value.length || total <= 0) return [];
  let cursor = 0;
  return drawn.value.map((row) => {
    const sweep = (row.value / total) * 360;
    const start = cursor;
    cursor += sweep;
    // 单科目占满整圆：弧线退化，交给整圆分支画
    const path =
      drawn.value.length === 1
        ? ""
        : slicePath(start + Math.min(GAP_DEG, sweep * 0.2) / 2, cursor - Math.min(GAP_DEG, sweep * 0.2) / 2);
    return {
      subject: row.item.subject,
      value: row.value,
      ratio: row.value / total,
      color: subjectColorOf(props.items, row.item.subject),
      path,
    };
  });
});

const isFullCircle = computed(() => slices.value.length === 1);

/** 图例：参与画图 + 0 分的科目都列出（缺考科目由宿主说明） */
const legend = computed(() =>
  props.items
    .filter((item) => hasNumericScore(item))
    .map((item) => {
      const value = plottedScoreOf(item.score) ?? 0;
      const total = totalValue.value;
      return {
        subject: item.subject,
        text: scoreTextOf(item),
        toneClass: scoreTextClassOf(item.score),
        percent: total > 0 ? `${Math.round((value / total) * 100)}%` : "—",
        color: subjectColorOf(props.items, item.subject),
      };
    })
);

function percentOf(slice: Slice): string {
  return `${Math.round(slice.ratio * 100)}%`;
}
</script>

<template>
  <div data-test="subject-score-pie">
    <p v-if="!slices.length" class="py-6 text-center text-caption text-weak">
      本次考试没有可画扇区的分数（0 分 / 等级制 / 缺考科目不参与）。
    </p>

    <div v-else class="flex flex-wrap items-center gap-x-8 gap-y-4">
      <svg
        :viewBox="`0 0 ${SIZE} ${SIZE}`"
        class="h-auto w-[240px] shrink-0"
        role="img"
        aria-label="各科成绩饼状图"
      >
        <!-- 单科目：整圆 -->
        <circle
          v-if="isFullCircle"
          data-test="score-pie-slice"
          :data-subject="slices[0]?.subject"
          :data-score="slices[0]?.value"
          :cx="CX"
          :cy="CY"
          :r="R"
          :fill="slices[0]?.color"
        >
          <title>{{ slices[0]?.subject }}：100%</title>
        </circle>

        <!-- 多科目：扇区从 12 点方向顺时针铺开 -->
        <path
          v-for="slice in isFullCircle ? [] : slices"
          :key="slice.subject"
          data-test="score-pie-slice"
          :data-subject="slice.subject"
          :data-score="slice.value"
          :data-percent="Math.round(slice.ratio * 100)"
          :d="slice.path"
          :fill="slice.color"
        >
          <title>{{ slice.subject }}：{{ percentOf(slice) }}</title>
        </path>
      </svg>

      <div class="min-w-[260px] flex-1">
        <div class="grid grid-cols-2 gap-x-6 gap-y-2" data-test="score-pie-legend">
          <div
            v-for="row in legend"
            :key="row.subject"
            data-test="score-pie-legend-item"
            class="flex items-center gap-2"
          >
            <span
              class="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]"
              :style="{ backgroundColor: row.color }"
            />
            <span class="min-w-0 flex-1 truncate text-caption text-ink" :title="row.subject">
              {{ row.subject }}
            </span>
            <span class="shrink-0 text-caption font-medium" :class="row.toneClass">{{ row.text }}</span>
            <span class="w-10 shrink-0 text-right text-fine text-weak">{{ row.percent }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>