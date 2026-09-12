<script setup lang="ts">
/**
 * 各科成绩柱状图（可复用）：一组 = 一次考试场次，组内每个科目一根柱子。
 *
 * 两处使用（渲染规则同源，口径见 lib/score-analysis.ts）：
 * - 学生详情页「成绩」栏目：场次芯片选定一场后铺满卡片展示该场各科（fill）；
 * - 班级成绩明细表：跟随鼠标的悬浮卡片里展示该生单场各科（compact + fill）。
 *
 * 取值口径与成绩面板一致：柱高 = 分数 / 100，柱色按「科目」取共享配色
 * （跨场次同科同色，与折线图同色），分数文本按等级着色；
 * 等级制 / 缺考等无数字分的科目不画柱，只显示文字。
 */
import { computed } from "vue";
import { chartColorOf } from "../lib/chart-palette";
import { SCORE_LEVEL_TEXT, formatNumber, scoreRatio } from "../lib/score-analysis";
import { levelOf } from "../lib/score-config";
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
  }>(),
  { compact: false, fill: false, showLabel: true }
);

/** 柱区高度 / 柱宽 / 列宽（px）：紧凑模式整体收一档 */
const plotH = computed(() => (props.compact ? 72 : 112));
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

/** 柱高：分数 / 满分 100，最低留 4px 让 0 分也可见 */
function barHeight(score: number): string {
  return `${Math.max(4, Math.round(scoreRatio(score) * plotH.value))}px`;
}

function hasScore(item: SubjectScoreBarItem): boolean {
  return item.score !== null && item.score !== undefined;
}

/** 柱顶文本：有数字分显示分数，否则显示「缺考」等文字 */
function valueText(item: SubjectScoreBarItem): string {
  return hasScore(item) ? formatNumber(item.score) : (item.grade ?? "—");
}

function valueClass(item: SubjectScoreBarItem): string {
  const level = levelOf(item.score);
  return level ? SCORE_LEVEL_TEXT[level] : "text-weak";
}

function barTitle(item: SubjectScoreBarItem): string {
  if (hasScore(item)) return `${item.subject} ${formatNumber(item.score)} 分`;
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
      <span class="ml-auto text-fine text-faint">柱高为该科分数 · 单科满分按 100 计</span>
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
              :style="{ height: `${plotH}px`, ...(fill ? {} : { width: `${colW}px` }) }"
              :title="barTitle(item)"
            >
              <span
                class="max-w-full truncate text-fine leading-none"
                :class="valueClass(item)"
                data-test="score-bar-value"
              >
                {{ valueText(item) }}
              </span>
              <span
                v-if="hasScore(item)"
                data-test="score-bar"
                :data-subject="item.subject"
                :data-score="item.score"
                class="mt-1 w-full rounded-t-[3px]"
                :style="{
                  maxWidth: `${maxBarW}px`,
                  height: barHeight(item.score ?? 0),
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
