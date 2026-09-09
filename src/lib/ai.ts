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

export function loadAiConfig(): AiConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULT_AI_CONFIG };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    const merged = { ...DEFAULT_AI_CONFIG, ...parsed };
    // 非字符串脏数据兜底为空；enc1: 混淆与历史明文都能读
    merged.apiKey = decodeApiKey(parsed.apiKey);
    return merged;
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function saveAiConfig(config: AiConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...config, apiKey: encodeApiKey(config.apiKey) }),
  );
}

/** 已选模型且（不需要密钥或已填密钥） */
export function isAiConfigured(config: AiConfig): boolean {
  const provider = aiProviderById(config.provider);
  if (!provider) return false;
  if (!config.model.trim()) return false;
  return !provider.needsKey || config.apiKey.trim().length > 0;
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
  [/404|not[ _-]found|no such model|does not exist/i, "模型名或接口地址不存在，请核对模型名称与服务商文档。"],
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
