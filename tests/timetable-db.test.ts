import { afterEach, describe, expect, it } from "vitest";
import {
  clearAll,
  clearTimetableException,
  clearTimetableSlots,
  deleteClass,
  findOrCreateTimetable,
  getProfile,
  getTimetableWithSlots,
  listTimetableExceptionsWithClass,
  listTimetableExceptionsInRange,
  listTimetablePeriodsByClass,
  listTimetableSlotsWithClass,
  listTimetableSubjects,
  migrateLegacyCalendarMemos,
  saveProfile,
  saveTimetableException,
  saveTimetablePeriods,
  saveTimetableSlot,
} from "../src/lib/db";
import { currentSemester, defaultPeriods } from "../src/lib/timetable";

const CLASS_A = "课表测试班A";
const CLASS_B = "课表测试班B";
const SEMESTER = currentSemester();

async function cleanup() {
  for (const name of [CLASS_A, CLASS_B, "节次班甲", "节次班乙"]) {
    await deleteClass(name);
  }
}

describe("timetable data access", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("creates a timetable idempotently per class+semester", async () => {
    const first = await findOrCreateTimetable(CLASS_A, SEMESTER);
    expect(first.created).toBe(true);
    expect(first.timetable.class_name).toBe(CLASS_A);
    expect(first.timetable.semester).toBe(SEMESTER);
    expect(first.timetable.periods).toBeNull(); // 默认节次

    const again = await findOrCreateTimetable(CLASS_A, SEMESTER);
    expect(again.created).toBe(false);
    expect(again.timetable.id).toBe(first.timetable.id);

    // 不同学期/班级是另一张表
    const other = await findOrCreateTimetable(CLASS_A, "2025-2026-2");
    expect(other.created).toBe(true);
    expect(other.timetable.id).not.toBe(first.timetable.id);

    await expect(findOrCreateTimetable("  ", SEMESTER)).rejects.toThrow("班级名不能为空");
    await expect(findOrCreateTimetable(CLASS_A, "2026秋")).rejects.toThrow("学期号格式");
  });

  it("upserts slots by (day, period) and clears by empty subject", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
    await saveTimetableSlot(timetable.id, 1, 2, "语文");
    await saveTimetableSlot(timetable.id, 1, 2, "数学", "带教具"); // 覆盖
    await saveTimetableSlot(timetable.id, 5, 7, "班会");

    let loaded = await getTimetableWithSlots(CLASS_A, SEMESTER);
    expect(loaded?.slots).toHaveLength(2);
    expect(loaded?.slots[0]).toMatchObject({ day_of_week: 1, period: 2, subject: "数学", note: "带教具" });
    expect(loaded?.slots[1]).toMatchObject({ day_of_week: 5, period: 7, subject: "班会" });

    await saveTimetableSlot(timetable.id, 1, 2, ""); // 清空 = 删行
    await saveTimetableSlot(timetable.id, 5, 7, "班会", "  "); // 空白备注归一为 null
    loaded = await getTimetableWithSlots(CLASS_A, SEMESTER);
    expect(loaded?.slots).toHaveLength(1);
    expect(loaded?.slots[0].note).toBeNull();

    await expect(saveTimetableSlot(timetable.id, 6, 1, "语文")).rejects.toThrow("周一到周五");
    await expect(saveTimetableSlot(timetable.id, 1, 0, "语文")).rejects.toThrow("1~12");
  });

  it("saves period config and persists it on the timetable header", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
    const periods = defaultPeriods().slice(0, 6);
    await saveTimetablePeriods(timetable.id, periods);

    const loaded = await getTimetableWithSlots(CLASS_A, SEMESTER);
    expect(loaded?.periods).toEqual(periods);

    await expect(saveTimetablePeriods(timetable.id, [{ period: 1, session: "morning", start: "", end: "" }, { period: 1, session: "morning", start: "", end: "" }]))
      .rejects.toThrow("节次序号不能重复");

    // 空数组恢复默认（periods = null）
    await saveTimetablePeriods(timetable.id, []);
    expect((await getTimetableWithSlots(CLASS_A, SEMESTER))?.periods).toBeNull();
  });

  it("lists slots with class names and distinct subjects across classes", async () => {
    const a = await findOrCreateTimetable(CLASS_A, SEMESTER);
    const b = await findOrCreateTimetable(CLASS_B, SEMESTER);
    await saveTimetableSlot(a.timetable.id, 1, 2, " 语文 ");
    await saveTimetableSlot(a.timetable.id, 2, 1, "数学");
    await saveTimetableSlot(b.timetable.id, 1, 2, "语文");
    await saveTimetableSlot(b.timetable.id, 3, 4, "英语");

    const rows = await listTimetableSlotsWithClass(SEMESTER);
    const mine = rows.filter((r) => r.class_name === CLASS_A || r.class_name === CLASS_B);
    expect(mine).toHaveLength(4);
    expect(mine.every((r) => r.periods !== undefined)).toBe(true); // 联了节次配置
    // 按天 → 节次排序
    expect(mine.map((r) => `${r.day_of_week}:${r.period}`)).toEqual(["1:2", "1:2", "2:1", "3:4"]);

    const subjects = await listTimetableSubjects();
    for (const s of ["语文", "数学", "英语"]) {
      expect(subjects).toContain(s);
    }
    // 演示数据里 Trim 过的科目不会重复出现
    expect(subjects.filter((s) => s === "语文")).toHaveLength(1);
  });

  it("removes the class timetable when the class is deleted", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
    await saveTimetableSlot(timetable.id, 1, 1, "语文");

    await deleteClass(CLASS_A);
    expect(await getTimetableWithSlots(CLASS_A, SEMESTER)).toBeNull();

    const remaining = await listTimetableSlotsWithClass(SEMESTER);
    expect(remaining.some((r) => r.class_name === CLASS_A)).toBe(false);
  });

  it("round-trips profile my_subjects", async () => {
    const original = await getProfile();
    try {
      await saveProfile({ ...original, my_subjects: ["语文", " 数学 "] });
      const saved = await getProfile();
      expect(saved.my_subjects).toEqual(["语文", " 数学 "]);

      await saveProfile({ ...original, my_subjects: [] });
      expect((await getProfile()).my_subjects).toEqual([]);
    } finally {
      await saveProfile(original);
    }
  });

  it("clears all timetables with clearAll", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
    await saveTimetableSlot(timetable.id, 1, 1, "语文");

    await clearAll();
    expect(await getTimetableWithSlots(CLASS_A, SEMESTER)).toBeNull();
    expect(await listTimetableSlotsWithClass(SEMESTER)).toEqual([]);
  });

  it("upserts / clears timetable exceptions (换课 / 停课 / 加课) by (date, period)", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);

    await saveTimetableException(timetable.id, "2026-09-07", 2, " 数学 ", "带教具");
    await saveTimetableException(timetable.id, "2026-09-07", 3, ""); // 停课
    let list = await listTimetableExceptionsInRange(timetable.id, "2026-09-01", "2026-09-30");
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.period === 2)).toMatchObject({ subject: "数学", note: "带教具" });
    expect(list.find((e) => e.period === 3)?.subject).toBe("");

    // 同 (日期, 节) 覆盖幂等
    await saveTimetableException(timetable.id, "2026-09-07", 2, "英语");
    list = await listTimetableExceptionsInRange(timetable.id, "2026-09-01", "2026-09-30");
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.period === 2)?.subject).toBe("英语");

    // 区间过滤
    expect(await listTimetableExceptionsInRange(timetable.id, "2026-10-01", "2026-10-31")).toEqual([]);

    // 删除例外 = 恢复周课默认
    await clearTimetableException(timetable.id, "2026-09-07", 2);
    await clearTimetableException(timetable.id, "2026-09-07", 3);
    expect(await listTimetableExceptionsInRange(timetable.id, "2026-09-01", "2026-09-30")).toEqual([]);

    await expect(saveTimetableException(timetable.id, "2026/09/07", 1, "语文")).rejects.toThrow(
      "YYYY-MM-DD"
    );
    await expect(saveTimetableException(timetable.id, "2026-09-07", 0, "语文")).rejects.toThrow("1~12");
  });

  it("joins exceptions with class names and filters by semester / range", async () => {
    const a = await findOrCreateTimetable(CLASS_A, SEMESTER);
    const b = await findOrCreateTimetable(CLASS_B, SEMESTER);
    const other = await findOrCreateTimetable(CLASS_A, "2025-2026-2");
    await saveTimetableException(a.timetable.id, "2026-09-07", 2, "数学");
    await saveTimetableException(b.timetable.id, "2026-09-07", 5, "");
    await saveTimetableException(other.timetable.id, "2026-09-07", 1, "语文"); // 别的学期

    const rows = await listTimetableExceptionsWithClass(SEMESTER, "2026-09-07", "2026-09-07");
    expect(rows.map((r) => `${r.class_name}:${r.period}`)).toEqual([`${CLASS_A}:2`, `${CLASS_B}:5`]);

    await deleteClass(CLASS_A);
    const after = await listTimetableExceptionsWithClass(SEMESTER, "2026-09-07", "2026-09-07");
    expect(after.map((r) => r.class_name)).toEqual([CLASS_B]); // 删班连带删例外
  });

  it("migrates legacy calendar_memos into calendar_events and drops the old table", async () => {
    const executed: string[] = [];
    const fakeDb = {
      // 模拟「迁移历史混乱、v4 被跳过但旧表还在」的调试库
      select: async () => [{ class_name: "旧班", memo_date: "2026-09-01", content: "收作业", done: 1 }],
      execute: async (sql: string) => {
        executed.push(sql);
      },
    };
    await migrateLegacyCalendarMemos(fakeDb as never);
    expect(executed.some((s) => s.includes("INSERT INTO calendar_events"))).toBe(true);
    expect(executed.some((s) => s.includes("DROP TABLE calendar_memos"))).toBe(true);

    // 正常路径（旧表已不存在）静默跳过
    const noTable = {
      select: async () => {
        throw new Error("no such table: calendar_memos");
      },
      execute: async () => undefined,
    };
    await expect(migrateLegacyCalendarMemos(noTable as never)).resolves.toBeUndefined();
  });

  it("lists per-class period configs for the semester (双态)", async () => {
    const a = await findOrCreateTimetable("节次班甲", SEMESTER);
    await findOrCreateTimetable("节次班乙", SEMESTER);
    await saveTimetablePeriods(a.timetable.id, [
      { period: 1, session: "morning", start: "08:00", end: "08:40" },
      { period: 8, session: "afternoon", start: "16:30", end: "17:10" },
    ]);
    // 班乙不配置 → periods 为 null，也要出现在结果里

    const list = await listTimetablePeriodsByClass(SEMESTER);
    const jia = list.find((x) => x.class_name === "节次班甲");
    const yi = list.find((x) => x.class_name === "节次班乙");
    expect(jia?.periods?.map((p) => p.period)).toEqual([1, 8]);
    expect(yi?.periods).toBeNull();
  });

  it("clears all slots of one timetable and returns the deleted count", async () => {
    const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
    await saveTimetableSlot(timetable.id, 1, 1, "语文");
    await saveTimetableSlot(timetable.id, 2, 2, "数学");

    expect(await clearTimetableSlots(timetable.id)).toBe(2);
    expect(await getTimetableWithSlots(CLASS_A, SEMESTER)).toMatchObject({ slots: [] });
    expect(await clearTimetableSlots(timetable.id)).toBe(0);
  });
});
