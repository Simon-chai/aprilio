/**
 * 各科成绩分布的图表类型偏好（本机 localStorage，与等级映射同一套：纯本地、不同步云端）。
 *
 * 设计约定：类型是「看图的习惯」，全局只有一份 —— 在任一页面切换一次，
 * 所有展示各科成绩分布的页面（学生详情页「成绩」栏目等）立即同步换图，下次打开仍是它。
 */
import { ref } from "vue";

export type ScoreChartType = "bar" | "hbar" | "line" | "pie" | "radar";

/**
 * 可选类型：顺序即下拉里的顺序（默认柱状图，最贴近原来看法）。
 * hint 是图下的口径说明（不含具体刻度数字，刻度由数据算出来后由宿主拼上）。
 */
export const SCORE_CHART_TYPES: {
  value: ScoreChartType;
  label: string;
  hint: string;
}[] = [
  { value: "bar", label: "柱状图", hint: "柱高按本次分数区间放大，差距一眼可见" },
  { value: "hbar", label: "条形图", hint: "横条按本次分数区间放大，差距一眼可见" },
  { value: "line", label: "折线图", hint: "纵轴按本次分数区间收紧，起伏一眼可见" },
  { value: "pie", label: "饼状图", hint: "占比 = 该科得分 ÷ 本次各科得分之和（各科按满分 100 计）" },
  { value: "radar", label: "辐射图", hint: "圆周刻度按本次分数区间放大" },
];

const STORAGE_KEY = "aprilio.score.chartType";

/** 规范化：未知值一律回落柱状图（旧版本残留 / 手改 localStorage 都不崩） */
export function normalizeScoreChartType(input: unknown): ScoreChartType {
  return SCORE_CHART_TYPES.some((t) => t.value === input) ? (input as ScoreChartType) : "bar";
}

function load(): ScoreChartType {
  if (typeof localStorage === "undefined") return "bar";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeScoreChartType(JSON.parse(raw)) : "bar";
  } catch {
    return "bar";
  }
}

/** 当前生效的图表类型（响应式：切换后所有用到它的图形立即换图） */
export const scoreChartType = ref<ScoreChartType>(load());

export function setScoreChartType(next: ScoreChartType): void {
  const normalized = normalizeScoreChartType(next);
  scoreChartType.value = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* 存储不可用（隐私模式 / 超配额）时只留内存态 */
  }
}

/** 回到默认柱状图 */
export function resetScoreChartType(): void {
  setScoreChartType("bar");
}