/**
 * 家校沟通总结 AI 生成（增强层）：沿 comment-ai.ts 范式。
 * - 桌面端且已配置模型 → 经 Rust rig-core 结合时段内评价与个性化要求生成给家长的总结
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 返回 null，界面退回手动填写，应用动作永不阻塞
 * 隐私：仅把该生时段内的评价统计与评语文本发给用户自己配置的模型服务，不写日志。
 */
import { isAiConfigured, loadAiConfig } from "./ai";
import { isTauri } from "./db";
import { createLlm } from "../agent/providers";
import { PROMPT_IDS, resolvePrompt } from "../prompts";
import { PARENT_SUMMARY_MAX_LEN } from "../prompts/contracts";
import { parseTermComment } from "./comment-ai";
import type { AgentLlm, AgentMessage } from "../agent/types";

/** 总结正文硬截断上限（200，与学期评语同上限，应用回档案不二次截断）。 */
export { PARENT_SUMMARY_MAX_LEN };

export interface ParentSummaryContext {
  studentName: string;
  gradeClass: string;
  /** 时间范围展示文本（rangeLabel 产出），如「2026-2027-1 学期（2026-09-01~2027-02-28）」 */
  rangeText: string;
  /** 时段内评价素材（buildParentSummaryMaterial 产出），可空 */
  material: string;
  /** 个性化要求（首启生成时附带），可空 */
  requirement?: string;
}

/** 首轮消息：素材 + 初始要求；后续「补充要求」由调用方在该线程上追加（聊天式重写） */
export function buildSummaryMessages(ctx: ParentSummaryContext): AgentMessage[] {
  const lines = [
    `【学生】${ctx.studentName}`,
    `【班级】${ctx.gradeClass || "未分班"}`,
    `【时间范围】${ctx.rangeText}`,
    `【时段内评价】${ctx.material || "本时段暂无评价记录"}`,
    "请据此给家长写一段这段时间的孩子表现总结。",
  ];
  const requirement = ctx.requirement?.trim();
  if (requirement) lines.push(`【个性化要求】${requirement}`);
  return [{ role: "user", content: lines.join("\n") }];
}

/** 清洗模型输出：引号与「评语：」沿用学期评语的清洗；模型常自加「总结：」类标题，一并剥掉；截断放最后 */
export function parseParentSummary(raw: string, maxLen = PARENT_SUMMARY_MAX_LEN): string {
  let text = parseTermComment(raw, Number.POSITIVE_INFINITY)
    .replace(/^(表现总结|家校沟通总结|总结)[:：]\s*/, "")
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/**
 * 按既有对话线程请求一次总结。messages 应包含此前所有轮次（调用方负责追加），
 * 返回前把助手回复 push 回线程（保持线程完整，供下一轮引用）；未配置 / 失败返回 null（不抛错）。
 * options.llm / options.aiReady 供单测注入替身。
 */
export async function requestParentSummary(
  messages: AgentMessage[],
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<string | null> {
  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return null;

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: resolvePrompt(PROMPT_IDS.parentSummary),
      messages,
      tools: [],
      config,
    });
    const text = parseParentSummary(res.content);
    if (!text) return null;
    messages.push({ role: "assistant", content: text });
    return text;
  } catch {
    return null;
  }
}
