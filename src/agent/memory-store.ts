/**
 * Agent 记忆的存储层：记忆文件读写、待整理队列、学习开关与注入过滤。
 *
 * 记忆文件是应用从对话中沉淀的用户偏好（对功能的叫法、操作习惯、回答风格要求），
 * 桌面端落在本机 `app_data_dir/agent-memory.md`（Rust 命令 agent_memory_*），
 * 浏览器演示态回落 localStorage；用户可直接编辑文件，删除某行即忘掉该条。
 *
 * 整理管线（何时更新、怎么调模型）在 memory.ts；本模块只管存取，方便单测。
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/env";
import { logError } from "../lib/logger";
import { readJsonStorage } from "../lib/storage";
import { MEMORY_SECTIONS } from "../prompts/contracts";

/** 记忆文件名（与 src-tauri/src/paths.rs 的 agent_memory_path 保持一致） */
export const MEMORY_FILE_NAME = "agent-memory.md";

/** 浏览器演示态的回落存储键 */
const LS_MEMORY_KEY = "aprilio.agent-memory.md";
/** 待整理对话片段队列 */
const LS_QUEUE_KEY = "aprilio.agent-memory.queue.v1";
/** 自动学习开关（"0" = 关闭；缺省开启） */
const LS_ENABLED_KEY = "aprilio.agent-memory.enabled";

/** 队列长度上限：超出丢最旧的（正常 6 条就触发整理，触顶说明一直没条件整理） */
export const MEMORY_QUEUE_LIMIT = 40;

/** 单条交互文本截断长度：整理只需要「偏好在说什么」，不需要完整对话 */
export const MEMORY_FIELD_LIMIT = 400;

/** 单次整理的输出上限（字符）：控制记忆文件规模，Rust 侧还有 64KB 硬保险 */
export const MEMORY_MAX_CHARS = 8000;

/** 一条待整理的对话片段（只含偏好提取所需的最小面，不含工具返回数据） */
export interface MemoryInteraction {
  /** 发生时间（ISO 字符串，仅供整理模型判断新旧，不写入记忆） */
  at: string;
  /** 交互发生的页面（路由名） */
  page: string;
  /** 用户输入（截断） */
  user: string;
  /** 助手最终回复（截断） */
  reply: string;
  /** 本轮调用的工具名（不含参数，避免业务数据进入队列） */
  tools: string[];
}

function isMemoryInteraction(value: unknown): value is MemoryInteraction {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<MemoryInteraction>;
  return (
    typeof v.at === "string" &&
    typeof v.page === "string" &&
    typeof v.user === "string" &&
    typeof v.reply === "string" &&
    Array.isArray(v.tools) &&
    v.tools.every((t) => typeof t === "string")
  );
}

/* ------------------------------------------------------------------ */
/* 记忆文件读写                                                         */
/* ------------------------------------------------------------------ */

/**
 * 记忆文件模板：首次播种用。说明注释刻意都是单行（注入过滤按行剔除），
 * 小节标题取自 prompts/contracts 的 MEMORY_SECTIONS（与整理提示词同源不漂移）。
 */
export const MEMORY_TEMPLATE = [
  "# 助手记忆",
  "",
  "<!-- 本文件由应用自动维护：从你与 AI 助手的对话中沉淀使用偏好，助手每次对话都会读取。 -->",
  "<!-- 可手工编辑：改一行即改一条记忆，删一行即忘掉一条；文件删除后应用会重建。 -->",
  "",
  ...MEMORY_SECTIONS.flatMap((section) => [`## ${section}`, ""]),
].join("\n");

/** 记忆文件的进程内缓存：buildSystemPrompt 是同步的，注入时只读缓存 */
let cachedMemory: string | null = null;

/** 当前记忆内容（未加载过时为空串） */
export function getCachedMemory(): string {
  return cachedMemory ?? "";
}

function setCachedMemory(raw: string): void {
  cachedMemory = raw;
}

/** 读取记忆全文并刷新缓存（Tauri 读文件；浏览器读 localStorage） */
export async function refreshMemoryCache(): Promise<string> {
  const raw = await readMemoryRaw();
  setCachedMemory(raw);
  return raw;
}

async function readMemoryRaw(): Promise<string> {
  if (!isTauri()) {
    return readJsonStorage<string>(LS_MEMORY_KEY, () => "");
  }
  try {
    return await invoke<string>("agent_memory_read");
  } catch (e) {
    logError("[memory] 读取记忆文件失败", e);
    return "";
  }
}

/** 整文件覆盖写入记忆内容，并同步刷新缓存（下一次对话立即生效） */
export async function writeMemoryRaw(raw: string): Promise<void> {
  setCachedMemory(raw);
  if (!isTauri()) {
    try {
      localStorage.setItem(LS_MEMORY_KEY, raw);
    } catch {
      /* 存储不可用时放弃（演示态不致命） */
    }
    return;
  }
  await invoke("agent_memory_write", { content: raw });
}

/** 记忆文件完整路径（设置页展示用；浏览器演示态返回空串） */
export async function getMemoryFilePath(): Promise<string> {
  if (!isTauri()) return "";
  try {
    return await invoke<string>("agent_memory_path");
  } catch {
    return "";
  }
}

/**
 * 记忆注入文本：剔除标题、注释与空行，只留「- 」条目行。
 * 模板（只有骨架没有条目）因此注入为空串——主提示词的 {用户记忆}
 * 整行省略，与出厂文案零漂移。
 */
export function memoryForPrompt(raw: string): string {
  if (!raw) return "";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith("#") && !line.startsWith("<!--") && !line.startsWith("-->"),
    )
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* 待整理队列                                                           */
/* ------------------------------------------------------------------ */

/** 读取待整理队列（损坏 / 非法结构回落空队列） */
export function loadMemoryQueue(): MemoryInteraction[] {
  return readJsonStorage<MemoryInteraction[]>(LS_QUEUE_KEY, () => [], (raw) => {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMemoryInteraction);
  });
}

/** 覆盖写入待整理队列 */
export function saveMemoryQueue(queue: MemoryInteraction[]): void {
  try {
    localStorage.setItem(LS_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* 存储不可用时本次队列变更丢弃 */
  }
}

/* ------------------------------------------------------------------ */
/* 自动学习开关                                                         */
/* ------------------------------------------------------------------ */

/**
 * 自动学习是否开启（缺省开启；关闭后不再记录与整理，已有记忆仍然生效）。
 * 存 JSON 布尔——readJsonStorage 读出的值过 JSON.parse，不能存裸 "0"/"1" 文本。
 */
export function isMemoryLearningEnabled(): boolean {
  return readJsonStorage<boolean>(
    LS_ENABLED_KEY,
    () => true,
    (raw) => JSON.parse(raw) === true,
  );
}

export function setMemoryLearningEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_ENABLED_KEY, JSON.stringify(enabled));
  } catch {
    /* 存储不可用时开关不落盘 */
  }
}
