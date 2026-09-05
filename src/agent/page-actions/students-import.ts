/**
 * 学生档案页的页面动作：导入花名册（声明式注册，default export 即被容器装载）。
 *
 * 动作只负责打开对话框（文件选择、姓名列确认与导入都由用户在对话框内完成），
 * StudentsView 通过 page-action-bus 挂监听接住 —— 动作本体不含视图引用。
 * 对话框内的「智能导入」与 Agent 工具 import_student_roster 共用同一条管道。
 */
import { emitPageAction } from "../page-action-bus";
import { definePageAction } from "../define";

export type ImportRosterMode = "template" | "smart";

export default definePageAction({
  page: "students",
  key: "import-roster",
  label: "导入花名册",
  description:
    "打开「导入花名册」对话框。支持指定格式导入（标准模板表头）与智能导入（自动识别姓名列，其余列按表头映射）；文件选择与导入确认由用户在对话框内完成。",
  run: async (_ctx, rawArgs = {}) => {
    // ui_action 传入的可能是 { page, action, args: { ... } }，也可能是扁平参数
    const raw = (
      typeof rawArgs.args === "object" && rawArgs.args !== null ? rawArgs.args : rawArgs
    ) as Record<string, unknown>;

    const mode: ImportRosterMode = raw.mode === "template" ? "template" : "smart";
    const delivered = emitPageAction<ImportRosterMode>("students/import-roster", mode);
    if (!delivered) {
      return { ok: false, summary: "", error: "当前不在学生档案页或视图未挂载，无法打开导入对话框。" };
    }

    return {
      ok: true,
      summary:
        mode === "template"
          ? "已打开「导入花名册」对话框（指定格式模式），请选择标准模板文件后确认导入。"
          : "已打开「导入花名册」对话框（智能导入模式），选择文件后将自动识别姓名列。",
      data: { mode },
    };
  },
});
