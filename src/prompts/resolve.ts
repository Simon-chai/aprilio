/**
 * 提示词取值：`resolvePrompt(id, vars)` = 「本机覆盖值 ?? 内置默认值」→ 替换占位符。
 *
 * 占位符规则（详见 docs/PROMPT_MANAGEMENT.md）：
 * - `{名称}` 命中变量 → 替换为传入值
 * - 整行占位符**全部取到空值**时，连同该行一起删除（避免留下「补充设定（用户自定义）：」空壳）
 * - 未声明的占位符原样保留（用户拼错时看得见，不静默吞掉）
 * - 单遍替换：变量值里出现花括号不会被二次替换（JSON 契约值因此安全）
 * - 连续空行折叠为一个；首尾空白裁掉
 */
import { getPromptModule } from "./registry";
import { loadPromptOverride } from "./store";
import type { PromptModule, PromptOverride } from "./types";

/** 覆盖值集合（store 的存储形态，作为本模块各取值函数的统一入参） */
export type PromptOverrideMap = Record<string, PromptOverride>;

/** 占位符语法：{名称}；名称不含花括号 */
const PLACEHOLDER_RE = /\{([^{}]+)\}/g;

/** 单行内的替换结果 */
interface LineResult {
  text: string;
  /** 该行出现的占位符名（去重） */
  names: string[];
  /** 其中取到空值的占位符数 */
  emptyCount: number;
}

function resolveLine(line: string, vars: Record<string, string>): LineResult {
  const names: string[] = [];
  let emptyCount = 0;
  const text = line.replace(PLACEHOLDER_RE, (raw, name: string) => {
    const key = String(name).trim();
    if (!(key in vars)) return raw; // 未声明的占位符原样保留
    if (!names.includes(key)) names.push(key);
    const value = String(vars[key] ?? "");
    if (!value.trim()) {
      emptyCount += 1;
      return "";
    }
    return value;
  });
  return { text, names, emptyCount };
}

/**
 * 用变量渲染一段提示词正文。
 * 导出的原因：管理页的「预览」与运行期取值必须共用同一套语义，不能两说。
 */
export function renderPromptText(text: string, vars: Record<string, string> = {}): string {
  const lines = String(text ?? "").split(/\r?\n/);

  const kept: string[] = [];
  for (const line of lines) {
    const result = resolveLine(line, vars);
    // 该行有占位符、且它们全部取到空值 → 整行删除（空壳不落地）
    if (result.names.length > 0 && result.emptyCount === result.names.length) continue;
    kept.push(result.text);
  }

  // 连续空行折叠为一个；首尾空白裁掉
  const collapsed: string[] = [];
  for (const line of kept) {
    if (!line.trim() && !collapsed.length) continue; // 开头空行
    if (!line.trim() && !collapsed[collapsed.length - 1].trim()) continue; // 连续空行
    collapsed.push(line);
  }
  return collapsed.join("\n").trim();
}

/**
 * 取模块的生效正文：有自定义用自定义，否则用内置默认。
 *
 * 入参直接就是 store 的覆盖值集合（`loadPromptOverrides()` 的返回），
 * 中间不做形态转换——多一层「对象 ↔ 字符串」转换就多一处能写错的地方。
 */
export function effectivePromptText(
  mod: PromptModule,
  overrides: PromptOverrideMap = {},
): string {
  const custom = overrides[mod.id]?.text;
  return custom && custom.trim() ? custom : mod.defaultText;
}

/**
 * 取值入口：返回该模块最终发给模型的 system 字符串。
 *
 * 契约变量（`fixedValue`）由本函数**自动注入**，调用方不必也不该重复传：
 * 它们要么是解析器期待的 JSON 结构、要么与代码里的截断长度同源，
 * 让每个调用点各自传值迟早会漂移。调用方传入的同名值优先（便于测试与特例）。
 *
 * 模块不存在时返回空串并告警——**不抛错**：提示词取值在 AI 调用路径上，
 * 抛错会连带让评语、导入等主流程失败，而「没有系统提示词」本身不是致命问题。
 */
export function resolvePrompt(id: string, vars: Record<string, string> = {}): string {
  const mod = getPromptModule(id);
  if (!mod) {
    console.warn(`[prompts] 未注册的提示词模块：${id}`);
    return "";
  }
  const merged: Record<string, string> = {};
  for (const v of mod.variables ?? []) {
    // 契约变量优先于可编辑默认值；两者都没有时留给调用方传
    const fallback = v.fixedValue ?? v.defaultValue;
    if (fallback !== undefined) merged[v.name] = fallback;
  }
  Object.assign(merged, vars);

  const custom = loadPromptOverride(mod.id);
  const text = custom && custom.trim() ? custom : mod.defaultText;
  return renderPromptText(text, merged);
}

/** 取模块的生效正文与完整变量表（管理页预览用：与运行期同一套取值语义） */
export function promptPreview(
  mod: PromptModule,
  overrides: PromptOverrideMap = {},
  vars: Record<string, string> = {},
): string {
  const merged: Record<string, string> = {};
  for (const v of mod.variables ?? []) {
    const fallback = v.fixedValue ?? v.defaultValue ?? v.sample ?? "";
    if (fallback) merged[v.name] = fallback;
  }
  Object.assign(merged, vars);
  return renderPromptText(effectivePromptText(mod, overrides), merged);
}

/** 正文里缺失契约变量的占位符名（管理页保存前提示用，不阻断保存） */
export function missingContractVariables(mod: PromptModule, text: string): string[] {
  return (mod.variables ?? [])
    .filter((v) => v.fixedValue !== undefined)
    .filter((v) => !new RegExp(`\\{${escapeRegExp(v.name)}\\}`).test(text))
    .map((v) => v.name);
}

/** 正文里出现但模块未声明的占位符名（拼错时的提示） */
export function unknownPlaceholders(mod: PromptModule, text: string): string[] {
  const declared = new Set((mod.variables ?? []).map((v) => v.name));
  const found = new Set<string>();
  for (const match of String(text ?? "").matchAll(PLACEHOLDER_RE)) {
    const name = match[1].trim();
    if (name && !declared.has(name)) found.add(name);
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
