/**
 * 提示词模块 id 常量：调用方 `resolvePrompt(PROMPT_IDS.termComment, …)`，
 * 避免字符串字面量散落各处拼错（拼错只会静默拿到空提示词，属于最难查的那类问题）。
 *
 * 新增模块时在这里补一行（与 modules/ 下的文件名对应）。
 */
export const PROMPT_IDS = {
  /** 全站 AI 助手主提示词 */
  agent: "assistant.agent",
  /** 学期评语草稿 */
  termComment: "content.term-comment",
  /** 家校沟通总结（指定时段内评价 → 给家长的表现总结） */
  parentSummary: "content.parent-summary",
  /** 评价报告 */
  evalReport: "content.eval-report",
  /** 课堂小结 */
  lessonDigest: "content.lesson-digest",
  /** 动态推荐评语 */
  behaviorComment: "content.behavior-comment",
  /** 备忘快速浏览标题 */
  memoTitle: "content.memo-title",
  /** 通用文本润色（各输入框旁「AI 润色」按钮共用） */
  textPolish: "content.text-polish",
  /** 花名册姓名列识别 */
  rosterNameColumn: "recognize.roster-name-column",
  /** 花名册班级名推断 */
  rosterClassName: "recognize.roster-class-name",
  /** 成绩单结构识别 */
  scoreSheet: "recognize.score-sheet",
  /** 监护人标签情感倾向 */
  guardianTag: "recognize.guardian-tag",
} as const;
