/**
 * 监护人风格标签：预设候选词管理 + 情感倾向配色
 * - 预设候选词支持动态增删，全量存 localStorage（首次取 types 里的系统默认词）
 * - 情感倾向（positive / neutral / negative）只由 AI 判定：
 *   已配置模型 → 打开学生档案编辑页时后台补齐缺失标签的倾向，胶囊按倾向上填充色
 *   未配置 / 调用失败 → 不上色（留白），等配置好后再打开页面会自动补齐
 * - 倾向结果缓存 localStorage，一次判定永久复用，不重复烧 token
 * 隐私：仅把标签词本身发给用户自己配置的模型服务。
 */
import { loadAiConfig, isAiConfigured } from "./ai";
import { isTauri } from "./db";
import { createLlm } from "../agent/providers";
import type { AgentLlm, AgentMessage } from "../agent/types";
import { GUARDIAN_TAG_POLARITIES, GUARDIAN_TAG_PRESETS } from "../types";
import type { GuardianTagPolarity } from "../types";

/* ------------------------------------------------------------------ */
/* 预设候选词：localStorage 全量存储，支持动态增删                        */
/* ------------------------------------------------------------------ */

export const GUARDIAN_TAG_PRESETS_KEY = "aprilio.guardian.tag.presets";
const POLARITY_STORAGE_KEY = "aprilio.guardian.tag.polarities";
/** 测试注入倾向缓存用 */
export const GUARDIAN_TAG_POLARITY_KEY = POLARITY_STORAGE_KEY;

/** 预设候选词上限，避免候选行无限膨胀 */
export const GUARDIAN_TAG_PRESETS_MAX = 20;

/** 标签长度上限，与手动录入保持一致 */
export const GUARDIAN_TAG_MAX_LEN = 10;

export function loadGuardianTagPresets(): string[] {
  if (typeof localStorage === "undefined") return [...GUARDIAN_TAG_PRESETS];
  try {
    const raw = localStorage.getItem(GUARDIAN_TAG_PRESETS_KEY);
    if (!raw) return [...GUARDIAN_TAG_PRESETS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...GUARDIAN_TAG_PRESETS];
    return parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  } catch {
    return [...GUARDIAN_TAG_PRESETS];
  }
}

/** 新增自定义预设候选词：去重、限长限数；返回是否真的新增 */
export function addGuardianTagPreset(tag: string): boolean {
  const clean = tag.trim().slice(0, GUARDIAN_TAG_MAX_LEN);
  if (!clean) return false;
  const list = loadGuardianTagPresets();
  if (list.includes(clean) || list.length >= GUARDIAN_TAG_PRESETS_MAX) return false;
  return writeGuardianTagPresets([...list, clean]);
}

/** 删除预设候选词（系统默认也可删，删后可手动加回）；返回是否真的删除 */
export function removeGuardianTagPreset(tag: string): boolean {
  const list = loadGuardianTagPresets();
  const next = list.filter((t) => t !== tag);
  if (next.length === list.length) return false;
  return writeGuardianTagPresets(next);
}

function writeGuardianTagPresets(list: string[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(GUARDIAN_TAG_PRESETS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 情感倾向：localStorage 缓存 + AI 判定                                 */
/* ------------------------------------------------------------------ */

export function loadTagPolarities(): Record<string, GuardianTagPolarity> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(POLARITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, GuardianTagPolarity> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if ((GUARDIAN_TAG_POLARITIES as readonly string[]).includes(String(value))) {
        out[key] = String(value) as GuardianTagPolarity;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeTagPolarities(entries: Record<string, GuardianTagPolarity>): void {
  if (typeof localStorage === "undefined" || Object.keys(entries).length === 0) return;
  try {
    localStorage.setItem(
      POLARITY_STORAGE_KEY,
      JSON.stringify({ ...loadTagPolarities(), ...entries })
    );
  } catch {
    // 存储不可用不影响主流程
  }
}

/**
 * 倾向 → 胶囊填充色 class。
 * 未判定倾向（未配置 AI / 未及补齐）返回留白中性底，不上任何倾向色。
 */
export function tagChipClass(polarity?: GuardianTagPolarity): string {
  switch (polarity) {
    case "positive":
      return "bg-tag-positive-soft text-tag-positive";
    case "negative":
      return "bg-tag-negative-soft text-tag-negative";
    default:
      return "bg-parchment text-muted";
  }
}

const POLARITY_SYSTEM_PROMPT =
  "你是小学班主任助手。为每个「监护人风格标签」判定教师与该监护人相处沟通时的情感倾向，三选一：" +
  "positive（正面：温和、配合、沟通良好）、negative（负面：配合度低、难沟通、较少参与）、" +
  "neutral（中性：客观描述无明显褒贬）。" +
  "只输出 JSON 对象，键为标签原文、值为 positive/neutral/negative，不要任何解释。";

function buildMessages(tags: string[]): AgentMessage[] {
  return [{ role: "user", content: `标签列表：${tags.join("、")}` }];
}

/**
 * 解析模型输出为「标签 → 倾向」：
 * 优先取 JSON 对象，失败退回「标签：倾向」行式；非法倾向值一律丢弃。
 */
export function parseTagPolarities(raw: string): Record<string, GuardianTagPolarity> {
  const out: Record<string, GuardianTagPolarity> = {};
  const text = raw.trim();
  if (!text) return out;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        const tag = String(key).trim();
        const polarity = String(value).trim().toLowerCase();
        if (tag && (GUARDIAN_TAG_POLARITIES as readonly string[]).includes(polarity)) {
          out[tag] = polarity as GuardianTagPolarity;
        }
      }
      if (Object.keys(out).length) return out;
    } catch {
      // 落到行式兜底
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/(.+?)\s*[：:]\s*(positive|neutral|negative)/i);
    if (!m) continue;
    const tag = m[1]
      .replace(/^[「"'『【\[]+/, "")
      .replace(/[」"'』】\]]+$/, "")
      .trim();
    if (tag) out[tag] = m[2].toLowerCase() as GuardianTagPolarity;
  }
  return out;
}

/**
 * 补齐缺失标签的倾向：已有缓存直接复用，只对缺失的一次性请求模型。
 * options.llm / options.aiReady 供单测注入替身；未配置 AI / 失败 → 静默返回已有缓存，不阻塞界面。
 */
export async function ensureGuardianTagPolarities(
  tags: string[],
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<Record<string, GuardianTagPolarity>> {
  const list = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return {};

  const pickKnown = (): Record<string, GuardianTagPolarity> => {
    const all = loadTagPolarities();
    return Object.fromEntries(list.filter((t) => all[t]).map((t) => [t, all[t]]));
  };

  const cached = loadTagPolarities();
  const missing = list.filter((t) => !cached[t]);
  if (!missing.length) return pickKnown();

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return pickKnown();

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: POLARITY_SYSTEM_PROMPT,
      messages: buildMessages(missing),
      tools: [],
      config,
    });
    const parsed = parseTagPolarities(res.content);
    const fresh = Object.fromEntries(
      Object.entries(parsed).filter(([tag]) => missing.includes(tag))
    ) as Record<string, GuardianTagPolarity>;
    if (Object.keys(fresh).length) writeTagPolarities(fresh);
  } catch {
    // AI 不可用不上色，保持留白
  }
  return pickKnown();
}
