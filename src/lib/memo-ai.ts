/**
 * 备忘快速浏览标题（AI 总结）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 把备忘正文浓缩为 ≤12 字标题
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 返回 null，界面退回「全文前几个字」
 *   （lib/timetable 的 memoPreviewText），录入与展示永不阻塞
 * - 生成成功后由 db.setCalendarEventTitle 落库，一次生成永久复用，不重复调用
 * 隐私：仅把单条备忘正文发给用户自己配置的模型服务，不写日志。
 */
import { PROMPT_IDS } from "../prompts";
import { MEMO_TITLE_MAX_LEN } from "../prompts/contracts";
import { runAiTask, stripListDecoration } from "./ai-run";
import type { AgentLlm, AgentMessage } from "./llm";

/** 快速浏览标题的硬截断上限（与提示词模块的 {标题字数上限} 同源） */
export { MEMO_TITLE_MAX_LEN };

/**
 * 解析模型输出为干净标题：取首行，兼容编号 / 项目符号 / 引号包裹，超长截断。
 */
export function parseMemoTitle(raw: string, maxLen = MEMO_TITLE_MAX_LEN): string {
  let line = (raw.trim().split(/\r?\n/)[0] ?? "").trim();
  if (!line) return "";
  line = stripListDecoration(line);
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

  // AI 不可用不阻塞备忘展示，静默退回全文前几个字（runAiTask 失败返回 null）
  return runAiTask({
    promptId: PROMPT_IDS.memoTitle,
    messages: buildMessages(text),
    parse: (raw) => parseMemoTitle(raw) || null,
    llm: options.llm,
    aiReady: options.aiReady,
  });
}
