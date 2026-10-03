/**
 * 提示词分组 taxonomy。
 *
 * 分组是**少量且稳定**的分类（智能助手 / 内容生成 / 信息识别），
 * 因此写成静态登记表而不是扫描产物：新增模块只需挑一个已有分组，
 * 不必改这里；确实需要新分组时在此加一行即可。
 *
 * 未登记的 group 不会让模块丢失 —— registry 会把它们收进「其他」兜底分组。
 */

export interface PromptGroup {
  id: string;
  label: string;
  /** 分组说明（管理页分组标题下的弱化文字） */
  description: string;
}

/** 分组展示顺序 = 本数组顺序 */
export const PROMPT_GROUPS: PromptGroup[] = [
  {
    id: "assistant",
    label: "智能助手",
    description: "全站 AI 助手（右下角对话浮层）的主提示词",
  },
  {
    id: "content",
    label: "内容生成",
    description: "评语、评价报告、课堂小结等成段文字的生成",
  },
  {
    id: "recognize",
    label: "信息识别",
    description: "表格结构与标签语义的识别判定（多为 JSON 契约输出）",
  },
];

/** 未登记分组的兜底容器（fail-safe：新分组忘了登记，模块仍然可见可编辑） */
export const PROMPT_GROUP_FALLBACK: PromptGroup = {
  id: "__other__",
  label: "其他",
  description: "尚未登记分组的新模块（在 groups.ts 补一行即可归类）",
};
