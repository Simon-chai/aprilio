/**
 * 成绩图表配色：科目成绩折线图（ScoreLineChart）与各科柱状图（SubjectScoreBars）共用，
 * 保证同一科目在不同图表里颜色一致。
 */
export const CHART_PALETTE = [
  "#0066cc",
  "#248a3d",
  "#d70015",
  "#c26a00",
  "#6b3fd1",
  "#0b7285",
  "#c2185b",
  "#5f7d00",
];

/** 第 index 个科目（按首次出现顺序）的图表颜色；下标越界自动回绕 */
export function chartColorOf(index: number): string {
  return CHART_PALETTE[((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length];
}

/* —— 图表骨架色：canvas 读不到 CSS var，图表色以本文件为唯一事实源 —— */

/** 图表主色（选中参考线 / 迷你走势折线），与 @theme 的 --color-primary 同值 */
export const CHART_PRIMARY = "#0066cc";

/** 图表弱化文字（纵轴刻度 / 班级均分参照线），与 @theme 的 --color-weak 同值 */
export const CHART_TEXT_WEAK = "#7a7a7a";

/** 坐标轴网格线（ScoreLineChart 纵向刻度线） */
export const CHART_AXIS_LINE = "#e5e5e7";

/** 坐标轴次要文字（横轴日期副标签） */
export const CHART_AXIS_TEXT = "#a1a1a6";
