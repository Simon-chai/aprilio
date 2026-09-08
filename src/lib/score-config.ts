/**
 * 分数 → 等级 映射规则（成绩页「等级映射」配置）。
 *
 * 设计约定：成绩只存真实分数，等级不落库——每次展示都用这里的规则现算，
 * 所以改阈值/改名后，班级统计、个人面板、AI 分析口径同步生效。
 *
 * 持久化：本机 localStorage（与 AI 配置同一套，纯本地、不同步云端）。
 */
import { ref } from "vue";
import {
  DEFAULT_SCORE_LEVEL_BANDS,
  levelLabelOf,
  scoreLevelOf,
  scoreLinesOf,
  type ScoreLines,
} from "./score-analysis";
import type { ScoreLevel, ScoreLevelBand, ScoreLevelConfig } from "../types";

const STORAGE_KEY = "aprilio.score.levels";

/** 等级顺序（保存时按此顺序补齐缺失档位） */
const LEVEL_ORDER: ScoreLevel[] = ["excellent", "good", "pass", "fail"];

export const DEFAULT_SCORE_LEVEL_CONFIG: ScoreLevelConfig = {
  bands: DEFAULT_SCORE_LEVEL_BANDS.map((b) => ({ ...b })),
};

/** 规范化：补齐四档、阈值夹在 0~100、按 min 降序、标签去空白兜底 */
export function normalizeScoreLevelConfig(input: unknown): ScoreLevelConfig {
  const raw = (input ?? {}) as Partial<ScoreLevelConfig>;
  const byKey = new Map<ScoreLevel, ScoreLevelBand>();
  for (const band of Array.isArray(raw.bands) ? raw.bands : []) {
    if (!band || !LEVEL_ORDER.includes(band.key)) continue;
    const min = Math.max(0, Math.min(100, Math.round(Number(band.min))));
    const label = String(band.label ?? "").trim();
    byKey.set(band.key, {
      key: band.key,
      label: label || DEFAULT_SCORE_LEVEL_CONFIG.bands.find((b) => b.key === band.key)!.label,
      min: Number.isFinite(min) ? min : 0,
    });
  }
  const bands = LEVEL_ORDER.map(
    (key) => byKey.get(key) ?? { ...DEFAULT_SCORE_LEVEL_CONFIG.bands.find((b) => b.key === key)! }
  ).sort((a, b) => b.min - a.min);
  return { bands };
}

function load(): ScoreLevelConfig {
  if (typeof localStorage === "undefined") return normalizeScoreLevelConfig(DEFAULT_SCORE_LEVEL_CONFIG);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeScoreLevelConfig(DEFAULT_SCORE_LEVEL_CONFIG);
    return normalizeScoreLevelConfig(JSON.parse(raw));
  } catch {
    return normalizeScoreLevelConfig(DEFAULT_SCORE_LEVEL_CONFIG);
  }
}

/** 当前生效的等级映射（响应式，界面改完立即刷新） */
export const scoreLevelConfig = ref<ScoreLevelConfig>(load());

export function saveScoreLevelConfig(config: ScoreLevelConfig): void {
  const normalized = normalizeScoreLevelConfig(config);
  scoreLevelConfig.value = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* 存储不可用（隐私模式 / 超配额）时只留内存态 */
  }
}

export function resetScoreLevelConfig(): void {
  saveScoreLevelConfig(DEFAULT_SCORE_LEVEL_CONFIG);
}

/* ------------------------------------------------------------------ */
/* 派生能力（界面与导入共用同一份规则）                                    */
/* ------------------------------------------------------------------ */

/** 分数 → 档位 */
export function levelOf(score: number | null | undefined): ScoreLevel | null {
  return scoreLevelOf(score, scoreLevelConfig.value.bands);
}

/** 档位 → 展示名 */
export function levelNameOf(level: ScoreLevel | null): string {
  return levelLabelOf(level, scoreLevelConfig.value.bands);
}

/** 分数 → 展示名（如 92 → 优秀） */
export function levelNameOfScore(score: number | null | undefined): string {
  const level = levelOf(score);
  return level ? levelNameOf(level) : "";
}

/** 统计口径的及格线 / 优秀线 */
export function scoreLines(): ScoreLines {
  return scoreLinesOf(scoreLevelConfig.value.bands);
}

/** 常见等级写法 → 档位 key（用于等级制成绩单反推代表分） */
const LEVEL_ALIASES: Record<string, ScoreLevel> = {
  优: "excellent",
  优秀: "excellent",
  优异: "excellent",
  a: "excellent",
  良: "good",
  良好: "good",
  较好: "good",
  b: "good",
  中: "pass",
  合格: "pass",
  及格: "pass",
  c: "pass",
  差: "fail",
  不合格: "fail",
  待提高: "fail",
  待合格: "fail",
  d: "fail",
};

/**
 * 等级文字 → 代表分（导入等级制成绩单时把等级折算成真实分数落库）。
 * - 命中配置的档位名或常见别名 → 该档 min（最低档 min 为 0 时取 50，避免总分被清零）；
 * - 非等级文字（缺考/免考/作弊等）→ null，仍按原文字保留在 grade。
 */
export function representativeScoreOf(raw: string): number | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const bands = scoreLevelConfig.value.bands;
  const key =
    bands.find((b) => b.label === text)?.key ??
    LEVEL_ALIASES[text] ??
    LEVEL_ALIASES[text.toLowerCase()];
  if (!key) return null;
  const band = bands.find((b) => b.key === key);
  if (!band) return null;
  return band.min === 0 ? 50 : band.min;
}
