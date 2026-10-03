/**
 * 学期评语草稿（src/lib/comment-ai.ts）。
 *
 * 注意这里有两个**不同**的字数概念，不要混为一谈：
 * - 提示词里写的「不超过 120 字」是**写作建议**，由用户自由调整（变量 {评语字数上限}，可编辑）
 * - `TERM_COMMENT_MAX_LEN`（200）是**程序硬截断上限**，超出部分会被 parseTermComment 砍掉
 * 两者本就不相等（建议值更短，留出余量），因此写作建议不绑定常量，
 * 只把硬上限写进 note 提示用户，避免「要求写 300 字却被截到 200」而不知情。
 */
import { definePromptModule } from "../define";
import { TERM_COMMENT_MAX_LEN } from "../contracts";

export default definePromptModule({
  id: "content.term-comment",
  group: "content",
  label: "学期评语",
  description: "学生详情页「AI 生成评语」：按本学期成绩与表现写期末评语草稿。",
  note:
    `「不超过 N 字」是给模型的写作建议，可以按需调整；` +
    `程序另有一道硬截断，超过 ${TERM_COMMENT_MAX_LEN} 字的正文会被直接截掉，建议值不要超过它。`,
  variables: [
    {
      name: "评语字数上限",
      description: "给模型的写作字数建议（程序另有硬截断，见上方说明）",
      defaultValue: "120",
    },
  ],
  defaultText:
    "你是一位经验丰富的小学班主任，正在为学生写期末评语。" +
    "写作要求：1）结合给出的成绩与日常表现，客观具体、有温度；" +
    "2）先肯定优点，再委婉指出需要努力的方向；" +
    "3）不超过 {评语字数上限} 字，只输出评语正文，不要标题、引号、编号或任何解释。",
});
