/**
 * 声明式注册工厂 —— 提示词模块的「@Component」（对齐 agent/define.ts 的写法）。
 *
 * 模块文件 default export 一个 definePromptModule() 的产物，
 * registry 通过 import.meta.glob 扫描装载。字段非法在**装载期**就抛错，
 * 不拖到运行期才暴露（对齐能力容器「重复注册立即报错」的 fail-fast 惯例）。
 */
import type { PromptModule, PromptVariable } from "./types";

/** 变量名不允许含空格与花括号：前者会与自然的文字混淆，后者破坏占位符语法 */
const VARIABLE_NAME_RE = /^[^{}\s]+$/;
/** 模块 id：小写字母数字起头，允许点与连字符分段（content.term-comment） */
const MODULE_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;

function normalizeVariables(id: string, raw: PromptVariable[] | undefined): PromptVariable[] {
  const out: PromptVariable[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    const name = String(item?.name ?? "").trim();
    if (!name) throw new Error(`提示词模块 ${id} 存在空变量名`);
    if (!VARIABLE_NAME_RE.test(name)) {
      throw new Error(`提示词模块 ${id} 的变量名非法（不能含空格或花括号）：${name}`);
    }
    if (seen.has(name)) throw new Error(`提示词模块 ${id} 的变量重复：${name}`);
    seen.add(name);

    const description = String(item?.description ?? "").trim();
    if (!description) throw new Error(`提示词模块 ${id} 的变量 ${name} 缺少说明`);

    out.push({
      name,
      description,
      fixedValue: item.fixedValue === undefined ? undefined : String(item.fixedValue),
      defaultValue: item.defaultValue === undefined ? undefined : String(item.defaultValue),
      sample: item.sample === undefined ? undefined : String(item.sample),
    });
  }
  return out;
}

export function definePromptModule(spec: PromptModule): PromptModule {
  const id = String(spec?.id ?? "").trim();
  if (!MODULE_ID_RE.test(id)) {
    throw new Error(`提示词模块 id 非法（应形如 content.term-comment）：${spec?.id}`);
  }
  const group = String(spec?.group ?? "").trim();
  if (!group) throw new Error(`提示词模块 ${id} 缺少 group`);
  const label = String(spec?.label ?? "").trim();
  if (!label) throw new Error(`提示词模块 ${id} 缺少 label`);
  const description = String(spec?.description ?? "").trim();
  if (!description) throw new Error(`提示词模块 ${id} 缺少 description`);

  // 默认正文首尾空白裁掉：占位符替换与空行折叠都以「无外沿空白」为前提
  const defaultText = String(spec?.defaultText ?? "").trim();
  if (!defaultText) throw new Error(`提示词模块 ${id} 的默认正文为空`);

  const note = String(spec?.note ?? "").trim();

  return {
    id,
    group,
    label,
    description,
    defaultText,
    variables: normalizeVariables(id, spec?.variables),
    note: note || undefined,
  };
}
