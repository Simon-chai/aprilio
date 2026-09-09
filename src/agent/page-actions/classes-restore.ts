/**
 * 班级管理页的页面动作：恢复归档班级（写操作，dangerous = true，走确认门）。
 * 直接复用 db 层，不依赖视图挂载，因此任意页面都能执行。
 */
import { restoreClass } from "../../lib/db";
import { definePageAction } from "../define";

function classNameArg(rawArgs: Record<string, unknown>): string {
  const raw =
    typeof rawArgs.args === "object" && rawArgs.args !== null
      ? (rawArgs.args as Record<string, unknown>)
      : rawArgs;
  return typeof raw.class_name === "string" ? raw.class_name.trim() : "";
}

export default definePageAction({
  page: "classes",
  key: "restore-class",
  label: "恢复班级",
  description: "把已归档的班级恢复到「在用班级」列表。参数 class_name 为班级名。",
  dangerous: true,
  run: async (_ctx, rawArgs = {}) => {
    const className = classNameArg(rawArgs);
    if (!className) {
      return { ok: false, summary: "", error: "缺少 class_name（要恢复的班级名）。" };
    }
    try {
      await restoreClass(className);
    } catch (e) {
      return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, summary: `已恢复班级「${className}」到在用班级列表。` };
  },
});
