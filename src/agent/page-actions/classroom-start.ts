/**
 * 课堂模式页的页面动作：开始上课（写操作，dangerous = true，走确认门）。
 *
 * 两种口径：
 * - 按当前时间课表命中开课（detectCurrentLesson：班级/科目/节次都来自课表）
 * - 传 class_name 开课表外的临时课堂（period = null，班级名先查库校验）
 *
 * 开课后跳到课堂模式页，路由 query 携带会话 id（视图据此续上会话）；
 * 同班同日同节重复开课是幂等恢复，summary 相应写「继续」。
 */
import { detectCurrentLesson, startLesson } from "../../classroom/session";
import { localDateStr } from "../../lib/format";
import { resolveClassName } from "../tools/navigation";
import { definePageAction } from "../define";

/** 动作参数：兼容模型把参数放在顶层或 args 子对象里的两种写法 */
function actionArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const nested = rawArgs.args;
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)
    : rawArgs;
}

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 开课入参（与 startLesson 的入参形状一致） */
interface LessonInput {
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
}

export default definePageAction({
  page: "classroom",
  key: "start",
  label: "开始上课",
  description:
    "开始一节课堂：按当前时间课表命中开课；也可传 class_name 开课表外的临时课堂（班级名先查库校验，可再传 subject）。" +
    "开课后自动进入课堂模式页。",
  dangerous: true,
  run: async (ctx, rawArgs = {}) => {
    const args = actionArgs(rawArgs);
    const className = str(args.class_name);

    let input: LessonInput;
    if (className) {
      // 临时课堂：班级名查库校验取真实班级名，节次留空（课表外）
      try {
        const hit = await resolveClassName(className);
        input = {
          class_name: hit.name,
          subject: String(args.subject ?? ""),
          lesson_date: localDateStr(),
          period: null,
        };
      } catch (e) {
        return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      // 无班级名：按当前时间课表命中，无命中则引导手动选班
      const detected = await detectCurrentLesson();
      if (!detected) {
        return {
          ok: false,
          summary: "",
          error: "当前时间不在你的课表时段内，可提供班级名开临时课堂，或打开课堂模式手动选班。",
        };
      }
      input = {
        class_name: detected.class_name,
        subject: detected.subject,
        lesson_date: detected.lesson_date,
        period: detected.period,
      };
    }

    let res: Awaited<ReturnType<typeof startLesson>>;
    try {
      res = await startLesson(input);
    } catch (e) {
      return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
    }

    // AgentToolContext.router 的 push 类型只声明了 name / params，课堂路由需要 query（session id）
    const router = ctx.router as unknown as {
      push(location: { name: string; query: Record<string, string> }): Promise<unknown>;
    };
    await router.push({ name: "classroom", query: { session: String(res.session.id) } });

    const head = [res.session.class_name, res.session.subject].filter(Boolean).join(" · ");
    const when = res.session.period === null ? "临时课堂" : `第 ${res.session.period} 节课堂`;
    const verb = res.created ? "已开始" : "继续";
    const skipped = res.skipped.length ? `以下活动未安装已跳过：${res.skipped.join("、")}。` : "";
    return { ok: true, summary: `${verb}「${head}」${when}。${skipped}` };
  },
});