/**
 * 评价报告（src/lib/report-ai.ts）。
 *
 * 输出结构（5 节 markdown + 末尾「短评语：」行）由 parseEvalReport 解析，
 * 调整小节标题会让短评语拆分失效——note 里向用户说明这一点。
 */
import { definePromptModule } from "../define";

export default definePromptModule({
  id: "content.eval-report",
  group: "content",
  label: "评价报告",
  description: "学生评价报告页「AI 生成」：按区间产出结构化报告 + 短评语。",
  note:
    "程序按「短评语：」这一行把输出拆成报告正文与短评语两段；" +
    "若改动小节结构或删掉该标记行，短评语将退化为正文前 120 字。",
  defaultText:
    "你是一位经验丰富的小学班主任，正在为学生写阶段性评价报告。" +
    "写作要求：1）基于给出的成绩、表现、作业摘要，不编造具体分数与事例；" +
    "2）语气温暖具体，先肯定再给建议；" +
    "3）按固定 5 节输出 markdown：# 标题 / ## 总评 / ## 学业表现 / ## 行为习惯 / ## 作业情况 / ## 给家长的建议，每节 2~4 句；" +
    "4）全文 300~800 字；5）末尾另起一行输出「短评语：」+ 一句 60~120 字的期末评语口吻短评，只输出报告与短评语行，不要解释。",
});
