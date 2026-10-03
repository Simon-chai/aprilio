/**
 * 成绩单结构识别（src/lib/scores.ts → aiDetectScoreSheet）。
 *
 * {输出结构} 是**硬契约**：列号语义（姓名列从 1 起、科目 column 转 0 起）与
 * JSON 键名都被 aiDetectScoreSheet 直接解析，改键名会让识别整体失效，
 * 因此作为只读变量注入、不鼓励改写。
 */
import { definePromptModule } from "../define";
import { SCORE_SHEET_OUTPUT_SCHEMA } from "../contracts";

export default definePromptModule({
  id: "recognize.score-sheet",
  group: "recognize",
  label: "成绩单结构识别",
  description: "导入成绩单时判断姓名列、科目列，并提取考试名与考试时间。",
  note:
    "输出结构是程序解析契约：键名与列号语义不能改动，否则识别结果会被判为无效并回退规则识别。" +
    "科目「column」为从 1 起的列号，程序内部转 0 起。",
  variables: [
    {
      name: "输出结构",
      description: "程序解析所需的 JSON 结构（只读，请勿删改）",
      fixedValue: SCORE_SHEET_OUTPUT_SCHEMA,
    },
  ],
  defaultText:
    "你是成绩单结构分析助手。请判断表格中哪一列是学生姓名，哪些列是考试科目成绩（总分/排名/平均分等汇总列不算科目），" +
    "并从标题行提取考试名称与考试时间。" +
    "只输出一个 JSON 对象：{输出结构}，" +
    "不要输出任何其他内容。",
});
