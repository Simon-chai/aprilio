/**
 * 工具：navigate —— 页面跳转（声明式注册，default export 即被容器装载）。
 *
 * NAV_TARGETS 是「应用界面注册表」：Agent 可达页面的唯一清单。
 * 以后新增页面/界面级操作，在这里登记一行即可被 Agent 感知。
 */
import { getStudent } from "../../lib/db";
import { defineAgentTool } from "../define";

export interface NavTarget {
  key: string;
  routeName: string;
  label: string;
  description: string;
}

/** Agent 可跳转的页面注册表（student-detail 走单独分支，需要 student_id） */
export const NAV_TARGETS: NavTarget[] = [
  { key: "home", routeName: "home", label: "首页", description: "教师个性展示与应用入口" },
  { key: "classes", routeName: "classes", label: "班级管理", description: "按班级浏览与组织学生" },
  { key: "students", routeName: "students", label: "学生档案", description: "学生列表、搜索与新增" },
  { key: "photos", routeName: "photos", label: "照片墙", description: "全部照片记录" },
  { key: "profile", routeName: "profile", label: "个人资料", description: "教师姓名、格言、头像与大图" },
  { key: "settings", routeName: "settings", label: "数据与设置", description: "AI 模型配置与数据管理" },
];

export default defineAgentTool({
  name: "navigate",
  label: "界面跳转",
  description:
    "打开或切换应用内的某个页面。target 从枚举中选择；跳到学生详情页时 target 用 student-detail 并提供 student_id。",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: [...NAV_TARGETS.map((t) => t.key), "student-detail"],
        description: "要打开的页面",
      },
      student_id: {
        type: "number",
        description: "学生 ID，仅 target=student-detail 时必填",
      },
    },
    required: ["target"],
  },
  async execute(args, ctx) {
    const target = String(args.target ?? "").trim();

    if (target === "student-detail") {
      const id = Number(args.student_id);
      if (!Number.isInteger(id) || id <= 0) {
        return { ok: false, summary: "", error: "缺少有效的 student_id，无法打开学生详情。" };
      }
      const student = await getStudent(id);
      if (!student) {
        return { ok: false, summary: "", error: `找不到 ID 为 ${id} 的学生。` };
      }
      await ctx.router.push({ name: "student-detail", params: { id: String(id) } });
      return { ok: true, summary: `已打开「学生档案 · ${student.name}」详情页面。`, data: { id, name: student.name } };
    }

    const nav = NAV_TARGETS.find((t) => t.key === target);
    if (!nav) {
      const keys = NAV_TARGETS.map((t) => t.key).join("、");
      return { ok: false, summary: "", error: `未知页面 "${target}"，可选：${keys}。` };
    }

    await ctx.router.push({ name: nav.routeName });
    return { ok: true, summary: `已打开「${nav.label}」页面。`, data: { target: nav.key } };
  },
});
