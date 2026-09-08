<script setup lang="ts">
/**
 * 科目成绩折线图（纯 SVG，无图表库）。
 *
 * - 每条折线 = 一个科目；横轴 = 按考试时间正序排列的考试；
 * - 缺考的科目在折线上断开（不跨点连线），单点考试只画圆点；
 * - 纵轴范围按数据自动收紧（不再固定 0~100），让折线在上下限之间铺开、区分度更高；
 * - 交互命中按「列」划分：整列都是热区，取离光标最近的点，
 *   所以节点再密也能选中；悬浮提示「哪次考试 + 分数」，点击展开该次考试详情。
 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** 横轴：每次考试的标签（label 为轴上的短标签，full 为悬浮时的完整名，sub 为日期） */
    labels: { label: string; sub?: string; full?: string }[];
    /** 每条折线：科目名 + 与 labels 对齐的分数（null 表示该次缺考） */
    series: { name: string; values: (number | null)[] }[];
    /** 与 labels 对齐的考试 ID，用于给热区打 data 属性方便定位 */
    ids?: (number | string)[];
    /** 当前选中的考试下标（高亮对应列与节点） */
    selectedIndex?: number | null;
    /** 纵轴下限，默认按数据自动取 */
    min?: number | null;
    /** 纵轴上限，默认按数据自动取 */
    max?: number | null;
  }>(),
  { selectedIndex: null, min: null, max: null }
);

const emit = defineEmits<{
  "point-click": [payload: { index: number; subject: string; score: number }];
}>();

const PAD = { l: 40, r: 18, t: 16, b: 48 };
const H = 240;
/** 相邻两次考试的最小水平间距：不够就横向滚动，避免节点挤在一起 */
const MIN_STEP = 78;
const MIN_PLOT_W = 520;
const plotH = H - PAD.t - PAD.b;

const plotW = computed(() =>
  Math.max(MIN_PLOT_W, Math.max(0, props.labels.length - 1) * MIN_STEP)
);
const W = computed(() => PAD.l + plotW.value + PAD.r);

/** 科目配色（与主题色系一致） */
const PALETTE = [
  "#0066cc",
  "#248a3d",
  "#d70015",
  "#c26a00",
  "#6b3fd1",
  "#0b7285",
  "#c2185b",
  "#5f7d00",
];

function colorOf(index: number): string {
  return PALETTE[index % PALETTE.length];
}

/**
 * 纵轴范围：按数据自动收紧，让折线尽量铺满绘图区。
 * 例：分数都在 92~97 → 纵轴取 90~100，而不是 0~100。
 */
const domain = computed<[number, number]>(() => {
  const values: number[] = [];
  for (const s of props.series) {
    for (const v of s.values) {
      if (v !== null && v !== undefined && !Number.isNaN(v)) values.push(v);
    }
  }
  if (!values.length) return [0, 100];

  const lo = props.min ?? Math.min(...values);
  const hi = props.max ?? Math.max(...values);
  if (lo === hi) return [Math.max(0, lo - 5), hi + 5];

  const span = hi - lo;
  const padding = Math.max(span * 0.2, 3);
  let lower = Math.floor((lo - padding) / 5) * 5;
  let upper = Math.ceil((hi + padding) / 5) * 5;

  // 窗口太窄会让折线上下剧烈跳动，至少留 15 分视野
  const MIN_WINDOW = 15;
  if (upper - lower < MIN_WINDOW) {
    const mid = (lo + hi) / 2;
    lower = Math.floor((mid - MIN_WINDOW / 2) / 5) * 5;
    upper = lower + MIN_WINDOW;
  }

  // 常规百分制不越过 100，且不跌破 0
  if (values.every((v) => v <= 100)) upper = Math.min(upper, 100);
  return [Math.max(0, lower), upper];
});

function yOf(value: number): number {
  const [lower, upper] = domain.value;
  const clamped = Math.min(upper, Math.max(lower, value));
  return PAD.t + (1 - (clamped - lower) / (upper - lower)) * plotH;
}

function xOf(index: number): number {
  const n = props.labels.length;
  if (n <= 1) return PAD.l + plotW.value / 2;
  return PAD.l + (index / (n - 1)) * plotW.value;
}

/** 每列的宽度（用于划分悬浮 / 点击热区） */
const bandW = computed(() =>
  props.labels.length <= 1 ? plotW.value : plotW.value / (props.labels.length - 1)
);

function bandX(index: number): number {
  return Math.max(PAD.l, xOf(index) - bandW.value / 2);
}

function bandWidth(index: number): number {
  const right = Math.min(PAD.l + plotW.value, xOf(index) + bandW.value / 2);
  return Math.max(0, right - bandX(index));
}

/** 纵轴刻度：用「好看」的步长，并保证上下限都出现在轴上 */
const ticks = computed(() => {
  const [lo, hi] = domain.value;
  const raw = (hi - lo) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = new Set<number>([lo, hi]);
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.add(Number(v.toFixed(1)));
  }
  return [...out].sort((a, b) => a - b);
});

/** 把一条折线按 null 断开成若干连续段（每段为 SVG points 字符串） */
function segmentsOf(values: (number | null)[]): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  return segments.filter((seg) => seg.includes(" "));
}

interface ChartPoint {
  index: number;
  x: number;
  y: number;
  v: number;
}

function pointsOf(values: (number | null)[]): ChartPoint[] {
  const points: ChartPoint[] = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    points.push({ index, x: xOf(index), y: yOf(value), v: value });
  });
  return points;
}

/* ---------------- 命中判定：整列热区 + 最近点 ---------------- */

const svgRef = ref<SVGSVGElement | null>(null);

interface Hit {
  point: ChartPoint;
  subject: string;
}

/** 某次考试上所有有分数的科目点 */
function candidatesAt(index: number): Hit[] {
  const out: Hit[] = [];
  props.series.forEach((s) => {
    const value = s.values[index];
    if (value === null || value === undefined || Number.isNaN(value)) return;
    out.push({
      point: { index, x: xOf(index), y: yOf(value), v: value },
      subject: s.name,
    });
  });
  return out;
}

/** 在该列内取离光标最近的点（同一列上下移动可切换科目） */
function nearestAt(index: number, clientY: number): Hit | null {
  const candidates = candidatesAt(index);
  if (!candidates.length) return null;
  const rect = svgRef.value?.getBoundingClientRect();
  if (!rect || rect.height === 0) return candidates[0];
  const svgY = ((clientY - rect.top) * H) / rect.height;
  return candidates.reduce((best, c) =>
    Math.abs(c.point.y - svgY) < Math.abs(best.point.y - svgY) ? c : best
  );
}

/* ---------------- 悬浮提示 ---------------- */

interface HoverInfo {
  left: number;
  top: number;
  index: number;
  exam: string;
  date: string;
  subject: string;
  score: number;
}

const hover = ref<HoverInfo | null>(null);

function onBandMove(index: number, event: MouseEvent) {
  const hit = nearestAt(index, event.clientY);
  if (!hit) return;
  const label = props.labels[index];
  const rect = (event.currentTarget as Element).getBoundingClientRect();
  hover.value = {
    left: rect.left + rect.width / 2,
    top: event.clientY,
    index,
    exam: label?.full ?? label?.label ?? "",
    date: label?.sub ?? "",
    subject: hit.subject,
    score: hit.point.v,
  };
}

function hideTip() {
  hover.value = null;
}

function onBandClick(index: number, event: MouseEvent) {
  const hit = nearestAt(index, event.clientY);
  if (!hit) return;
  emit("point-click", { index, subject: hit.subject, score: hit.point.v });
}
</script>

<template>
  <div data-test="score-line-chart">
    <!-- 图例 + 纵轴范围说明 -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <span
        v-for="(s, si) in series"
        :key="s.name"
        class="inline-flex items-center gap-1.5 text-fine text-muted"
      >
        <span
          class="inline-block h-2 w-2 shrink-0 rounded-full"
          :style="{ backgroundColor: colorOf(si) }"
        />
        {{ s.name }}
      </span>
      <span class="ml-auto text-fine text-faint" data-test="chart-domain">
        纵轴 {{ domain[0] }}~{{ domain[1] }}
      </span>
    </div>

    <div class="scroll-thin mt-2 overflow-x-auto">
      <div class="relative" :style="{ minWidth: `${W}px` }">
        <svg
          ref="svgRef"
          :viewBox="`0 0 ${W} ${H}`"
          class="h-auto w-full"
          role="img"
          aria-label="科目成绩折线图"
          @mouseleave="hideTip"
        >
          <!-- 网格与纵轴刻度 -->
          <g>
            <line
              v-for="t in ticks"
              :key="`grid-${t}`"
              :x1="PAD.l"
              :x2="PAD.l + plotW"
              :y1="yOf(t)"
              :y2="yOf(t)"
              stroke="#e5e5e7"
              stroke-width="1"
            />
            <text
              v-for="t in ticks"
              :key="`tick-${t}`"
              :x="PAD.l - 6"
              :y="yOf(t) + 3"
              text-anchor="end"
              font-size="10"
              fill="#7a7a7a"
            >
              {{ t }}
            </text>
          </g>

          <!-- 选中考试的竖向参考线 -->
          <line
            v-if="selectedIndex !== null && selectedIndex >= 0 && selectedIndex < labels.length"
            :x1="xOf(selectedIndex)"
            :x2="xOf(selectedIndex)"
            :y1="PAD.t"
            :y2="PAD.t + plotH"
            stroke="#0066cc"
            stroke-width="1"
            stroke-dasharray="3 3"
            opacity="0.5"
          />

          <!-- 整列热区：铺满绘图区高度，节点再密也能命中 -->
          <rect
            v-for="(l, i) in labels"
            :key="`band-${i}`"
            data-test="chart-band"
            :data-exam-id="ids?.[i]"
            :x="bandX(i)"
            :y="PAD.t"
            :width="bandWidth(i)"
            :height="plotH"
            :fill="hover && hover.index === i ? 'rgba(0,102,204,0.06)' : 'transparent'"
            :aria-label="l.label"
            class="cursor-pointer"
            @mouseenter="onBandMove(i, $event)"
            @mousemove="onBandMove(i, $event)"
            @click="onBandClick(i, $event)"
          />

          <!-- 折线 + 数据点 -->
          <g v-for="(s, si) in series" :key="s.name">
            <polyline
              v-for="(seg, gi) in segmentsOf(s.values)"
              :key="`seg-${si}-${gi}`"
              :points="seg"
              fill="none"
              :stroke="colorOf(si)"
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
            <g v-for="(p, pi) in pointsOf(s.values)" :key="`pt-${si}-${pi}`">
              <circle
                v-if="p.index === selectedIndex"
                :cx="p.x"
                :cy="p.y"
                r="7"
                fill="none"
                :stroke="colorOf(si)"
                stroke-width="1.5"
                pointer-events="none"
              />
              <circle
                data-test="chart-point"
                :data-exam-id="ids?.[p.index]"
                :data-subject="s.name"
                :cx="p.x"
                :cy="p.y"
                :r="p.index === selectedIndex ? 4 : 3"
                :fill="colorOf(si)"
                pointer-events="none"
              />
            </g>
          </g>

          <!-- 横轴考试标签 -->
          <g>
            <text
              v-for="(l, i) in labels"
              :key="`xlabel-${i}`"
              :x="xOf(i)"
              :y="H - PAD.b + 16"
              text-anchor="middle"
              font-size="10"
              fill="#7a7a7a"
            >
              {{ l.label }}
            </text>
            <text
              v-for="(l, i) in labels"
              :key="`xsublabel-${i}`"
              :x="xOf(i)"
              :y="H - PAD.b + 29"
              text-anchor="middle"
              font-size="10"
              fill="#a1a1a6"
            >
              {{ l.sub ?? "" }}
            </text>
          </g>
        </svg>

        <!-- 悬浮提示：哪次考试 + 该科分数（fixed 定位，不被横向滚动裁切） -->
        <div
          v-if="hover"
          data-test="chart-tooltip"
          class="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-ink px-2.5 py-1.5 text-fine leading-snug text-white shadow-window"
          :style="{ left: `${hover.left}px`, top: `${hover.top}px`, marginTop: '-10px' }"
        >
          <div class="font-medium">
            {{ hover.exam }}
            <span v-if="hover.date" class="ml-1 opacity-70">{{ hover.date }}</span>
          </div>
          <div class="opacity-90">{{ hover.subject }}：{{ hover.score }} 分</div>
        </div>
      </div>
    </div>
  </div>
</template>
