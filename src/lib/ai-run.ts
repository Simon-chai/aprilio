/**
 * 业务侧「执行一次 AI 任务」的统一骨架。
 *
 * 以前每个 *-ai 模块手写同一段 15~25 行：loadAiConfig → 就绪判断 → createLlm →
 * llm.chat(resolvePrompt) → parse → catch 回落，输出清洗正则与 JSON 提取也各自复制；
 * 这里收敛为一个入口，行为约定与原各处实现逐字对齐：
 * - 未就绪（非 Tauri / 未配置模型 / 显式 aiReady=false）→ 返回 null，调用方走兜底
 * - 请求失败、parse 抛错 → 返回 null，永不向上抛（润色等需报错的场景自带变体，见 polish-ai）
 * - parse 只做「模型输出 → 业务值」的清洗与校验，缓存放调用方
 */
import { isAiConfigured, loadAiConfig, type AiConfig } from "./ai";
import { createFailoverLlm } from "./ai-failover";
import { isTauri } from "./env";
import type { AgentLlm, AgentMessage } from "./llm";
import { resolvePrompt } from "../prompts";

/** runAiTask 的参数：promptId + 消息 + 解析回调；llm / aiReady 供单测注入替身 */
export interface AiTaskOptions<T> {
  /** 提示词模块 id（PROMPT_IDS 的值） */
  promptId: string;
  messages: AgentMessage[];
  /** 解析模型输出；抛错等同本次失败 */
  parse: (content: string) => T;
  /** 测试注入；缺省用桌面端 rig 传输 */
  llm?: AgentLlm;
  /** 就绪开关注入（组件已算好时避免重复判断）；缺省 isTauri() && isAiConfigured(config) */
  aiReady?: boolean;
}

/**
 * 执行一次「生成类」AI 任务：就绪判断 → chat → parse，失败一律 null。
 */
export async function runAiTask<T>(params: AiTaskOptions<T>): Promise<T | null> {
  const config = loadAiConfig();
  const ready = params.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!ready) return null;
  try {
    // 缺省走「多模型自动切换」：当前方案失败自动改试其它已配置方案
    const llm = params.llm ?? createFailoverLlm();
    const res = await llm.chat({
      system: resolvePrompt(params.promptId),
      messages: params.messages,
      tools: [],
      config,
    });
    return params.parse(res.content);
  } catch {
    return null;
  }
}

/**
 * 执行一次裸 chat（调用方自己管就绪判断与 config，如导入识别管道）：
 * 返回模型文本，失败返回 null。
 */
export async function chatOnce(params: {
  system: string;
  messages: AgentMessage[];
  /** 测试注入；缺省用桌面端 rig 传输 */
  llm?: AgentLlm;
  config: AiConfig;
}): Promise<string | null> {
  try {
    const llm = params.llm ?? createFailoverLlm();
    const res = await llm.chat({
      system: params.system,
      messages: params.messages,
      tools: [],
      config: params.config,
    });
    return res.content;
  } catch {
    return null;
  }
}

/**
 * 从模型输出提取 JSON 对象：定位最外层 {...} 并 JSON.parse。
 * 无匹配 / 解析失败 / 非对象返回 null（模型输出不可信，调用方逐字段校验）。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 剥掉首尾引号包裹：「"…"」「「…」」「【…】」等中西引号成对剥除 */
export function stripQuoteWrap(line: string): string {
  return line
    .replace(/^[「“"'『【\[]+/, "")
    .replace(/[」”"'』】\]]+$/, "");
}

/**
 * 把一行「序号/项目符号 + 引号包裹」的列表项清洗成裸文本。
 * parseAiComments / parseMemoTitle 共用的输出清洗口径。
 */
export function stripListDecoration(line: string): string {
  const bare = line
    .trim()
    .replace(/^[0-9①-⑩]+[.、)．:：]\s*/, "")
    .replace(/^[-·•*]+\s*/, "");
  return stripQuoteWrap(bare).trim();
}
