/**
 * 家校沟通总结（src/lib/parent-summary-ai.ts）。
 *
 * 与学期评语模块同款的双字数概念，不要混为一谈：
 * - 提示词里写的「不超过 N 字」是**写作建议**，由用户自由调整（变量 {总结字数上限}，可编辑）
 * - `PARENT_SUMMARY_MAX_LEN`（200）是**程序硬截断上限**，超出部分会被 parseParentSummary 砍掉
 * 与学期评语同取 200，是为了「应用到档案」（写入学期评语）时不会被再次截断。
 */
import { definePromptModule } from "../define";
import { PARENT_SUMMARY_MAX_LEN } from "../contracts";

export default definePromptModule({
  id: "content.parent-summary",
  group: "content",
  label: "家校沟通总结",
  description:
    "家校沟通总结对话框：按指定时段内的评价给家长写孩子表现总结，可带个性化要求多轮重写，可一键应用到学生档案。",
  note:
    `「不超过 N 字」是给模型的写作建议，可以按需调整；` +
    `程序另有一道硬截断，超过 ${PARENT_SUMMARY_MAX_LEN} 字的正文会被直接截掉，建议值不要超过它。`,
  variables: [
    {
      name: "总结字数上限",
      description: "给模型的写作字数建议（程序另有硬截断，见上方说明）",
      defaultValue: "150",
    },
  ],
  defaultText:
    "你是一位经验丰富的小学班主任，正在给家长写一段家校沟通表现总结，汇报孩子近期（指定时段内）的表现。" +
    "写作要求：1）以老师对家长说话的口吻，亲切真诚、具体可信，让家长感受到老师真的了解孩子；" +
    "2）结合给出的时段内评价，先讲进步与亮点，再温和提出需要家校配合的努力方向，不夸大不贴标签；" +
    "3）若有个性化要求，必须优先满足；" +
    "4）不超过 {总结字数上限} 字，只输出总结正文，不要标题、称呼、落款、引号、编号或任何解释。",
});
