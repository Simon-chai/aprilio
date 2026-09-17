<script setup lang="ts">
/**
 * 各科成绩折线图：横轴为科目（按成绩单顺序），纵轴为分数，一点 + 一值标签。
 *
 * - 纵轴按本次分数区间放大差距（基准线不钉在 0 分，与柱状图同一套基准，见 lib/score-chart.ts）；
 * - 缺考科目折线断开、不画点（图下由宿主统一列出未计入科目）；
 * - 等级模式按档位代表值画（同档同一水平线），点标签显示等级名；
 * - 点色取共享调色板（与柱状图 / 饼状图同科同色），标签文字用中性色避免抢眼。
 */
import { computed } from "vue";
import { CHART_AXIS_LINE, CHART_TEXT_WEAK, chartColorOf } from "../lib/chart-palette";
import { plotRatioOf, plotScaleOf, plottedScoreOf, scoreTextOf } from "../lib/score-chart";
import { round1 } from "../lib/score-analysis";
import type { SubjectScoreBarItem } from "../types";

const props = defineProps<{ items: SubjectScoreBarItem[] }>();

const PAD = { l: 34, r: 18, t: 26, b: 44 };
const H = 240;
/** 相邻科目的最小水平间距：不够就横向滚动，科目名不挤在一起 */
const MIN_STEP = 96;
const MIN_PLOT_W = 480;
const plotH = H - PAD.t - PAD.b;

const plotW = computed(() => Math.max(MIN_PLOT_W, Math.max(0, props.items.length - 1) * MIN_STEP));
const W = computed(() => PAD.l + plotW.value + PAD.r);

/** 各科绘图值（等级模式 = 档位代表值；缺考 = null） */
const values = computed<(number | null)[]>(() => props.items.map((item) => plottedScoreOf(item.score)));
const drawnValues = computed(() => values.value.filter((v): v is number => v !== null));

/** 纵轴范围：按本次分数区间放大差距（与柱状图 / 条形图同一套基准） */
const scale = computed(() => plotScaleOf(drawnValues.value));

/** 纵轴刻度：下限 / 中值 / 上限三条，够读又不铺满 */
const ticks = computed(() => {
  const { floor, ceiling } = scale.value;
  return [...new Set([floor, round1((floor + ceiling) / 2), ceiling])];
});

function xOf(index: number): number {
  const n = props.items.length;
  if (n <= 1) return PAD.l + plotW.value / 2;
  return PAD.l + (index / (n - 1)) * plotW.value;
}

function yOf(value: number): number {
  return PAD.t + (1 - plotRatioOf(value, scale.value)) * plotH;
}

/** 缺考断线：连续有分的科目连成一段（不跨过缺考科目连线） */
const segments = computed<string[]>(() => {
  const out: string[] = [];
  let current: string[] = [];
  values.value.forEach((value, index) => {
    if (value === null) {
      if (current.length) out.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`);
  });
  if (current.length) out.push(current.join(" "));
  // 单点段没有连线可画（由数据点自己表达），只保留两点以上的段
  return out.filter((seg) => seg.includes(" "));
});

/** 横轴科目名：过长截断，完整名放 SVG 的 title 里 */
function shortName(name: string): string {
  return name.length > 5 ? `${name.slice(0, 5)}…` : name;
}
</script>

<template>
  <div data-test="subject-score-line">
    <p v-if="!drawnValues.length" class="py-6 text-center text-caption text-weak">
      本次考试没有可绘制的分数（等级制 / 缺考科目不参与画线）。
    </p>

    <div v-else class="scroll-thin overflow-x-auto">
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        class="h-auto w-full"
        :style="{ minWidth: `${W}px` }"
        role="img"
        aria-label="各科成绩折线图"
      >
        <!-- 纵轴刻度线 -->
        <g>
          <line
            v-for="t in ticks"
            :key="`grid-${t}`"
            :x1="PAD.l"
            :x2="PAD.l + plotW"
            :y1="yOf(t)"
            :y2="yOf(t)"
            stroke-width="1"
            :stroke="CHART_AXIS_LINE"
          />
          <text
            v-for="t in ticks"
            :key="`tick-${t}`"
            :x="PAD.l - 6"
            :y="yOf(t) + 3"
            text-anchor="end"
            font-size="10"
            :fill="CHART_TEXT_WEAK"
          >
            {{ t }}
          </text>
        </g>

        <!-- 折线（缺考断线） -->
        <polyline
          v-for="(seg, si) in segments"
          :key="`seg-${si}`"
          :points="seg"
          fill="none"
          :stroke="CHART_TEXT_WEAK"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
          stroke-dasharray="4 3"
          opacity="0.7"
        />

        <!-- 数据点 + 分值标签 + 科目名 -->
        <g v-for="(item, i) in props.items" :key="item.subject">
          <template v-if="plottedScoreOf(item.score) !== null">
            <circle
              data-test="score-line-point"
              :data-subject="item.subject"
              :data-score="plottedScoreOf(item.score)"
              :cx="xOf(i)"
              :cy="yOf(plottedScoreOf(item.score) as number)"
              r="4"
              :fill="chartColorOf(i)"
            />
            <text
              data-test="score-line-value"
              :x="xOf(i)"
              :y="yOf(plottedScoreOf(item.score) as number) - 10"
              text-anchor="middle"
              font-size="11"
              font-weight="600"
              class="fill-ink"
            >
              {{ scoreTextOf(item) }}
            </text>
          </template>
          <text
            :x="xOf(i)"
            :y="H - PAD.b + 18"
            text-anchor="middle"
            font-size="10"
            :fill="CHART_TEXT_WEAK"
          >
            {{ shortName(item.subject) }}
            <title>{{ item.subject }}</title>
          </text>
        </g>
      </svg>
    </div>
  </div>
</template>