/**
 * 系统提示词管理：契约类型（详见 docs/PROMPT_MANAGEMENT.md）。
 *
 * 设计原则：
 * - 提示词与业务解耦：模块只声明「正文 + 可用变量」，怎么取用由调用方决定
 * - 默认值是代码资产，本机覆盖值只存差异（默认文案随版本演进而自动生效）
 * - 零业务耦合：本目录不认识学生、成绩、评语，只认识「一段可替换的文本」
 */

/** 提示词正文里可用的一处占位符 */
export interface PromptVariable {
  /** 占位符名，正文中以 {名称} 引用 */
  name: string;
  /** 界面说明：这个变量会代入什么 */
  description: string;
  /**
   * 程序固定注入的值 = **契约变量**。
   *
   * 存在即表示「正文应当保留该占位符」：它是解析器期待的 JSON 结构，
   * 或与代码里的硬上限同源。删掉就会让提示词与程序行为脱节，
   * 因此界面只读展示、渲染预览，并在正文缺失时给出警告（不阻断）。
   */
  fixedValue?: string;
  /**
   * 可编辑变量的默认值：调用方未显式传值时由 resolvePrompt 兜底。
   *
   * 与 fixedValue 的区别是「谁说了算」：defaultValue 是给用户的起点
   * （如写作字数建议），调用方仍可按场景覆盖；fixedValue 则是程序的硬要求。
   */
  defaultValue?: string;
  /** 预览示例：仅当既无 fixedValue 也无 defaultValue 时用于渲染预览 */
  sample?: string;
}

/** 一个提示词模块 = 应用里某一处 AI 功能的 system 提示词 */
export interface PromptModule {
  /** 稳定唯一 id，`分组.名称` 形式（如 content.term-comment）；作为覆盖值的存储键 */
  id: string;
  /** 所属分组（取自 groups.ts 的登记项；未登记会归入「其他」渲染） */
  group: string;
  /** 界面显示名 */
  label: string;
  /** 这一处提示词是干什么的（界面副标题） */
  description: string;
  /** 内置默认正文：出厂设置，唯一事实源 */
  defaultText: string;
  /** 可用占位符；无占位符可省略 */
  variables?: PromptVariable[];
  /** 额外注意事项（界面展示，如「输出需为 JSON，程序按此解析」） */
  note?: string;
}

/** 单条本机覆盖值 */
export interface PromptOverride {
  /** 用户自定义正文 */
  text: string;
  /** 写入时间（ISO 字符串，仅供排查与展示） */
  updated_at: string;
}

/** 本机覆盖值集合（localStorage 结构） */
export interface PromptStoreState {
  version: 1;
  overrides: Record<string, PromptOverride>;
}
