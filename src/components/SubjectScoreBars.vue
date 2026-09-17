<script setup lang="ts">
/**
 * 各科成绩柱状图（可复用）：一组 = 一次考试场次，组内每个科目一根柱子。
 *
 * 两处使用（渲染规则同源，口径见 lib/score-analysis.ts）：
 * - 学生详情页「成绩」栏目：场次芯片选定一场后铺满卡片展示该场各科（fill）；
 * - 班级成绩明细表：跟随鼠标的悬浮卡片里展示该生单场各科（compact + fill）。
 *
 * 取值口径与成绩面板一致：柱高按本次分数区间放大（基准线不钉在 0 分，见 lib/score-chart.ts），
 * 柱色按「科目」取共享配色（跨场次同科同色，与折线图同色），分数文本按等级着色；
 * 等级制 / 缺考等无数字分的科目不画柱，只显示文字。
 *
 * 等级模式（成绩页「等级映射 → 显示等级」开启）：柱顶显示等级名、柱高按档位
 * 代表值（该档最低分）画——同等级等高，不同档拉开距离。
 */
import { computed } from "vue";
import { chartColorOf } from "../lib/chart-palette";
import {
  hasNumericScore,
  plotRatioOf,
  plotScaleOf,
  plottedScoreOf,
  scoreTextClassOf,
  scoreTextOf,
} from "../lib/score-chart";
import { formatNumber } from "../lib/score-analysis";
import { levelNameOfScore, showLevelOnly } from "../lib/score-config";
import type { SubjectScoreBarGroup, SubjectScoreBarItem } from "../types";

const props = withDefaults(
  defineProps<{
    /** 柱状图分组：每组一次考试（顺序即横轴顺序） */
    groups: SubjectScoreBarGroup[];
    /** 紧凑模式：悬浮卡片内使用，尺寸更小、隐藏图例 */
    compact?: boolean;
    /**
     * 铺满模式：组与科目列按可用宽度均分（柱子在列内居中），
     * 用于单场卡片——柱子均匀铺开，不再挤在一角；科目过多时转为横向滚动。
     */
    fill?: boolean;
    /** 是否显示组标签（场次名 + 日期）；卡片头部已有场次信息时关掉 */
    showLabel?: boolean;
    /** 是否显示图例里的口径说明；由宿主统一说明图表口径时关掉（如各科成绩分布图） */
    showHint?: boolean;
  }>(),
  { compact: false, fill: false, showLabel: true, showHint: true }
);

/** 柱区高度 / 柱宽 / 列宽（px）：紧凑模式整体收一档 */
const plotH = computed(() => (props.compact ? 72 : 112));
/**
 * 柱顶数值标签占的高度（text-fine 12px + 柱上方 mt-1 4px + 余量）。
 * 列高 = 柱区 + 标签高：不给标签留位置的话，flex 会把高分柱压扁——
 * 满 100 分的柱正好与列同高，标签一挤就变成「90 分和 100 分一样高」。
 */
const LABEL_H = 18;
const columnH = computed(() => plotH.value + LABEL_H);
const barW = computed(() => (props.compact ? 12 : 18));
const colW = computed(() => (props.compact ? 26 : 34));
/**
 * 柱宽上限：铺满模式下随列宽自适应但有上限（不拉成大方块）；
 * 非铺满模式即固定柱宽，与列宽配合保持紧凑外观。
 */
const maxBarW = computed(() => (props.fill ? (props.compact ? 22 : 32) : barW.value));
/** 铺满模式的列最小宽度（低于它就转横向滚动） */
const minColW = computed(() => (props.compact ? 34 : 48));
const innerGap = computed(() => (props.compact ? "4px" : "8px"));
const groupGap = computed(() => (props.fill ? "16px" : "20px"));

/** 全部场次出现过的科目（按首次出现顺序）→ 配色下标跨场次一致 */
const subjectNames = computed(() => {
  const seen: string[] = [];
  for (const group of props.groups) {
    for (const item of group.items) {
      if (!seen.includes(item.subject)) seen.push(item.subject);
    }
  }
  return seen;
});

function subjectColor(subject: string): string {
  const index = subjectNames.value.indexOf(subject);
  return chartColorOf(index < 0 ? 0 : index);
}

/** 全部柱子的绘图值 → 放大基准：基准线按本次分数区间上抬，柱高差异才看得出 */
const plotScale = computed(() => {
  const values: number[] = [];
  for (const group of props.groups) {
    for (const item of group.items) {
      const value = plottedScoreOf(item.score);
      if (value !== null) values.push(value);
    }
  }
  return plotScaleOf(values);
});

/** 柱高：按放大基准折算，最低留 4px 让 0 分也可见 */
function barHeight(score: number): string {
  return `${Math.max(4, Math.round(plotRatioOf(score, plotScale.value) * plotH.value))}px`;
}

function barTitle(item: SubjectScoreBarItem): string {
  if (hasNumericScore(item)) {
    return showLevelOnly.value
      ? `${item.subject} ${levelNameOfScore(item.score)}`
      : `${item.subject} ${formatNumber(item.score)} 分`;
  }
  return `${item.subject} ${item.grade ?? "无成绩"}`;
}
</script>

<template>
  <div data-test="subject-score-bars">
    <!-- 图例：科目 → 颜色（跨场次同科同色），紧凑模式省去 -->
    <div
      v-if="!compact && subjectNames.length"
      class="flex flex-wrap items-center gap-x-4 gap-y-1.5"
      data-test="subject-bars-legend"
    >
      <span
        v-for="(name, i) in subjectNames"
        :key="name"
        class="inline-flex items-center gap-1.5 text-fine text-muted"
      >
        <span class="inline-block h-2 w-2 shrink-0 rounded-[2px]" :style="{ backgroundColor: chartColorOf(i) }" />
        {{ name }}
      </span>
      <span v-if="showHint" class="ml-auto text-fine text-faint">
        {{ showLevelOnly ? "柱高按等级分档 · 同等级等高" : "柱高按本次分数区间放大" }}
      </span>
    </div>

    <div class="scroll-thin overflow-x-auto" :class="compact ? '' : 'mt-3'">
      <div class="flex items-start" :class="fill ? 'w-full' : ''" :style="{ gap: groupGap }">
        <div
          v-for="(group, gi) in groups"
          :key="`${group.label}-${gi}`"
          data-test="score-bar-group"
          class="flex flex-col"
          :class="fill ? 'min-w-0 flex-1' : 'shrink-0'"
          :style="fill ? { minWidth: `${group.items.length * minColW}px` } : {}"
        >
          <!-- 柱子区：底边对齐（0 分基线），每根柱上方标分数 / 等级文字 -->
          <div class="flex w-full items-end border-b border-hairline" :style="{ gap: innerGap }">
            <div
              v-for="item in group.items"
              :key="item.subject"
              data-test="score-bar-column"
              class="flex flex-col items-center justify-end"
              :class="fill ? 'min-w-0 flex-1' : ''"
              :style="{ height: `${columnH}px`, ...(fill ? {} : { width: `${colW}px` }) }"
              :title="barTitle(item)"
            >
              <span
                class="max-w-full truncate text-fine leading-none"
                :class="scoreTextClassOf(item.score)"
                data-test="score-bar-value"
              >
                {{ scoreTextOf(item) }}
              </span>
              <span
                v-if="hasNumericScore(item)"
                data-test="score-bar"
                :data-subject="item.subject"
                :data-score="plottedScoreOf(item.score)"
                class="mt-1 w-full shrink-0 rounded-t-[3px]"
                :style="{
                  maxWidth: `${maxBarW}px`,
                  height: barHeight(plottedScoreOf(item.score) ?? 0),
                  backgroundColor: subjectColor(item.subject),
                }"
              />
              <span v-else class="mt-1" style="height: 4px" />
            </div>
          </div>

          <!-- 科目名：与柱一一对齐 -->
          <div class="mt-1 flex w-full items-start" :style="{ gap: innerGap }">
            <span
              v-for="item in group.items"
              :key="item.subject"
              class="truncate text-center text-fine text-weak"
              :class="fill ? 'min-w-0 flex-1' : ''"
              :style="fill ? {} : { width: `${colW}px` }"
              :title="item.subject"
            >
              {{ item.subject }}
            </span>
          </div>

          <!-- 场次：考试名 + 日期 -->
          <template v-if="showLabel">
            <span class="mx-auto mt-1 max-w-[160px] truncate text-fine text-muted" :title="group.label">
              {{ group.label }}
            </span>
            <span v-if="group.sub" class="mx-auto text-fine text-faint">{{ group.sub }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
