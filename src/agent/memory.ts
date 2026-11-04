/**
 * Agent 记忆的整理管线：记录对话片段 → 防抖调度 → 后台 LLM 整理 → 写回记忆文件。
 *
 * 目标是「越用越懂你」：助手每轮对话结束把片段（用户输入 + 最终回复 + 工具名，
 * 截断后入队）交给后台任务；攒够一批或安静一段时间后，用独立的一次 LLM 调用
 * （提示词模块 assistant.memory）从「当前记忆 + 最近片段」中沉淀稳定偏好，
 * 合并出记忆全文写回 agent-memory.md。下一次对话经 buildSystemPrompt 注入。
 *
 * 失败不打扰用户：模型未配置 / 请求失败 / 输出不合格，队列原样保留等下一轮，
 * 只落日志；写盘前的未变化检查保证「没有新偏好」不产生无意义的写动作。
 */
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { runAiTask } from "../lib/ai-run";
import { isTauri } from "../lib/env";
import { logError, logInfo, logWarn } from "../lib/logger";
import { PROMPT_IDS } from "../prompts/ids";
import type { AgentLlm, AgentMessage } from "./types";
import {
  MEMORY_FIELD_LIMIT,
  MEMORY_MAX_CHARS,
  MEMORY_QUEUE_LIMIT,
  MEMORY_TEMPLATE,
  type MemoryInteraction,
  isMemoryLearningEnabled,
  loadMemoryQueue,
  refreshMemoryCache,
  saveMemoryQueue,
  writeMemoryRaw,
} from "./memory-store";

/** 最后一次交互后等待多久触发整理（防抖：连续对话只等最后一句） */
const FLUSH_DELAY_MS = 90_000;
/** 队列攒到多少条立即整理（不等防抖） */
const FLUSH_THRESHOLD = 6;
/** 启动时发现有积压，延迟多久补一次整理（先让应用完成启动） */
const STARTUP_DELAY_MS = 30_000;
/** 单次整理最多消化多少条片段 */
const MAX_BATCH = 12;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let updating = false;

/* ------------------------------------------------------------------ */
/* 记录与调度                                                           */
/* ------------------------------------------------------------------ */

export interface RecordAgentInteractionInput {
  page: string;
  user: string;
  reply: string;
  tools: string[];
}

/**
 * 一轮对话结束后的记录入口（useAgent 调用，同步、不抛错）：
 * 截断入队，攒够阈值立即整理，否则排一次防抖。
 * 仅桌面端启用——浏览器演示态没有真实模型，整理不了。
 */
export function recordAgentInteraction(input: RecordAgentInteractionInput): void {
  if (!isTauri() || !isMemoryLearningEnabled()) return;

  const entry: MemoryInteraction = {
    at: new Date().toISOString(),
    page: input.page.slice(0, 60),
    user: input.user.slice(0, MEMORY_FIELD_LIMIT),
    reply: input.reply.slice(0, MEMORY_FIELD_LIMIT),
    tools: input.tools.filter(Boolean).slice(0, 6),
  };
  const queue = [...loadMemoryQueue(), entry].slice(-MEMORY_QUEUE_LIMIT);
  saveMemoryQueue(queue);

  // 顺手刷新一次缓存：用户手工改过记忆文件的话，下一轮对话就能带上
  void refreshMemoryCache().catch(() => undefined);

  if (queue.length >= FLUSH_THRESHOLD) {
    void flushMemoryQueue();
    return;
  }
  scheduleFlush(FLUSH_DELAY_MS);
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushMemoryQueue();
  }, delayMs);
}

/** 应用入口调用一次：播种记忆模板 + 有积压时安排一次补整理 */
export function initAgentMemory(): void {
  if (!isTauri()) return;
  void (async () => {
    try {
      if (!isMemoryLearningEnabled()) {
        await refreshMemoryCache();
        return;
      }
      const raw = await refreshMemoryCache();
      // 文件缺失或为空 → 播种模板（只有说明骨架，不含任何学习内容）
      if (!raw.trim()) await writeMemoryRaw(MEMORY_TEMPLATE);
    } catch (e) {
      logError("[memory] 初始化失败", e);
    }
  })();
  if (isMemoryLearningEnabled() && loadMemoryQueue().length > 0) {
    scheduleFlush(STARTUP_DELAY_MS);
  }
}

/* ------------------------------------------------------------------ */
/* 后台整理                                                             */
/* ------------------------------------------------------------------ */

export type MemoryFlushResult =
  | "busy"
  | "idle"
  | "disabled"
  | "not-ready"
  | "updated"
  | "unchanged"
  | "failed";

/** 结果的中文说明（设置页「立即整理」用） */
export function memoryFlushMessage(result: MemoryFlushResult): string {
  switch (result) {
    case "busy":
      return "正在整理中，请稍候。";
    case "idle":
      return "没有待整理的对话片段。";
    case "disabled":
      return "自动学习已关闭，先打开开关再整理。";
    case "not-ready":
      return "还没有配置可用模型，配置好之后会自动整理。";
    case "updated":
      return "整理完成，记忆已更新。";
    case "unchanged":
      return "整理完成，没有需要新增的偏好。";
    case "failed":
      return "整理失败，片段已保留，稍后会自动重试。";
  }
}

/**
 * 执行一次后台整理（单飞）：取队列最早的最多 12 条，交给整理模型合并进当前记忆。
 * 返回结果枚举供 UI 与测试断言；除「模型输出不合格」外失败一律保留队列。
 */
export async function flushMemoryQueue(deps?: { llm?: AgentLlm }): Promise<MemoryFlushResult> {
  if (updating) return "busy";
  updating = true;
  try {
    if (!isMemoryLearningEnabled()) return "disabled";
    if (!isTauri()) return "not-ready";
    if (!isAiConfigured(loadAiConfig())) return "not-ready";

    const queue = loadMemoryQueue();
    if (queue.length === 0) return "idle";
    const batch = queue.slice(0, MAX_BATCH);

    const current = await refreshMemoryCache();
    const updated = await runAiTask<string>({
      promptId: PROMPT_IDS.agentMemory,
      messages: buildCuratorMessages(current, batch),
      parse: parseMemoryUpdate,
      llm: deps?.llm,
      aiReady: true,
    });
    if (updated === null) {
      logWarn("[memory] 记忆整理请求失败，片段保留待重试");
      return "failed";
    }

    // 消化掉本批（无论记忆是否变化，这些片段已经产生过价值判断）
    saveMemoryQueue(queue.slice(batch.length));

    if (normalizeForCompare(updated) === normalizeForCompare(current)) {
      logInfo("[memory] 记忆整理完成：无新增偏好");
      return "unchanged";
    }
    await writeMemoryRaw(updated);
    logInfo(`[memory] 记忆已更新（消化 ${batch.length} 条对话片段）`);
    return "updated";
  } catch (e) {
    logError("[memory] 记忆整理异常", e);
    return "failed";
  } finally {
    updating = false;
  }
}

function buildCuratorMessages(current: string, batch: MemoryInteraction[]): AgentMessage[] {
  const lines = batch.map((it, i) => {
    const tools = it.tools.length ? `\n   调用工具：${it.tools.join("、")}` : "";
    return `${i + 1}. [${it.page}] 用户：${it.user}\n   助手：${it.reply}${tools}`;
  });
  return [
    {
      role: "user",
      content: [
        "【当前记忆全文】",
        current.trim() || "（还没有记忆）",
        "",
        "【最近对话片段】",
        ...lines,
      ].join("\n"),
    },
  ];
}

/** 清洗模型输出：剥代码块包裹，校验非空与长度上限（抛错 = 本次整理失败） */
function parseMemoryUpdate(content: string): string {
  let text = content.trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  if (!text) throw new Error("模型返回了空记忆");
  if (text.length > MEMORY_MAX_CHARS) throw new Error("模型返回的记忆超长");
  return text;
}

/** 变化判断口径：压缩所有空白后比较（模型的换行 / 缩进抖动不算变化） */
function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
