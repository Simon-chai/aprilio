/**
 * 备忘快速浏览标题（AI 总结）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 把备忘正文浓缩为 ≤12 字标题
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 返回 null，界面退回「全文前几个字」
 *   （lib/timetable 的 memoPreviewText），录入与展示永不阻塞
 * - 生成成功后由 db.setCalendarEventTitle 落库，一次生成永久复用，不重复调用
 * 隐私：仅把单条备忘正文发给用户自己配置的模型服务，不写日志。
 */
import { isAiConfigured, loadAiConfig } from "./ai";
import { isTauri } from "./env";
import { createLlm } from "../agent/providers";
import { PROMPT_IDS, resolvePrompt } from "../prompts";
import { MEMO_TITLE_MAX_LEN } from "../prompts/contracts";
import type { AgentLlm, AgentMessage } from "../agent/types";

/** 快速浏览标题的硬截断上限（与提示词模块的 {标题字数上限} 同源） */
export { MEMO_TITLE_MAX_LEN };

/**
 * 解析模型输出为干净标题：取首行，兼容编号 / 项目符号 / 引号包裹，超长截断。
 */
export function parseMemoTitle(raw: string, maxLen = MEMO_TITLE_MAX_LEN): string {
  let line = (raw.trim().split(/\r?\n/)[0] ?? "").trim();
  if (!line) return "";
  line = line
    .replace(/^[0-9①-⑩]+[.、)．:：]\s*/, "")
    .replace(/^[-·•*]+\s*/, "")
    .replace(/^[「“"'『【\[]+/, "")
    .replace(/[」”"'』】\]]+$/, "")
    .trim();
  if (line.length > maxLen) line = line.slice(0, maxLen);
  return line;
}

function buildMessages(content: string): AgentMessage[] {
  return [{ role: "user", content: `备忘正文：${content.trim()}` }];
}

/**
 * 生成快速浏览标题。
 * options.llm / options.aiReady 主要供单测注入替身；默认按运行环境自动判断。
 * 未配置 / 失败一律返回 null（不抛错），调用方以 null 判断是否回写。
 */
export async function summarizeMemoTitle(
  content: string,
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<string | null> {
  const text = content.trim();
  if (!text) return null;

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return null;

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: resolvePrompt(PROMPT_IDS.memoTitle),
      messages: buildMessages(text),
      tools: [],
      config,
    });
    return parseMemoTitle(res.content) || null;
  } catch {
    // AI 不可用不阻塞备忘展示，静默退回全文前几个字
    return null;
  }
}
