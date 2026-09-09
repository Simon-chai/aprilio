/**
 * 班级管理页的页面动作：归档班级（写操作，dangerous = true，走确认门）。
 * 直接复用 db 层，不依赖视图挂载，因此任意页面都能执行。
 */
import { archiveClass } from "../../lib/db";
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
  key: "archive-class",
  label: "归档班级",
  description:
    "把指定班级移入「历史带过的班」：从班级管理移出、数据只读保留、可随时恢复。参数 class_name 为班级名。",
  dangerous: true,
  run: async (_ctx, rawArgs = {}) => {
    const className = classNameArg(rawArgs);
    if (!className) {
      return { ok: false, summary: "", error: "缺少 class_name（要归档的班级名）。" };
    }
    try {
      await archiveClass(className);
    } catch (e) {
      return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, summary: `已归档班级「${className}」，可在「历史带过的班」里查看或恢复。` };
  },
});
