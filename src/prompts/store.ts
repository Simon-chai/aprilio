/**
 * 提示词覆盖值存储：本机 localStorage，只存「与默认值的差异」。
 *
 * 为什么默认值不进存储：默认文案是随代码演进的出厂设置，必须能随需求一起
 * review / 测试 / 发版。若把默认值也落盘，升级版本后用户会一直停在旧文案上。
 * 只存差异 ⇒ 未被自定义过的模块自动跟随新版本默认值。
 *
 * 兼容：新增键 aprilio.prompts.v1，不改数据库与任何既有存储格式；
 * 历史版本没有该键 = 全部走默认，行为与引入本机制前逐字一致。
 */
import { ref } from "vue";
import type { PromptOverride, PromptStoreState } from "./types";

const STORAGE_KEY = "aprilio.prompts.v1";

const EMPTY_STATE: PromptStoreState = { version: 1, overrides: {} };

/** 覆盖值变更版本号：localStorage 读取不具备响应性，界面依赖它刷新 */
export const promptVersion = ref(0);

function notifyChanged(): void {
  promptVersion.value += 1;
}

/** 清洗任意来源的存储数据：非法结构一律回落空集（等同全部默认），绝不让坏数据影响 AI 功能 */
export function sanitizePromptState(parsed: unknown): PromptStoreState {
  const rawOverrides = (parsed as { overrides?: unknown } | null)?.overrides;
  if (!rawOverrides || typeof rawOverrides !== "object") return { ...EMPTY_STATE };

  const overrides: Record<string, PromptOverride> = {};
  for (const [id, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
    const key = id.trim();
    if (!key) continue;
    const text = (value as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) continue;
    const updatedAt = (value as { updated_at?: unknown } | null)?.updated_at;
    overrides[key] = {
      text,
      updated_at: typeof updatedAt === "string" ? updatedAt : "",
    };
  }
  return { version: 1, overrides };
}

/** 读取全部覆盖值；存储不可用 / 损坏时返回空集 */
export function loadPromptOverrides(): Record<string, PromptOverride> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizePromptState(JSON.parse(raw)).overrides;
  } catch {
    return {};
  }
}

/** 取单个模块的覆盖正文；没有自定义返回 undefined */
export function loadPromptOverride(id: string): string | undefined {
  return loadPromptOverrides()[id]?.text;
}

function writeOverrides(overrides: Record<string, PromptOverride>): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, overrides }));
    }
  } catch {
    // 存储不可用不影响提示词主流程（本次会话内仍按内存值生效）
  }
  notifyChanged();
}

/**
 * 写入单个模块的自定义正文。
 * 正文为空（或只有空白）视为「恢复默认」——删除该条覆盖，回到内置文案。
 */
export function savePromptOverride(id: string, text: string): void {
  const key = id.trim();
  if (!key) return;
  const overrides = { ...loadPromptOverrides() };
  if (!text.trim()) {
    delete overrides[key];
  } else {
    overrides[key] = { text, updated_at: new Date().toISOString() };
  }
  writeOverrides(overrides);
}

/** 恢复单个模块的默认文案 */
export function resetPromptOverride(id: string): void {
  const key = id.trim();
  if (!key) return;
  const overrides = { ...loadPromptOverrides() };
  if (!(key in overrides)) return;
  delete overrides[key];
  writeOverrides(overrides);
}

/** 恢复全部模块的默认文案（清空覆盖集合） */
export function resetAllPromptOverrides(): void {
  writeOverrides({});
}

/** 已自定义的模块 id 集合（界面统计与「已自定义」标记共用） */
export function customizedPromptIds(): Set<string> {
  return new Set(Object.keys(loadPromptOverrides()));
}
