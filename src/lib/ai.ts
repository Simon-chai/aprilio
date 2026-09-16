import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";
import { isTauri } from "./db";

/* ------------------------------------------------------------------ */
/* 供应商预设                                                           */
/* ------------------------------------------------------------------ */

export interface AiProviderPreset {
  id: string;
  label: string;
  /** 该供应商的默认模型名，切换供应商时自动带入 */
  defaultModel: string;
  /** 是否需要 API 密钥（本地 Ollama 不需要） */
  needsKey: boolean;
}

export const AI_PROVIDERS: AiProviderPreset[] = [
  { id: "openai", label: "OpenAI", defaultModel: "gpt-4o-mini", needsKey: true },
  { id: "anthropic", label: "Anthropic", defaultModel: "claude-sonnet-4-5", needsKey: true },
  { id: "gemini", label: "Google Gemini", defaultModel: "gemini-2.5-flash", needsKey: true },
  { id: "deepseek", label: "DeepSeek", defaultModel: "deepseek-chat", needsKey: true },
  { id: "moonshot", label: "月之暗面 Kimi", defaultModel: "kimi-k2-0905-preview", needsKey: true },
  { id: "zhipu", label: "智谱 GLM", defaultModel: "glm-4-flash", needsKey: true },
  { id: "openrouter", label: "OpenRouter", defaultModel: "openrouter/auto", needsKey: true },
  { id: "ollama", label: "本地 Ollama", defaultModel: "qwen3:8b", needsKey: false },
  { id: "custom", label: "自定义（OpenAI 兼容）", defaultModel: "", needsKey: true },
];

export function aiProviderById(id: string): AiProviderPreset | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

/* ------------------------------------------------------------------ */
/* 密钥脱敏显示                                                          */
/* ------------------------------------------------------------------ */

/**
 * 脱敏显示 API 密钥：保留前 3 位与后 4 位，中间用 • 遮住。
 * 过短（≤8 位）则整体遮住，避免头尾泄露有效信息；空密钥返回空串。
 */
export function maskApiKey(key: string): string {
  const v = (key ?? "").trim();
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 3)}••••${v.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* 配置：存本机 localStorage，密钥不出本机                               */
/* 密钥在 localStorage 中做 Base64 混淆存放（enc1: 前缀），避免明文躺着  */
/* 被路过看到。注意：这只是防偷窥的混淆而非加密——能接触本机文件的人仍可  */
/* 解码；内存中的 AiConfig.apiKey 保持明文（发请求时必须用原文）。       */
/* ------------------------------------------------------------------ */

export interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  /** OpenAI 兼容的自定义地址，留空用官方 */
  baseUrl: string;
  temperature: number;
  systemPrompt: string;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "",
  baseUrl: "",
  temperature: 0.7,
  systemPrompt: "",
};

const STORAGE_KEY = "aprilio.ai.config";

/** 混淆存放的前缀：命中则按 Base64 解码，否则按历史明文兼容读入 */
const KEY_OBFUSCATION_PREFIX = "enc1:";

function encodeApiKey(key: string): string {
  const v = (key ?? "").trim();
  if (!v) return "";
  try {
    const bytes = new TextEncoder().encode(v);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return `${KEY_OBFUSCATION_PREFIX}${btoa(bin)}`;
  } catch {
    return v;
  }
}

function decodeApiKey(stored: unknown): string {
  if (typeof stored !== "string" || !stored) return "";
  if (!stored.startsWith(KEY_OBFUSCATION_PREFIX)) return stored;
  const payload = stored.slice(KEY_OBFUSCATION_PREFIX.length);
  try {
    const bin = atob(payload);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* 多模型方案：可保存多套配置，一键切换「当前使用」                       */
/* 存储键 aprilio.ai.profiles.v1：{ activeId, profiles[] }，            */
/* 每个方案的密钥同样做 enc1: 混淆存放，不出本机。                       */
/* 历史单配置（aprilio.ai.config）首次读取时自动迁移为一个「默认方案」。  */
/* ------------------------------------------------------------------ */

/** 单套模型方案；AiConfig 的字段全部包含，可直接传给 isAiConfigured / verifyAiConfig */
export interface AiProfile {
  id: string;
  /** 展示名，如「DeepSeek 日常主力」「本地 Ollama 离线备用」 */
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  /** OpenAI 兼容的自定义地址，留空用官方 */
  baseUrl: string;
  temperature: number;
  systemPrompt: string;
}

/** 方案集合状态：activeId 指向「当前使用」的方案（profiles 为空时为空串） */
export interface AiProfilesState {
  activeId: string;
  profiles: AiProfile[];
}

const PROFILES_STORAGE_KEY = "aprilio.ai.profiles.v1";

/** 空方案集：还没有任何方案（首次使用） */
const EMPTY_PROFILES_STATE: AiProfilesState = { activeId: "", profiles: [] };

/** 方案/配置变更版本号：loadAiConfig 读 localStorage 不具备响应性，消费方依赖它刷新 computed */
export const aiConfigVersion = ref(0);

function notifyAiConfigChanged(): void {
  aiConfigVersion.value += 1;
}

/** 生成方案 id：优先 crypto.randomUUID，兜底时间戳 + 随机串 */
export function newAiProfileId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProfile(raw: Partial<AiProfile> | null | undefined): AiProfile {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    id: str(raw?.id) || newAiProfileId(),
    name: str(raw?.name),
    provider: str(raw?.provider) || DEFAULT_AI_CONFIG.provider,
    model: str(raw?.model),
    apiKey: decodeApiKey(raw?.apiKey),
    baseUrl: str(raw?.baseUrl),
    temperature:
      typeof raw?.temperature === "number" && Number.isFinite(raw.temperature)
        ? raw.temperature
        : DEFAULT_AI_CONFIG.temperature,
    systemPrompt: str(raw?.systemPrompt),
  };
}

/** 清洗任意来源的方案集数据：字段兜底、去重、activeId 失效时回落到首个已配置方案 */
function sanitizeProfilesState(parsed: unknown): AiProfilesState {
  const rawList = (parsed as { profiles?: unknown } | null)?.profiles;
  const list = Array.isArray(rawList) ? (rawList as Partial<AiProfile>[]) : [];
  const profiles: AiProfile[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const profile = normalizeProfile(raw);
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  const rawActive = (parsed as { activeId?: unknown } | null)?.activeId;
  let activeId = typeof rawActive === "string" && seen.has(rawActive) ? rawActive : "";
  if (!activeId && profiles.length) {
    const fallback = profiles.find((p) => isAiConfigured(p)) ?? profiles[0];
    activeId = fallback.id;
  }
  return { activeId, profiles };
}

/** 历史单配置迁移：读旧键（enc1: 混淆与明文都兼容），转成一个「默认方案」 */
function migrateLegacyConfig(): AiProfilesState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    const profile = normalizeProfile({
      id: newAiProfileId(),
      name: "默认方案",
      provider: parsed.provider,
      model: parsed.model,
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl,
      temperature: parsed.temperature,
      systemPrompt: parsed.systemPrompt,
    });
    return { activeId: profile.id, profiles: [profile] };
  } catch {
    return null;
  }
}

/** 读取方案集：优先新键；无新键但有历史单配置时迁移；损坏时回空集 */
export function loadAiProfiles(): AiProfilesState {
  if (typeof localStorage === "undefined") return { ...EMPTY_PROFILES_STATE };
  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (!raw) {
      const migrated = migrateLegacyConfig();
      if (migrated) {
        // 迁移结果立即落盘：顺带把历史明文密钥转成混淆存放
        saveAiProfiles(migrated);
        return migrated;
      }
      return { ...EMPTY_PROFILES_STATE };
    }
    return sanitizeProfilesState(JSON.parse(raw));
  } catch {
    return { ...EMPTY_PROFILES_STATE };
  }
}

/** 持久化方案集：逐方案混淆密钥；activeId 指向不存在的方案时自动修正 */
export function saveAiProfiles(state: AiProfilesState): void {
  const clean = sanitizeProfilesState(state);
  const payload = {
    activeId: clean.activeId,
    profiles: clean.profiles.map((p) => ({ ...p, apiKey: encodeApiKey(p.apiKey) })),
  };
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(payload));
  notifyAiConfigChanged();
}

/** 新增或更新方案：id 已存在则整条替换。落盘后返回清洗后的最新方案集 */
export function upsertAiProfile(profile: AiProfile): AiProfilesState {
  const state = loadAiProfiles();
  const normalized = normalizeProfile(profile);
  const exists = state.profiles.some((p) => p.id === normalized.id);
  const next: AiProfilesState = {
    activeId: state.activeId,
    profiles: exists
      ? state.profiles.map((p) => (p.id === normalized.id ? normalized : p))
      : [...state.profiles, normalized],
  };
  // 当前方案缺失/失效（如首次添加）时，让新方案顶上
  if (!next.profiles.some((p) => p.id === next.activeId)) {
    next.activeId = normalized.id;
  }
  saveAiProfiles(next);
  return loadAiProfiles();
}

/** 删除方案：删的是当前方案时，回落到首个已配置方案（其次第一个），没有方案则清空 */
export function deleteAiProfile(id: string): AiProfilesState {
  const state = loadAiProfiles();
  const profiles = state.profiles.filter((p) => p.id !== id);
  let activeId = state.activeId;
  if (activeId === id) {
    const fallback = profiles.find((p) => isAiConfigured(p)) ?? profiles[0];
    activeId = fallback ? fallback.id : "";
  }
  saveAiProfiles({ activeId, profiles });
  return loadAiProfiles();
}

/** 一键切换当前方案；id 不存在时保持原状。落盘后返回最新方案集 */
export function setActiveAiProfile(id: string): AiProfilesState {
  const state = loadAiProfiles();
  if (!state.profiles.some((p) => p.id === id)) return state;
  saveAiProfiles({ ...state, activeId: id });
  return loadAiProfiles();
}

/**
 * 当前生效的模型配置：取「当前使用」方案（失效时回落第一个）。
 * 全应用的 AI 调用方（Agent、成绩导入、评语…）都从这里读，切换方案即全局生效。
 */
export function loadAiConfig(): AiConfig {
  const state = loadAiProfiles();
  const active = state.profiles.find((p) => p.id === state.activeId) ?? state.profiles[0];
  if (!active) return { ...DEFAULT_AI_CONFIG };
  return {
    provider: active.provider,
    model: active.model,
    apiKey: active.apiKey,
    baseUrl: active.baseUrl,
    temperature: active.temperature,
    systemPrompt: active.systemPrompt,
  };
}

/* ------------------------------------------------------------------ */
/* 校验 + 保存（设置页「保存并校验」）                                     */
/* ------------------------------------------------------------------ */

/**
 * 校验模型配置是否可用：向当前模型发一条最小对话，密钥 / 地址 / 模型 ID
 * 一次走通（Rust 侧任一环节失败都会返回错误说明）。浏览器演示态不联网。
 */
export async function verifyAiConfig(config: AiConfig): Promise<void> {
  if (!isTauri()) throw new Error("浏览器演示态不联网，无法校验。");
  await invoke<{ content: string }>("ai_chat", {
    params: {
      provider: config.provider,
      model: config.model,
      api_key: config.apiKey.trim() || null,
      base_url: config.baseUrl.trim() || null,
      messages: [{ role: "user", content: "ping" }],
    },
  });
}

/**
 * 校验通过才落盘：先 ping 一次当前方案配置，通了再写入方案集。
 * 校验失败原样抛错（调用方展示原因），已有方案保持原状不被覆盖。
 * 浏览器演示态不联网，退化为直接保存（返回 "saved-unchecked"）。
 */
export async function saveAiProfileVerified(
  profile: AiProfile
): Promise<"verified" | "saved-unchecked"> {
  if (isTauri()) {
    await verifyAiConfig(profile);
  }
  upsertAiProfile(profile);
  return isTauri() ? "verified" : "saved-unchecked";
}

/** 已选模型且（不需要密钥或已填密钥） */
export function isAiConfigured(config: AiConfig): boolean {
  const provider = aiProviderById(config.provider);
  if (!provider) return false;
  if (!config.model.trim()) return false;
  return !provider.needsKey || config.apiKey.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* 模型列表拉取（设置页「一键拉取」）                                      */
/* ------------------------------------------------------------------ */

/** 供应商支持的一个模型：id 是要填进「模型 ID」的值，name 是可读名（可缺省） */
export interface AiModelOption {
  id: string;
  name?: string;
}

/**
 * 拉取供应商当前支持的模型列表（走 Rust 侧 ai_list_models，密钥不出本机）。
 * 直接用设置页当前表单值（无需先保存）；浏览器演示态不联网。
 */
export async function listAiModels(
  config: Pick<AiConfig, "provider" | "apiKey" | "baseUrl">
): Promise<AiModelOption[]> {
  if (!isTauri()) throw new Error("浏览器演示态不联网，请在桌面端拉取。");
  return invoke<AiModelOption[]>("ai_list_models", {
    params: {
      provider: config.provider,
      api_key: config.apiKey.trim() || null,
      base_url: config.baseUrl.trim() || null,
    },
  });
}

/* ------------------------------------------------------------------ */
/* 错误友好化                                                            */
/* ------------------------------------------------------------------ */

export function aiErrorMessage(value: unknown): string {
  if (value instanceof Error) return aiFriendlyMessage(value.message);
  if (typeof value === "string" && value.trim()) return aiFriendlyMessage(value);
  return "AI 请求失败，请检查模型配置与网络。";
}

/** 单条错误规则的匹配子串 → 用户可见的友好说明。按顺序命中即返回。 */
const AI_ERROR_RULES: [RegExp, string][] = [
  // 网关把请求落到网页上（常见于 Base URL 写错、被风控劫持）
  [/not json|content[- ]type/i, "模型服务返回了无效内容，请检查「接口地址」是否正确（一般以 /v1 结尾），或稍后再试。"],
  [/401|unauthorized|invalid[ _-]?(api[ _-]?)?key|authentication/i, "API 密钥无效或已过期，请到「数据与设置」核对密钥。"],
  [/403|forbidden|region|restrict/i, "服务拒绝了本次请求，请确认密钥可用、账号未受限制（部分服务商有地区限制）。"],
  [/404|not[ _-]found|no such model|does not exist/i, "模型 ID 或接口地址不存在，请核对模型 ID 与服务商文档。"],
  [/429|rate[ _-]?limit|quota|insufficient|balance/i, "请求太频繁或额度不足，请稍后再试，或检查服务商账户余额。"],
  [/timed?[ _-]?out|timeout|connection|network|dns|refused|unreachable|reset/i, "网络连接失败，请检查网络后重试；若用代理请确认代理可用。"],
  [/serializ|invalid args|missing field/i, "请求参数异常，请到「数据与设置」重新保存模型配置。"],
];

/**
 * 把底层错误压成一句用户能看懂的提示。
 * 技术细节（堆栈、响应体、URL 等）不直接展示，完整错误由调用方写日志留存。
 */
function aiFriendlyMessage(raw: string): string {
  const line = raw.trim().split("\n")[0].slice(0, 200);
  for (const [pattern, message] of AI_ERROR_RULES) {
    if (pattern.test(line)) return message;
  }
  return `AI 请求失败，请检查模型配置与网络。（${line || "未知错误"}）`;
}
