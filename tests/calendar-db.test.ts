import { afterEach, describe, expect, it } from "vitest";
import {
  addCalendarEvent,
  clearAll,
  deleteCalendarEvent,
  deleteClass,
  listClassEventsInRange,
  listTeacherEventsInRange,
  setCalendarEventDone,
  setCalendarEventTitle,
} from "../src/lib/db";

const CLASS_A = "日历测试班A";

async function cleanup() {
  await deleteClass(CLASS_A);
}

describe("calendar event data access", () => {
  afterEach(cleanup);

  it("adds typed events, lists by date range, toggles and deletes", async () => {
    const id1 = await addCalendarEvent(CLASS_A, "2026-09-07", " 收作业 ", "todo");
    const id2 = await addCalendarEvent(CLASS_A, "2026-09-20", "家长会"); // 默认 memo
    await addCalendarEvent(CLASS_A, "2026-10-05", "运动会", "exam"); // 区间外

    const range = await listClassEventsInRange(CLASS_A, "2026-09-01", "2026-09-30");
    expect(range.map((e) => e.content)).toEqual(["收作业", "家长会"]); // 日期升序，内容已 trim
    expect(range[0].type).toBe("todo");
    expect(range[1].type).toBe("memo");
    expect(range[0].done).toBe(0);

    await setCalendarEventDone(id1, true);
    const toggled = (await listClassEventsInRange(CLASS_A, "2026-09-01", "2026-09-30")).find(
      (e) => e.id === id1
    );
    expect(toggled?.done).toBe(1);
    await setCalendarEventDone(id1, false);
    expect(
      (await listClassEventsInRange(CLASS_A, "2026-09-01", "2026-09-30")).find((e) => e.id === id1)
        ?.done
    ).toBe(0);

    await deleteCalendarEvent(id2);
    const after = await listClassEventsInRange(CLASS_A, "2026-09-01", "2026-09-30");
    expect(after.map((e) => e.id)).toEqual([id1]);
  });

  it("teacher view mixes class-bound and personal events in the range", async () => {
    // 用远离「今天」的固定日期，避免与内存演示态（挂在真实今天附近）撞车
    await addCalendarEvent(CLASS_A, "2030-05-06", "收作业", "todo");
    await addCalendarEvent(null, "2030-05-06", "教研组会议", "todo"); // 个人事件
    await addCalendarEvent(null, "2030-05-07", "交教案", "memo"); // 区间内但次日

    const day = await listTeacherEventsInRange("2030-05-06", "2030-05-06");
    expect(day.map((e) => `${e.class_name ?? "个人"}:${e.content}`)).toEqual([
      `${CLASS_A}:收作业`,
      "个人:教研组会议",
    ]);
    // 个人事件不进班级日历
    expect(await listClassEventsInRange(CLASS_A, "2030-05-06", "2030-05-06")).toHaveLength(1);
  });

  it("validates inputs", async () => {
    // 空班级名回落为教师个人事件（不报错），日期与内容与类型仍严格校验
    await expect(addCalendarEvent(null, "2026/09/07", "x")).rejects.toThrow("YYYY-MM-DD");
    await expect(addCalendarEvent(CLASS_A, "2026-09-07", "   ")).rejects.toThrow("内容不能为空");
    await expect(addCalendarEvent(CLASS_A, "2026-09-07", "长".repeat(201))).rejects.toThrow("200 字");
    await expect(addCalendarEvent(CLASS_A, "2026-09-07", "x", "meeting" as never)).rejects.toThrow(
      "日程类型不合法"
    );
    await expect(listClassEventsInRange(CLASS_A, "2026-9-1", "2026-09-30")).rejects.toThrow(
      "YYYY-MM-DD"
    );
  });

  it("stores the AI quick-browse title on an event (2031 隔离日期，避免撞全局种子)", async () => {
    const id = await addCalendarEvent(null, "2031-05-06", "周五放学前收三年级二班秋游回执单");
    // 未生成标题 → null（界面退回全文前几个字）
    expect((await listTeacherEventsInRange("2031-05-06", "2031-05-06")).find((e) => e.id === id)?.title).toBeNull();

    await setCalendarEventTitle(id, "三年二班收回执");
    const saved = (await listTeacherEventsInRange("2031-05-06", "2031-05-06")).find((e) => e.id === id);
    expect(saved?.title).toBe("三年二班收回执");

    // 空白标题不覆盖已有值
    await setCalendarEventTitle(id, "   ");
    expect(
      (await listTeacherEventsInRange("2031-05-06", "2031-05-06")).find((e) => e.id === id)?.title
    ).toBe("三年二班收回执");
  });

  it("removes class events with the class and everything with clearAll", async () => {
    await addCalendarEvent(CLASS_A, "2030-05-06", "收作业");
    await addCalendarEvent(null, "2030-05-06", "个人待办事项");
    await deleteClass(CLASS_A);
    expect(await listClassEventsInRange(CLASS_A, "2030-01-01", "2030-12-31")).toEqual([]);
    // 个人事件与班级无关，删班级不影响
    expect((await listTeacherEventsInRange("2030-05-06", "2030-05-06")).map((e) => e.content)).toEqual([
      "教研组会议", // 前一个用例遗留的个人事件
      "个人待办事项",
    ]);

    await addCalendarEvent(CLASS_A, "2030-05-06", "收作业");
    await clearAll();
    expect(await listTeacherEventsInRange("2030-05-06", "2030-05-06")).toEqual([]);
  });
});
