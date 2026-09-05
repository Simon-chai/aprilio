/**
 * 学生档案页的页面动作（声明式注册，default export 即被容器装载）。
 *
 * create-student 需要视图内部状态（对话框开关及预填字段），动作只负责广播，
 * StudentsView 通过 page-action-bus 挂监听接住 —— 动作本体不含视图引用。
 */
import { emitPageAction } from "../page-action-bus";
import { definePageAction } from "../define";

export interface CreateStudentPreset {
  name?: string;
  gender?: string;
  grade_class?: string;
  student_no?: string;
  guardian_phone?: string;
  note?: string;
}

export default definePageAction({
  page: "students",
  key: "create-student",
  label: "新建学生",
  description:
    "打开「新建学生」对话框，支持通过 args 预填姓名、性别、班级、学号、联系电话、备注等字段；填写与提交由用户在对话框内完成。",
  run: async (_ctx, rawArgs = {}) => {
    // ui_action 传入的可能是 { page, action, args: { ... } }，也可能是扁平参数
    const raw = (
      typeof rawArgs.args === "object" && rawArgs.args !== null ? rawArgs.args : rawArgs
    ) as Record<string, unknown>;

    const preset: CreateStudentPreset = {};
    if (typeof raw.name === "string" && raw.name.trim()) preset.name = raw.name.trim();
    if (typeof raw.gender === "string" && raw.gender.trim()) preset.gender = raw.gender.trim();
    if (typeof raw.grade_class === "string" && raw.grade_class.trim())
      preset.grade_class = raw.grade_class.trim();
    if (typeof raw.student_no === "string" && raw.student_no.trim())
      preset.student_no = raw.student_no.trim();
    if (typeof raw.guardian_phone === "string" && raw.guardian_phone.trim())
      preset.guardian_phone = raw.guardian_phone.trim();
    if (typeof raw.note === "string" && raw.note.trim()) preset.note = raw.note.trim();

    const delivered = emitPageAction("students/create-student", preset);
    if (!delivered) {
      return { ok: false, summary: "", error: "当前不在学生档案页或视图未挂载，无法打开新建对话框。" };
    }

    const keys = Object.keys(preset);
    const summary = keys.length
      ? `已打开「新建学生」对话框并预填信息（${keys.join("、")}），请在对话框内核对后提交。`
      : "已打开「新建学生」对话框，请在对话框内填写并提交。";

    return { ok: true, summary, data: preset };
  },
});
