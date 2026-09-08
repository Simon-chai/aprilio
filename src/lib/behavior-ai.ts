/**
 * AI 动态推荐评语（spec §3.2）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 轻量推理，生成 2 条 ≤25 字短语
 * - 结果按「维度 + 倾向」缓存（默认 3 天）：切倾向 / 换学生直接复用，隔几天才换一批
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 回落该维度「历史高频评语」，录入永不阻塞
 * - 采纳的推荐保存后由 db.addBehaviorRecord 沉淀为 source='ai' 词条
 */
import { loadAiConfig, isAiConfigured } from "./ai";
import { isTauri } from "./db";
import { createLlm } from "../agent/providers";
import type { AgentLlm, AgentMessage } from "../agent/types";
import type { BehaviorPolarity } from "../types";
import { BEHAVIOR_POLARITY_LABEL } from "../types";

export const AI_COMMENT_MAX_LEN = 25;

export interface RecommendContext {
  studentName: string;
  dimensionName: string;
  /** 维度 id（缓存键优先用它，避免重名维度串缓存）；不传则退回 dimensionName */
  dimensionId?: number;
  polarity: BehaviorPolarity;
  /** 该维度历史高频评语正文：风格参考 + 回落候选 */
  frequent: string[];
}

export interface RecommendResult {
  items: string[];
  source: "ai" | "preset";
}

/* ------------------------------------------------------------------ */
/* 推荐结果缓存：同一「维度 + 倾向」几天内复用，避免反复切卡片烧 token     */
/* ------------------------------------------------------------------ */

/** 缓存有效期：3 天。到期后再次打开才重新请求模型，自然形成「隔几天换一批」。 */
export const AI_COMMENT_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const CACHE_STORAGE_KEY = "aprilio.behavior.ai.comments";

interface CachedSuggestion {
  items: string[];
  /** 生成时间戳（毫秒） */
  at: number;
}

type SuggestionCache = Record<string, CachedSuggestion>;

function readCacheStore(): SuggestionCache {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as SuggestionCache;
  } catch {
    return {};
  }
}

function writeCacheStore(store: SuggestionCache): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 存储不可用不影响推荐主流程
  }
}

/** 缓存键：维度（优先 id，回退名称）+ 倾向。跨学生共享，同一批推荐供全班复用。 */
function cacheKey(ctx: RecommendContext): string {
  return `${ctx.dimensionId ?? ctx.dimensionName}::${ctx.polarity}`;
}

/** 读取未过期的缓存推荐；无缓存 / 已过期返回 null。 */
export function readCachedComments(
  ctx: RecommendContext,
  now = Date.now(),
  ttl = AI_COMMENT_CACHE_TTL_MS
): string[] | null {
  const entry = readCacheStore()[cacheKey(ctx)];
  if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) return null;
  if (now - entry.at > ttl) return null;
  return entry.items;
}

/** 写入缓存推荐（空结果不写）。 */
export function writeCachedComments(ctx: RecommendContext, items: string[], now = Date.now()): void {
  if (!items.length) return;
  const store = readCacheStore();
  store[cacheKey(ctx)] = { items: [...items], at: now };
  writeCacheStore(store);
}

/** 清空推荐缓存（单测 / 需要强制换一批时用）。 */
export function clearCommentCache(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

const SYSTEM_PROMPT =
  "你是一位经验丰富的小学班主任助手，擅长用简短、具体、措辞得体的中文评语记录学生日常表现。" +
  "写作要求：1）语气必须严格贴合老师指定的「评价倾向」，不同倾向不得混用；" +
  "2）每条评语不超过 25 个字；3）一行一条，只输出评语本身，不要编号、引号、前缀或任何解释。";

/**
 * 每种评价倾向对应的语气约束与参考示例。
 * 明确写出「禁止项」是为了压住小模型偷懒——否则不同倾向容易产出同一批表扬式评语。
 */
const POLARITY_TONE: Record<BehaviorPolarity, { tone: string; sample: string }> = {
  praise: {
    tone: "正面肯定学生的优点与进步，语气积极、鼓励",
    sample: "课堂听讲专注，主动举手回答问题",
  },
  improve: {
    tone: "委婉指出需要改进之处，语气建设性、不打击学生，禁止出现表扬或夸奖的措辞",
    sample: "作业字迹较潦草，建议放慢速度认真书写",
  },
  neutral: {
    tone: "只客观陈述事实与状态，不使用褒扬或批评的措辞",
    sample: "今日作业按时提交，完成情况一般",
  },
};

/**
 * 解析模型输出为干净短语：
 * 兼容编号 / 项目符号 / 中西引号包裹，超长截断，去空去重，最多取 max 条。
 */
export function parseAiComments(raw: string, max = 2, maxLen = AI_COMMENT_MAX_LEN): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const rawLine of raw.split(/\r?\n|；|;/)) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line
      .replace(/^[0-9①-⑩]+[.、)．:：]\s*/, "")
      .replace(/^[-·•*]+\s*/, "")
      .replace(/^[「“"'『【\[]+/, "")
      .replace(/[」”"'』】\]]+$/, "")
      .trim();
    if (!line) continue;
    if (line.length > maxLen) line = line.slice(0, maxLen);
    if (seen.has(line)) continue;
    seen.add(line);
    items.push(line);
    if (items.length >= max) break;
  }
  return items;
}

function buildMessages(ctx: RecommendContext): AgentMessage[] {
  const label = BEHAVIOR_POLARITY_LABEL[ctx.polarity];
  const { tone, sample } = POLARITY_TONE[ctx.polarity];
  const frequent = ctx.frequent.slice(0, 6).join("；") || "暂无";
  return [
    {
      role: "user",
      content: [
        `【评价倾向】${label}：${tone}`,
        `【参考示例】${sample}`,
        `【学生姓名】${ctx.studentName}`,
        `【评价维度】${ctx.dimensionName}`,
        `【该维度常用评语（仅供用词参考，不要照抄）】${frequent}`,
        `请生成 2 条「${label}」倾向的评语，语气必须严格符合上面的要求。`,
      ].join("\n"),
    },
  ];
}

/**
 * 生成推荐评语。
 * options.llm / options.aiReady 主要供单测注入替身；默认按运行环境自动判断。
 */
export async function recommendComments(
  ctx: RecommendContext,
  options: { llm?: AgentLlm; aiReady?: boolean; useCache?: boolean } = {}
): Promise<RecommendResult> {
  const fallback = (): RecommendResult => ({
    items: ctx.frequent.slice(0, 2),
    source: "preset",
  });
  const useCache = options.useCache !== false;

  // 命中未过期缓存直接复用：切倾向 / 换学生不再重复请求模型
  if (useCache) {
    const cached = readCachedComments(ctx);
    if (cached) return { items: cached, source: "ai" };
  }

  let config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return fallback();

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: SYSTEM_PROMPT,
      messages: buildMessages(ctx),
      tools: [],
      config,
    });
    const items = parseAiComments(res.content);
    if (items.length) {
      if (useCache) writeCachedComments(ctx, items);
      return { items, source: "ai" };
    }
  } catch {
    // AI 不可用不阻塞录入，静默回落高频评语
  }
  return fallback();
}
