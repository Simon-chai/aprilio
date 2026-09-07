/**
 * 工具：query_timetable —— 课程表查询（只读，声明式注册，default export 即被容器装载）。
 *
 * mode=mine：按「任教学科」（profile.my_subjects）聚合各班课表 → 我的行程；
 *   问「今天」时套用当天的调课例外（停课 / 换课 / 加课），并附带今日日程事件；
 *   问其他周几时按周课表基准推算（调课只挂具体日期，跨周推算不适用）。
 * mode=class：查指定班级的全科课表。科目绑定而非教师名（决策见 docs/TIMETABLE.md）。
 * 浏览器演示态走内存示例数据，桌面端走 SQLite。
 */
import {
  getTimetableWithSlots,
  listTeacherEventsInRange,
  listTimetableExceptionsWithClass,
  listTimetableSlotsWithClass,
} from "../../lib/db";
import { toDateStr } from "../../lib/calendar";
import { ensureProfile, profile } from "../../lib/profile";
import {
  WEEKDAY_LABELS,
  buildMyDays,
  buildMySchedule,
  calendarEventLabel,
  currentSemester,
  mySessionsOnDay,
  weekdayOf,
} from "../../lib/timetable";
import { defineAgentTool } from "../define";

/** 1~5 → 星期几；其余（含周末 6/7）→ null = 周末，走整周安排 */
function parseWeekday(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

export default defineAgentTool({
  name: "query_timetable",
  label: "课表查询",
  description:
    "查询课程表：mode=mine 查「我的课表」（按任教学科聚合各班行程，回答「今天/周几有什么课」「要去哪些班」，今天自动考虑调课与日程）；mode=class 查指定班级的全科课表（需 class_name）。",
  tags: ["readonly"],
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["mine", "class"],
        description: "mine=我的课表（默认）；class=班级全科课表",
      },
      class_name: {
        type: "string",
        description: "班级名，如「三年级二班」，仅 mode=class 生效",
      },
      weekday: {
        type: "number",
        description: "星期几（1=周一 … 5=周五）；缺省查今天，周末自动给出整周安排",
      },
    },
  },
  async execute(args) {
    const semester = currentSemester();
    const mode = args.mode === "class" ? "class" : "mine";

    if (mode === "class") {
      const className = typeof args.class_name === "string" ? args.class_name.trim() : "";
      if (!className) {
        return {
          ok: false,
          summary: "",
          error: "查班级课表需要提供 class_name，如「三年级二班」。",
        };
      }
      const timetable = await getTimetableWithSlots(className, semester);
      if (!timetable) {
        return { ok: true, summary: `${className} 在 ${semester} 学期还没有课表。`, data: null };
      }
      const lines = WEEKDAY_LABELS.map((label, i) => {
        const day = timetable.slots.filter((s) => s.day_of_week === i + 1);
        return day.length
          ? `${label}：${day.map((s) => `第${s.period}节 ${s.subject}`).join("，")}`
          : `${label}：无课`;
      });
      return {
        ok: true,
        summary: `${className} ${semester} 全科课表（共 ${timetable.slots.length} 节）：\n${lines.join("\n")}`,
        data: timetable,
      };
    }

    // mode=mine：任教学科聚合
    await ensureProfile().catch(() => undefined);
    const mySubjects = profile.value.my_subjects ?? [];
    if (!mySubjects.length) {
      return {
        ok: true,
        summary:
          "还没有登记任教学科，无法确定「我的课表」。请引导用户到「个人资料」登记任教学科，或在班级详情的「课程表」里先排课。",
        data: { my_subjects: [] },
      };
    }

    const rows = await listTimetableSlotsWithClass(semester);
    const schedule = buildMySchedule(rows, mySubjects);

    // 撞课信息对回答行程类问题很重要，命中时在摘要尾部显式提示
    const conflictNote = schedule.conflicts.length
      ? `\n注意撞课：${schedule.conflicts
          .map(
            (c) =>
              `${WEEKDAY_LABELS[c.day_of_week - 1]}第${c.period}节：${c.entries
                .map((e) => `${e.subject}(${e.class_name})`)
                .join(" 与 ")}`
          )
          .join("；")}`
      : "";

    // 显式传了 weekday 就按参数答（6/7 = 周末问题）；缺省才落到今天
    const weekday =
      args.weekday !== undefined ? parseWeekday(args.weekday) : weekdayOf();

    // 周末：没有单日课，给出整周安排
    if (weekday === null) {
      const perSubject = schedule.bySubject
        .map(
          (b) =>
            `${b.subject}（每周 ${b.weekly_count} 节）：${b.sessions
              .map((s) => `${WEEKDAY_LABELS[s.day_of_week - 1]}第${s.period}节 ${s.class_name}`)
              .join("，")}`
        )
        .join("\n");
      return {
        ok: true,
        summary: `今天是周末，没有课。任教学科（${mySubjects.join("、")}）整周安排如下：\n${perSubject}${conflictNote}`,
        data: schedule,
      };
    }

    // 问「今天」（缺省或显式指认今天）：套用当天调课例外 + 附带今日日程
    const todayStr = toDateStr(new Date());
    if (weekday === weekdayOf()) {
      const exceptions = await listTimetableExceptionsWithClass(semester, todayStr, todayStr);
      const dayMap = buildMyDays(rows, exceptions, mySubjects, [todayStr]);
      const sessions = dayMap.get(todayStr) ?? [];

      if (!sessions.length) {
        return {
          ok: true,
          summary: `${WEEKDAY_LABELS[weekday - 1]}没有你的课（任教学科：${mySubjects.join("、")}）。`,
          data: { weekday, date: todayStr, sessions: [] },
        };
      }

      const lines = sessions.map((s) => {
        const state =
          s.state === "cancelled"
            ? "（已停课）"
            : s.state === "changed"
              ? "（调课）"
              : s.state === "added"
                ? "（加课）"
                : "";
        return `第${s.period}节 ${s.subject} · ${s.class_name}${s.note ? `（${s.note}）` : ""}${state}`;
      });

      let summary = `${WEEKDAY_LABELS[weekday - 1]}共有 ${sessions.length} 节你的课（已考虑当天调课）：\n${lines.join("\n")}`;
      if (sessions.some((s) => s.state !== "normal")) {
        const changes = sessions
          .filter((s) => s.state !== "normal")
          .map((s) => `第${s.period}节 ${s.class_name}：${s.state === "cancelled" ? "停课" : s.state === "changed" ? "换课" : "加课"}`);
        summary += `\n今天有调课：${changes.join("；")}。`;
      }
      summary += conflictNote;

      try {
        const events = await listTeacherEventsInRange(todayStr, todayStr);
        if (events.length) {
          summary += `\n今日日程：${events
            .map((e) => `${e.period ? `第${e.period}节` : "全天"}${e.class_name ? `【${e.class_name}】` : ""}${calendarEventLabel(e.type)}「${e.content}」${e.done ? "（已完成）" : ""}`)
            .join("；")}`;
        }
        return { ok: true, summary, data: { weekday, date: todayStr, sessions, events } };
      } catch {
        return { ok: true, summary, data: { weekday, date: todayStr, sessions } };
      }
    }

    // 显式问其他周几：按周课表基准推算（调课例外挂在具体日期上，不适用于任意一周）
    const sessions = mySessionsOnDay(schedule, weekday);
    if (!sessions.length) {
      return {
        ok: true,
        summary: `${WEEKDAY_LABELS[weekday - 1]}没有你的课（任教学科：${mySubjects.join("、")}）。`,
        data: { weekday, sessions: [] },
      };
    }
    const lines = sessions.map(
      (s) => `第${s.period}节 ${s.subject} · ${s.class_name}${s.note ? `（${s.note}）` : ""}`
    );
    return {
      ok: true,
      summary: `${WEEKDAY_LABELS[weekday - 1]}共有 ${sessions.length} 节你的课（按周课表推算，未考虑具体某天的调课）：\n${lines.join("\n")}${conflictNote}`,
      data: { weekday, sessions },
    };
  },
});
