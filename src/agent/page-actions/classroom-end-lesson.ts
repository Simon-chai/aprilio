/**
 * 课堂模式页的页面动作：下课（写操作，dangerous = true，走确认门）。
 *
 * 下课 = 结算（事件流聚合 → 小结，AI 优先、数据兜底）→ 落库 → 经总线把小结递进视图。
 * 视图未挂载时总线投递返回 false，此处忽略即可（小结已落库，重进课堂模式仍可查看）。
 */
import { finishLesson } from "../../classroom/digest";
import { listResumableSessions } from "../../classroom/session";
import type { LessonSession } from "../../classroom/types";
import { emitPageAction } from "../page-action-bus";
import { definePageAction } from "../define";

/** 动作参数：兼容模型把参数放在顶层或 args 子对象里的两种写法 */
function actionArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const nested = rawArgs.args;
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)
    : rawArgs;
}

/** 从原始参数里取 session_id（缺省 / 空串视为未传） */
function sessionIdArg(raw: unknown): number | null | "invalid" {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : "invalid";
}

export default definePageAction({
  page: "classroom",
  key: "end-lesson",
  label: "下课",
  description:
    "结束一节课堂：结算点名 / 表现 / 缺勤数据并生成课堂小结（AI 优先、无 AI 用数据版）。" +
    "同时有多个进行中的课堂时用 session_id 指定要结束的会话。",
  dangerous: true,
  run: async (_ctx, rawArgs = {}) => {
    const live = await listResumableSessions();
    if (!live.length) {
      return { ok: false, summary: "", error: "当前没有正在进行的课堂，无需下课。" };
    }

    const idArg = sessionIdArg(actionArgs(rawArgs).session_id);
    if (idArg === "invalid") {
      return { ok: false, summary: "", error: "session_id 应为正整数（课堂会话 ID）。" };
    }

    let target: LessonSession;
    if (idArg !== null) {
      const found = live.find((s) => s.id === idArg);
      if (!found) {
        return { ok: false, summary: "", error: `找不到 ID 为 ${idArg} 的进行中课堂。` };
      }
      target = found;
    } else if (live.length === 1) {
      target = live[0];
    } else {
      const names = live.map((s) => s.class_name).join("、");
      return {
        ok: false,
        summary: "",
        error: `当前有 ${live.length} 个进行中的课堂：${names}，请提供 session_id 指定要结束的课堂。`,
      };
    }

    const { stats, digest_md, digest_source } = await finishLesson(target);
    emitPageAction("classroom/end-lesson", {
      session_id: target.id,
      digest_md,
      digest_source,
      stats,
    });

    const pickCount = stats.picks.reduce((sum, p) => sum + p.count, 0);
    const head = [target.class_name, target.subject].filter(Boolean).join(" · ");
    const source = digest_source === "ai" ? "AI 版" : "数据版";
    return {
      ok: true,
      summary: `已结束「${head}」课堂：点名 ${pickCount} 人次、表扬 ${stats.praise_count} 条、缺勤 ${stats.absent.length} 人；课堂小结（${source}）已生成。`,
    };
  },
});