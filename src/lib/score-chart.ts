/**
 * 各科成绩分布图的公共口径（柱状图 / 条形图 / 折线图 / 辐射图同源；饼状图只借配色与取值）。
 *
 * 三件事必须一致，否则同一场考试换个类型看就变样：
 * - 几何取值：等级模式取档位代表值（该档最低分，同等级同值），否则用真实分数；
 * - 放大基准：基准线不钉在 0 分，而是按本次各科分数区间动态上抬（见 plotScaleOf）；
 * - 展示文本：数字分（等级模式显示等级名）/ 文字分（缺考、免考…）；
 * - 科目配色：按科目首次出现顺序取共享调色板，跨图表同科同色。
 */
import { chartColorOf } from "./chart-palette";
import { SCORE_LEVEL_TEXT, formatNumber } from "./score-analysis";
import { levelNameOfScore, levelOf, levelValueOf, showLevelOnly } from "./score-config";
import type { SubjectScoreBarItem } from "../types";

/** 是否有数字分（等级制 / 缺考等只有文字分的不算） */
export function hasNumericScore(item: Pick<SubjectScoreBarItem, "score">): boolean {
  return item.score !== null && item.score !== undefined;
}

/** 绘图取值：等级模式取档位代表值，否则原分数 */
export function plottedScoreOf(score: number | null | undefined): number | null {
  if (score === null || score === undefined) return null;
  return showLevelOnly.value ? levelValueOf(score) : score;
}

/** 成绩文本：分数 / 等级名 / 文字分（缺考…） */
export function scoreTextOf(item: SubjectScoreBarItem): string {
  if (hasNumericScore(item)) {
    return showLevelOnly.value ? levelNameOfScore(item.score) : formatNumber(item.score);
  }
  return item.grade ?? "—";
}

/** 成绩文本颜色：按档位着色（无档位回落弱化色） */
export function scoreTextClassOf(score: number | null | undefined): string {
  const level = levelOf(score);
  return level ? SCORE_LEVEL_TEXT[level] : "text-weak";
}

/** 科目颜色：按科目在数据里的首次出现顺序取共享调色板 */
export function subjectColorOf(items: { subject: string }[], subject: string): string {
  const seen: string[] = [];
  for (const item of items) {
    if (!seen.includes(item.subject)) seen.push(item.subject);
  }
  const index = seen.indexOf(subject);
  return chartColorOf(index < 0 ? 0 : index);
}

/* ------------------------------------------------------------------ */
/* 动态放大差距：绘图基准                                                    */
/* ------------------------------------------------------------------ */

/** 绘图基准（floor = 图上最底部代表的分数） */
export interface PlotScale {
  floor: number;
  ceiling: number;
}

/** 基准窗口的最小跨度（分）：分数挨得再近也拉开这么多，柱子之间才有可见差距 */
const MIN_WINDOW = 15;
/** 基准取整到 5 的倍数：90 / 85 / 80 这类刻度比 87.3 好读 */
const STEP = 5;

/**
 * 按本次各科分数区间算绘图基准，用来「放大差距」。
 *
 * 分数挤在高分段时若仍从 0 分起画，90 分与 100 分会长得一样高、看不出强弱：
 * 这里把基准线抬到最低分下方一点（留 25% 数据跨度、至少 5 分余量，取整到 5 分刻度），
 * 顶部取最高分上方一点（百分制不越过 100），窗口不足 15 分时按下限撑到 15 分。
 *
 * 例：[90, 100] → 85~100；[40, 50] → 35~55；只有 [95] → 85~100。
 */
export function plotScaleOf(values: number[]): PlotScale {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { floor: 0, ceiling: 100 };

  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const padding = Math.max((hi - lo) * 0.25, 5);

  let ceiling = Math.ceil((hi + padding) / STEP) * STEP;
  if (hi <= 100) ceiling = Math.min(100, ceiling);
  let floor = Math.max(0, Math.floor((lo - padding) / STEP) * STEP);

  if (ceiling - floor < MIN_WINDOW) {
    floor = Math.max(0, ceiling - MIN_WINDOW);
    if (ceiling - floor < MIN_WINDOW) ceiling = floor + MIN_WINDOW;
  }
  return { floor, ceiling };
}

/** 分数 → 绘图比例（0~1，夹在基准之内）；柱高 / 条形长度 / 纵轴坐标 / 辐射半径都用它 */
export function plotRatioOf(value: number, scale: PlotScale): number {
  const span = scale.ceiling - scale.floor;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - scale.floor) / span));
}

/** 未计入图表的科目（缺考等无数字分）→ 图下说明文案，如「物理（缺考）」 */
export function skippedSubjectTexts(items: SubjectScoreBarItem[]): string[] {
  return items
    .filter((item) => !hasNumericScore(item))
    .map((item) => `${item.subject}（${item.grade ?? "无成绩"}）`);
}