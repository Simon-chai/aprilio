/**
 * 花名册姓名列识别（src/lib/roster.ts → aiDetectNameColumn）。
 *
 * {输出结构} 是硬契约，键名与列号语义被 aiDetectNameColumn 解析。
 */
import { definePromptModule } from "../define";
import { ROSTER_NAME_COLUMN_OUTPUT_SCHEMA } from "../contracts";

export default definePromptModule({
  id: "recognize.roster-name-column",
  group: "recognize",
  label: "花名册姓名列识别",
  description: "导入花名册时判断哪一列是学生姓名，与规则识别结果合成。",
  note:
    "输出结构是程序解析契约：键名与列号语义不能改动。" +
    "识别结果只有在规则列候选内才会被判为高置信，改提示词也绕不过确认流程。",
  variables: [
    {
      name: "输出结构",
      description: "程序解析所需的 JSON 结构（只读，请勿删改）",
      fixedValue: ROSTER_NAME_COLUMN_OUTPUT_SCHEMA,
    },
  ],
  defaultText:
    "你是表格结构分析助手。用户会给出一张表格各列的表头与示例值，" +
    "请判断哪一列最有可能是「学生姓名」。只输出一个 JSON 对象：" +
    "{输出结构}，" +
    "不要输出任何其他内容。",
});
