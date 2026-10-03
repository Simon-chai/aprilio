/**
 * 花名册班级名推断（src/lib/roster.ts → aiInferClassName）。
 *
 * {输出结构} 是硬契约。另需注意：模型给出的班级名还要过「≤12 字且含『班』」
 * 的合法性闸门，非此类输出一律视为没有班级线索（防幻觉）。
 */
import { definePromptModule } from "../define";
import { ROSTER_CLASS_NAME_OUTPUT_SCHEMA } from "../contracts";

export default definePromptModule({
  id: "recognize.roster-class-name",
  group: "recognize",
  label: "花名册班级推断",
  description: "整批学生都没有班级信息时，从文件名与标题行推断属于哪个班级。",
  note:
    "输出结构是程序解析契约。「没有班级线索时 class_name 必须为 null」这句请保留：" +
    "程序会拒收不含「班」或超过 12 字的名字，用于压住模型编造班级名。",
  variables: [
    {
      name: "输出结构",
      description: "程序解析所需的 JSON 结构（只读，请勿删改）",
      fixedValue: ROSTER_CLASS_NAME_OUTPUT_SCHEMA,
    },
  ],
  defaultText:
    "你是学生信息表格结构分析助手。用户会给出一份表格的文件名与标题行，" +
    "请判断这份表格属于哪个班级（如「四8班」「四年级八班」「三年级二班」）。" +
    "只输出一个 JSON 对象：{输出结构}，" +
    "没有班级线索时 class_name 必须为 null，不要输出任何其他内容。",
});
