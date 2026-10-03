/**
 * 备忘快速浏览标题（src/lib/memo-ai.ts）。
 *
 * {标题字数上限} 是契约变量：`MEMO_TITLE_MAX_LEN` 与 parseMemoTitle 的截断长度同源。
 */
import { definePromptModule } from "../define";
import { MEMO_TITLE_MAX_LEN } from "../contracts";

export default definePromptModule({
  id: "content.memo-title",
  group: "content",
  label: "备忘快速标题",
  description: "课表日历里把备忘正文浓缩成一行快速浏览标题。",
  note: "生成结果会落库并永久复用（不重复调用模型），改提示词后仅对之后新建的备忘生效。",
  variables: [
    {
      name: "标题字数上限",
      description: "程序实际保留的最大字数（与截断逻辑同源）",
      fixedValue: String(MEMO_TITLE_MAX_LEN),
    },
  ],
  defaultText:
    "你是小学班主任助手。把日程备忘浓缩成一个不超过 {标题字数上限} 个字的快速浏览标题：" +
    "保留时间、班级、科目、事项等关键信息，只输出标题本身，不要引号、句号或任何解释。",
});
