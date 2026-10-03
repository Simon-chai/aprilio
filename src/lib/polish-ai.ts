/**
 * 通用 AI 文本润色（各输入框旁「AI 润色」按钮共用，spec：docs/PROMPT_MANAGEMENT.md）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 按【使用场景】润色原文
 * - 场景与上下文由每个调用点提供（ui/AiPolishButton 的 props），本库不认识具体业务：
 *   新增人工 / 语音输入时说清 scene 即可复用，提示词统一走模块 content.text-polish
 * - 浏览器演示态 / 未配置模型 → isAiPolishReady 为 false，按钮置灰并说明原因
 * - 调用失败 → 抛出友好错误（aiErrorMessage 压平），由组件 toast，原文保持不动
 * 隐私：仅把老师手输的这段文字与场景说明发给用户自己配置的模型服务，不写日志。
 */
import { aiErrorMessage, isAiConfigured, loadAiConfig } from "./ai";
import { isTauri } from "./env";
import { createLlm } from "../agent/providers";
import { PROMPT_IDS, resolvePrompt } from "../prompts";
import type { AgentLlm, AgentMessage } from "../agent/types";

/** 一次润色的输入：场景说清楚，模型才知道这段文字写在哪、给谁看 */
export interface PolishContext {
  /** 使用场景名（必填），如「作业备注」「学生期末评语」 */
  scene: string;
  /** 场景补充说明：这个框里的文字写给谁看、用来做什么，可空 */
  hint?: string;
  /** 本次输入相关的业务信息（学生姓名 / 科目等），只作背景参考，可空 */
  context?: string;
  /** 待润色的原文（调用方保证非空） */
  text: string;
}

/** AI 润色是否可用：桌面端且当前模型方案已配置。组件据此置灰按钮 */
export function isAiPolishReady(config = loadAiConfig()): boolean {
  return isTauri() && isAiConfigured(config);
}

/**
 * 清洗模型输出：剥掉「润色后：」类前缀与首尾引号包裹，maxLen 为字段硬上限
 * （如输入框的 maxlength），超长截断——润色不该让文字超出原来能存下的长度。
 */
export function parsePolishedText(raw: string, maxLen?: number): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  text = text
    .replace(/^(润色后|改写后|修改后)[:：]\s*/, "")
    .replace(/^[「“"'『【\[]+/, "")
    .replace(/[」”"'』】\]]+$/, "")
    .trim();
  if (maxLen !== undefined && maxLen > 0 && text.length > maxLen) {
    text = text.slice(0, maxLen);
  }
  return text;
}

function buildMessages(ctx: PolishContext): AgentMessage[] {
  const lines = [`【使用场景】${ctx.scene.trim()}${ctx.hint?.trim() ? `（${ctx.hint.trim()}）` : ""}`];
  if (ctx.context?.trim()) lines.push(`【相关信息】${ctx.context.trim()}`);
  lines.push(`【原文】${ctx.text.trim()}`, "请润色这段文字。");
  return [{ role: "user", content: lines.join("\n") }];
}

/**
 * 润色一段文字，返回润色结果。与生成类 AI 不同，这里**没有静默回落**：
 * 润色是用户主动点击的动作，失败必须如实报错，而不是悄悄改写或返回原文。
 * options.llm / options.aiReady 主要供单测注入替身；默认按运行环境自动判断。
 */
export async function polishText(
  ctx: PolishContext,
  options: { llm?: AgentLlm; aiReady?: boolean; maxLen?: number } = {}
): Promise<string> {
  if (!ctx.text.trim()) throw new Error("还没有输入内容，先写几个字再润色。");
  if (!ctx.scene.trim()) throw new Error("缺少使用场景，无法润色。");

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? isAiPolishReady(config);
  if (!aiReady) throw new Error("未配置 AI 模型，请到「设置中心 · 数据与设置」配置后使用润色。");

  let raw: string;
  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: resolvePrompt(PROMPT_IDS.textPolish),
      messages: buildMessages(ctx),
      tools: [],
      config,
    });
    raw = res.content;
  } catch (e) {
    throw new Error(aiErrorMessage(e));
  }

  const polished = parsePolishedText(raw, options.maxLen);
  if (!polished) throw new Error("AI 没有返回有效的润色结果，请稍后再试。");
  return polished;
}
