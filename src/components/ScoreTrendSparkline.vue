<script setup lang="ts">
/**
 * 迷你成绩趋势折线图（班级概览卡内嵌用）。
 *
 * 与 ScoreLineChart 的差别：只画一条折线（各次考试的班级平均单科分）、
 * 无坐标轴与悬浮交互，纵轴按数据自动收紧，宽度随卡片自适应——
 * 目标是「一眼看出走势」，细节看图请进「考试成绩」Tab。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** 趋势点（按时间正序）：label 供无障碍说明，value 为 null 表示该次无数字分（断线） */
    points: { label: string; value: number | null }[];
    /** 纵轴下限（默认按数据自动取） */
    min?: number | null;
    /** 纵轴上限（默认按数据自动取） */
    max?: number | null;
    /** 绘图区高度（px） */
    height?: number;
  }>(),
  { min: null, max: null, height: 56 }
);

const PAD = { l: 4, r: 8, t: 8, b: 8 };
/** 兜底宽度：jsdom 等无 ResizeObserver 的环境按此渲染 */
const FALLBACK_W = 320;
/** 同一页面可能挂多个实例，渐变 id 必须唯一 */
let uid = 0;

const gradientId = `score-spark-${++uid}`;
const wrapRef = ref<HTMLElement | null>(null);
const width = ref(FALLBACK_W);

let observer: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !wrapRef.value) return;
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (w > 0) width.value = Math.round(w);
  });
  observer.observe(wrapRef.value);
});
onBeforeUnmount(() => observer?.disconnect());

const plotW = computed(() => Math.max(24, width.value - PAD.l - PAD.r));
const plotH = computed(() => Math.max(16, props.height - PAD.t - PAD.b));

/** 纵轴范围：按数据自动收紧（与 ScoreLineChart 同口径，常规百分制不越过 0~100） */
const domain = computed<[number, number]>(() => {
  const values = props.points
    .map((p) => p.value)
    .filter((v): v is number => v !== null && !Number.isNaN(v));
  if (!values.length) return [0, 100];

  let lo = props.min ?? Math.min(...values);
  let hi = props.max ?? Math.max(...values);
  if (lo === hi) {
    lo -= 5;
    hi += 5;
  } else {
    const padding = Math.max((hi - lo) * 0.25, 2);
    lo -= padding;
    hi += padding;
  }
  if (values.every((v) => v <= 100)) {
    lo = Math.max(lo, 0);
    hi = Math.min(hi, 100);
  }
  if (hi - lo < 1) hi = lo + 1;
  return [lo, hi];
});

function xOf(index: number): number {
  const n = props.points.length;
  if (n <= 1) return PAD.l + plotW.value / 2;
  return PAD.l + (index / (n - 1)) * plotW.value;
}

function yOf(value: number): number {
  const [lo, hi] = domain.value;
  const clamped = Math.min(hi, Math.max(lo, value));
  return PAD.t + (1 - (clamped - lo) / (hi - lo)) * plotH.value;
}

interface SparkPoint {
  x: number;
  y: number;
  value: number;
}

/** 有分数的点；null 位置留空，用来把折线断开 */
const plotPoints = computed<(SparkPoint | null)[]>(() =>
  props.points.map((p, i) => {
    if (p.value === null || Number.isNaN(p.value)) return null;
    return { x: xOf(i), y: yOf(p.value), value: p.value };
  })
);

/** 连续段：每段一条折线（只有 1 个点的段退化为圆点） */
const segments = computed<SparkPoint[][]>(() => {
  const out: SparkPoint[][] = [];
  let current: SparkPoint[] = [];
  for (const point of plotPoints.value) {
    if (!point) {
      if (current.length) out.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length) out.push(current);
  return out;
});

/** 末端高亮点：最近一次有分数的考试 */
const lastPoint = computed<SparkPoint | null>(() => {
  for (let i = plotPoints.value.length - 1; i >= 0; i--) {
    const point = plotPoints.value[i];
    if (point) return point;
  }
  return null;
});

function linePoints(seg: SparkPoint[]): string {
  return seg.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** 面积路径：折线两端回落到基线闭合成面（单点段不画） */
function areaPath(seg: SparkPoint[]): string {
  if (seg.length < 2) return "";
  const base = (props.height - PAD.b).toFixed(1);
  const top = seg.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
  const first = seg[0]!;
  const last = seg[seg.length - 1]!;
  return `M ${top} L ${last.x.toFixed(1)} ${base} L ${first.x.toFixed(1)} ${base} Z`;
}

/** 无障碍说明：列出每次考试的均分 */
const ariaLabel = computed(() => {
  const parts = props.points
    .filter((p) => p.value !== null && !Number.isNaN(p.value))
    .map((p) => `${p.label} ${Math.round((p.value as number) * 10) / 10} 分`);
  return parts.length ? `班级成绩趋势：${parts.join("，")}` : "班级成绩趋势（暂无数据）";
});
</script>

<template>
  <div ref="wrapRef" class="w-full" data-test="score-trend-sparkline">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      class="block h-auto w-full"
      role="img"
      :aria-label="ariaLabel"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0066cc" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#0066cc" stop-opacity="0" />
        </linearGradient>
      </defs>

      <template v-for="(seg, si) in segments" :key="`seg-${si}`">
        <path v-if="seg.length > 1" :d="areaPath(seg)" :fill="`url(#${gradientId})`" stroke="none" />
        <polyline
          v-if="seg.length > 1"
          data-test="spark-line"
          :points="linePoints(seg)"
          fill="none"
          stroke="#0066cc"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <circle v-else :cx="seg[0]!.x" :cy="seg[0]!.y" r="3" fill="#0066cc" />
      </template>

      <g v-if="lastPoint">
        <circle
          :cx="lastPoint.x"
          :cy="lastPoint.y"
          r="6"
          fill="none"
          stroke="#0066cc"
          stroke-opacity="0.25"
        />
        <circle
          data-test="spark-last-point"
          :cx="lastPoint.x"
          :cy="lastPoint.y"
          r="3"
          fill="#0066cc"
        />
      </g>
    </svg>
  </div>
</template>
