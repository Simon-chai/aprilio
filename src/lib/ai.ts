import { invoke } from "@tauri-apps/api/core";
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
/* 配置：存本机 localStorage，密钥不出本机                               */
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

export function loadAiConfig(): AiConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULT_AI_CONFIG };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AiConfig>;
    return { ...DEFAULT_AI_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function saveAiConfig(config: AiConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** 已选模型且（不需要密钥或已填密钥） */
export function isAiConfigured(config: AiConfig): boolean {
  const provider = aiProviderById(config.provider);
  if (!provider) return false;
  if (!config.model.trim()) return false;
  return !provider.needsKey || config.apiKey.trim().length > 0;
}

/* ------------------------------------------------------------------ */
/* 聊天                                                                 */
/* ------------------------------------------------------------------ */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** 浏览器演示态（无 Tauri 外壳）的兜底回复 */
const DEMO_REPLY =
  "当前是浏览器演示态，AI 请求由桌面端 Rust 后端发出。运行 `npm run tauri:dev` 并在「数据与设置」里配好模型后再试试。";

export async function aiChat(messages: ChatTurn[], config: AiConfig): Promise<string> {
  if (!isTauri()) {
    await new Promise((r) => setTimeout(r, 600));
    return DEMO_REPLY;
  }

  return invoke<string>("ai_chat", {
    params: {
      provider: config.provider,
      model: config.model,
      api_key: config.apiKey.trim() || null,
      base_url: config.baseUrl.trim() || null,
      temperature: config.temperature,
      system_prompt: config.systemPrompt.trim() || null,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
  });
}

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
