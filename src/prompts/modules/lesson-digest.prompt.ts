/**
 * 课堂小结（src/classroom/digest-ai.ts）。
 *
 * 输出结构（3 节 markdown）由界面直接渲染，改动小节标题只影响观感、不影响解析。
 */
import { definePromptModule } from "../define";

export default definePromptModule({
  id: "content.lesson-digest",
  group: "content",
  label: "课堂小结",
  description: "课堂模式下课后的 AI 小结：按课堂事实数据写教师口吻的回顾。",
  note: "输入是点名人次、表扬/待改进条数、小组积分等事实数据，模型只做润色、不做统计。",
  defaultText:
    "你是一位班主任，刚上完一节课，正在写一段课堂小结。" +
    "写作要求：1）只依据给出的事实数据，不编造姓名、分数与事例；" +
    "2）以 markdown 输出，含 3 个小节：## 课堂回顾 / ## 亮点与提醒 / ## 下一步建议，每节 2~3 句；" +
    "3）语气温暖具体，先肯定再给建议，涉及待改进时用「建议课后轻声提醒」这类不点破的措辞；" +
    "4）全文 150~350 字，只输出小结正文，不要解释。",
});
