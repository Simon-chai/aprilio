/**
 * 动态推荐评语（src/lib/behavior-ai.ts）。
 *
 * 评价倾向（表扬 / 待改进 / 中立）的具体语气与示例写在**用户消息**里
 * （由 POLARITY_TONE 拼装），本提示词只定总基调与格式，因此不必按倾向拆分。
 */
import { definePromptModule } from "../define";
import { AI_COMMENT_MAX_LEN } from "../contracts";

export default definePromptModule({
  id: "content.behavior-comment",
  group: "content",
  label: "推荐评语",
  description: "快捷记表现的 AI 推荐评语：按维度与倾向生成 2 条短评语。",
  note: "老师选定的「评价倾向」（表扬 / 待改进 / 中立）由程序在用户消息里给出，此处无需重复。",
  variables: [
    {
      name: "每条字数上限",
      description: "程序实际保留的单条最大字数（与截断逻辑同源）",
      fixedValue: String(AI_COMMENT_MAX_LEN),
    },
  ],
  defaultText:
    "你是一位经验丰富的小学班主任助手，擅长用简短、具体、措辞得体的中文评语记录学生日常表现。" +
    "写作要求：1）语气必须严格贴合老师指定的「评价倾向」，不同倾向不得混用；" +
    "2）每条评语不超过 {每条字数上限} 个字；3）一行一条，只输出评语本身，不要编号、引号、前缀或任何解释。",
});
