<script setup lang="ts">
/**
 * 各科成绩辐射图（雷达图）：每科一条从圆心放射出去的轴线，越靠外分数越高。
 *
 * - 刻度按本次分数区间放大（圆心 = 区间下限、外环 = 上限，见 lib/score-chart.ts），四圈参考环；
 * - 顶点取共享调色板的科目色（与其他图同科同色），形状用主色描边 + 淡填充；
 * - 等级模式按档位代表值画，轴线标签显示等级名；
 * - 少于 3 门科目画不出多边形，这里给提示（缺考科目不占轴线，由宿主统一列出）。
 */
import { computed } from "vue";
import { CHART_AXIS_LINE, CHART_PRIMARY, CHART_TEXT_WEAK, chartColorOf } from "../lib/chart-palette";
import { hasNumericScore, plotRatioOf, plotScaleOf, plottedScoreOf, scoreTextOf } from "../lib/score-chart";
import type { SubjectScoreBarItem } from "../types";

const props = defineProps<{ items: SubjectScoreBarItem[] }>();

const SIZE_W = 320;
const SIZE_H = 320;
const CX = SIZE_W / 2;
const CY = SIZE_H / 2;
/** 轴线长度（0 分在圆心、100 分在外环） */
const R = 96;
/** 轴线标签离外环的距离 */
const LABEL_GAP = 22;

/** 参与画图的科目：缺考等无数字分不占轴线 */
const axes = computed(() =>
  props.items
    .filter((item) => hasNumericScore(item))
    .map((item, index) => ({ item, color: chartColorOf(index) }))
);

const RINGS = [0.25, 0.5, 0.75, 1];

/** 第 i 条轴线的角度（12 点方向为起点，顺时针均匀分布） */
function angleOf(index: number): number {
  return (360 / axes.value.length) * index;
}

/** 角度 + 半径比 → 坐标 */
function pointAt(index: number, ratio: number, radius = R): { x: number; y: number } {
  const rad = ((angleOf(index) - 90) * Math.PI) / 180;
  return { x: CX + radius * ratio * Math.cos(rad), y: CY + radius * ratio * Math.sin(rad) };
}

function ringPoints(ratio: number): string {
  return axes.value
    .map((_, index) => {
      const p = pointAt(index, ratio);
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");
}

/** 本次分数区间 → 放大基准（圆心 = 区间下限、外环 = 上限） */
const scale = computed(() =>
  plotScaleOf(
    axes.value
      .map((row) => plottedScoreOf(row.item.score))
      .filter((value): value is number => value !== null)
  )
);

/** 某科的半径比（0 = 圆心，1 = 外环） */
function ratioOf(item: SubjectScoreBarItem): number {
  const value = plottedScoreOf(item.score);
  return value === null ? 0 : plotRatioOf(value, scale.value);
}

/** 数据多边形：每科按放大后的半径比取点 */
const dataPoints = computed(() =>
  axes.value
    .map((row, index) => {
      const p = pointAt(index, ratioOf(row.item));
      return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ")
);

interface AxisLabel {
  subject: string;
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/** 轴线标签：按象限定锚点（右半左对齐、左半右对齐、正中居中） */
const labels = computed<AxisLabel[]>(() =>
  axes.value.map((row, index) => {
    const rad = ((angleOf(index) - 90) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const anchor: AxisLabel["anchor"] = cos > 0.2 ? "start" : cos < -0.2 ? "end" : "middle";
    const p = pointAt(index, 1, R + LABEL_GAP);
    return {
      subject: row.item.subject,
      text: scoreTextOf(row.item),
      x: p.x,
      // 正上 / 正下的标签各让开一点，避免压到轴线顶点
      y: p.y + (sin < -0.8 ? -8 : sin > 0.8 ? 16 : 4),
      anchor,
    };
  })
);
</script>

<template>
  <div data-test="subject-score-radar">
    <p v-if="axes.length < 3" class="py-6 text-center text-caption text-weak">
      只有 {{ axes.length }} 门科目有分数，辐射图至少要 3 门 —— 先用柱状图 / 条形图看吧。
    </p>

    <svg
      v-else
      :viewBox="`0 0 ${SIZE_W} ${SIZE_H}`"
      class="mx-auto h-auto w-[320px]"
      role="img"
      aria-label="各科成绩辐射图"
    >
      <!-- 参考环：25 / 50 / 75 / 100 分 -->
      <polygon
        v-for="ratio in RINGS"
        :key="`ring-${ratio}`"
        :points="ringPoints(ratio)"
        fill="none"
        stroke-width="1"
        :stroke="CHART_AXIS_LINE"
      />
      <!-- 轴线 -->
      <line
        v-for="(row, index) in axes"
        :key="`axis-${row.item.subject}`"
        :x1="CX"
        :y1="CY"
        :x2="pointAt(index, 1).x"
        :y2="pointAt(index, 1).y"
        stroke-width="1"
        :stroke="CHART_AXIS_LINE"
      />

      <!-- 数据多边形 + 各科顶点 -->
      <polygon
        data-test="score-radar-polygon"
        :points="dataPoints"
        :fill="CHART_PRIMARY"
        fill-opacity="0.15"
        :stroke="CHART_PRIMARY"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <circle
        v-for="(row, index) in axes"
        :key="`dot-${row.item.subject}`"
        data-test="score-radar-point"
        :data-subject="row.item.subject"
        :data-score="plottedScoreOf(row.item.score)"
        :cx="pointAt(index, ratioOf(row.item)).x"
        :cy="pointAt(index, ratioOf(row.item)).y"
        r="3.5"
        :fill="row.color"
      />

      <!-- 轴线标签：科目名 + 分值（等级模式为等级名） -->
      <g v-for="label in labels" :key="`label-${label.subject}`">
        <text
          :x="label.x"
          :y="label.y"
          :text-anchor="label.anchor"
          font-size="11"
          class="fill-ink"
        >
          {{ label.subject }}
        </text>
        <text
          :x="label.x"
          :y="label.y + 13"
          :text-anchor="label.anchor"
          font-size="10"
          :fill="CHART_TEXT_WEAK"
        >
          {{ label.text }}
        </text>
      </g>
    </svg>
  </div>
</template>