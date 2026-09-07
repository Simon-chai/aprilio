/**
 * AI 动态推荐评语（spec §3.2）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 轻量推理，生成 2 条 ≤25 字短语
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
  polarity: BehaviorPolarity;
  /** 该维度历史高频评语正文：风格参考 + 回落候选 */
  frequent: string[];
}

export interface RecommendResult {
  items: string[];
  source: "ai" | "preset";
}

const SYSTEM_PROMPT =
  "你是一位经验丰富的小学班主任助手。根据学生与场景生成简短、具体、措辞得体的中文评语：每条不超过 25 个字，一行一条，只输出评语本身，不要编号、引号或其他任何解释。";

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
  const polarityText =
    ctx.polarity === "praise"
      ? "表扬（正向鼓励）"
      : ctx.polarity === "improve"
        ? `待改进（委婉提醒，${BEHAVIOR_POLARITY_LABEL.improve}）`
        : `中立（客观描述，不带褒贬，${BEHAVIOR_POLARITY_LABEL.neutral}）`;
  const frequent = ctx.frequent.slice(0, 6).join("；") || "暂无";
  return [
    {
      role: "user",
      content: [
        `学生姓名：${ctx.studentName}`,
        `评价维度：${ctx.dimensionName}`,
        `评价倾向：${polarityText}`,
        `该维度已有常用评语（风格参考，避免重复）：${frequent}`,
        "请生成 2 条新的推荐评语。",
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
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<RecommendResult> {
  const fallback = (): RecommendResult => ({
    items: ctx.frequent.slice(0, 2),
    source: "preset",
  });

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
    if (items.length) return { items, source: "ai" };
  } catch {
    // AI 不可用不阻塞录入，静默回落高频评语
  }
  return fallback();
}
