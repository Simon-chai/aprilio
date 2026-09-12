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
