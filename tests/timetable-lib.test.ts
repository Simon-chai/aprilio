import { describe, expect, it } from "vitest";
import {
  buildGrid,
  buildMySchedule,
  crossClassConflictsAt,
  currentPeriod,
  currentSemester,
  defaultPeriods,
  isMySubject,
  mineOfClassResolver,
  mySessionsOnDay,
  parsePeriodsJson,
  periodsUnion,
  semesterLabel,
  sessionIsNow,
  weekdayOf,
} from "../src/lib/timetable";
import type { TimetablePeriod, TimetableSlot, TimetableSlotWithClass } from "../src/types";

function slot(
  day: number,
  period: number,
  subject: string,
  class_name = "三年级二班",
  my_subjects: string[] | null = null
): TimetableSlotWithClass {
  return {
    id: day * 100 + period,
    timetable_id: 1,
    day_of_week: day,
    period,
    subject,
    note: null,
    updated_at: "",
    class_name,
    periods: null,
    my_subjects,
  };
}

describe("semester helpers", () => {
  it("derives semester from month: autumn Sep-Dec, spring Mar-Aug, Jan/Feb still previous autumn", () => {
    expect(currentSemester(new Date(2026, 8, 6))).toBe("2026-2027-1"); // 9 月
    expect(currentSemester(new Date(2026, 11, 31))).toBe("2026-2027-1"); // 12 月
    expect(currentSemester(new Date(2026, 0, 15))).toBe("2025-2026-1"); // 1 月
    expect(currentSemester(new Date(2026, 1, 28))).toBe("2025-2026-1"); // 2 月
    expect(currentSemester(new Date(2026, 2, 1))).toBe("2025-2026-2"); // 3 月
    expect(currentSemester(new Date(2026, 7, 20))).toBe("2025-2026-2"); // 8 月
  });

  it("renders semester labels and passes through unknown formats", () => {
    expect(semesterLabel("2026-2027-1")).toBe("2026–2027 秋季学期");
    expect(semesterLabel("2025-2026-2")).toBe("2025–2026 春季学期");
    expect(semesterLabel("任意文本")).toBe("任意文本");
  });

  it("maps weekdays 1-5 and returns null on weekends", () => {
    expect(weekdayOf(new Date(2026, 8, 7))).toBe(1); // 周一
    expect(weekdayOf(new Date(2026, 8, 11))).toBe(5); // 周五
    expect(weekdayOf(new Date(2026, 8, 12))).toBeNull(); // 周六
    expect(weekdayOf(new Date(2026, 8, 6))).toBeNull(); // 周日
  });
});

describe("period config", () => {
  it("defaults to 8 periods: 4 morning + 4 afternoon with times", () => {
    const periods = defaultPeriods();
    expect(periods).toHaveLength(8);
    expect(periods.filter((p) => p.session === "morning")).toHaveLength(4);
    expect(periods[0]).toMatchObject({ period: 1, start: "08:00", end: "08:40" });
    expect(periods[7]).toMatchObject({ period: 8, start: "16:30", end: "17:10" });
  });

  it("parses periods_json and degrades dirty data to null", () => {
    expect(parsePeriodsJson(null)).toBeNull();
    expect(parsePeriodsJson("")).toBeNull();
    expect(parsePeriodsJson("not json")).toBeNull();
    expect(parsePeriodsJson("{}")).toBeNull();
    expect(parsePeriodsJson("[]")).toBeNull();
    expect(parsePeriodsJson('[{"period":1,"session":"morning","start":"08:00","end":"08:40"}]')).toEqual([
      { period: 1, session: "morning", start: "08:00", end: "08:40" },
    ]);
    // 非法节次被剔除，全部非法 → null
    expect(parsePeriodsJson('[{"period":0},{"period":"x"}]')).toBeNull();
    // 已是数组（内存态直传）
    expect(parsePeriodsJson([{ period: 2, session: "afternoon", start: "", end: "" }])).toEqual([
      { period: 2, session: "afternoon", start: "", end: "" },
    ]);
  });

  it("finds the current period by time and degrades when unconfigured", () => {
    const periods = defaultPeriods();
    expect(currentPeriod(periods, new Date(2026, 8, 7, 8, 20))).toBe(1);
    expect(currentPeriod(periods, new Date(2026, 8, 7, 14, 20))).toBe(5);
    expect(currentPeriod(periods, new Date(2026, 8, 7, 8, 45))).toBeNull(); // 课间
    expect(currentPeriod(periods, new Date(2026, 8, 7, 18, 0))).toBeNull(); // 放学后
    expect(currentPeriod(null, new Date(2026, 8, 7, 8, 20))).toBeNull();
    expect(
      currentPeriod([{ period: 1, session: "morning", start: "", end: "" }], new Date(2026, 8, 7, 8, 20))
    ).toBeNull();
  });
});

describe("buildGrid", () => {
  const periods = defaultPeriods();

  it("places slots by (day, period) and leaves other cells empty", () => {
    const slots: TimetableSlot[] = [
      { id: 1, timetable_id: 1, day_of_week: 1, period: 2, subject: "语文", note: null, updated_at: "" },
      { id: 2, timetable_id: 1, day_of_week: 5, period: 7, subject: "班会", note: null, updated_at: "" },
    ];
    const grid = buildGrid(slots, periods);
    expect(grid).toHaveLength(8);
    expect(grid[0].every((cell) => cell === null)).toBe(true);
    expect(grid[1][0]?.subject).toBe("语文");
    expect(grid[6][4]?.subject).toBe("班会");
    expect(grid[3][2]).toBeNull();
  });
});

describe("buildMySchedule", () => {
  it("aggregates my subjects across classes with weekly counts sorted desc", () => {
    const rows = [
      slot(1, 2, "语文"),
      slot(3, 1, "语文"),
      slot(1, 1, "数学"),
      slot(1, 2, "语文", "三年级一班"),
      slot(2, 3, "数学", "三年级一班"),
      slot(4, 5, "音乐"), // 非任教学科，不进我的课表
    ];
    const schedule = buildMySchedule(rows, mineOfClassResolver(rows, ["语文", "数学"]));

    expect(schedule.weekly_total).toBe(5);
    expect(schedule.bySubject.map((b) => b.subject)).toEqual(["语文", "数学"]);
    expect(schedule.bySubject[0].weekly_count).toBe(3);
    // 格子未配节次 → 时间退回默认节次表
    expect(schedule.bySubject[0].sessions).toEqual([
      { class_name: "三年级二班", day_of_week: 1, period: 2, note: null, start: "08:50", end: "09:30" },
      { class_name: "三年级一班", day_of_week: 1, period: 2, note: null, start: "08:50", end: "09:30" },
      { class_name: "三年级二班", day_of_week: 3, period: 1, note: null, start: "08:00", end: "08:40" },
    ]);
    expect(schedule.bySubject[1].weekly_count).toBe(2);
  });

  it("flags cross-class conflicts at the same (day, period)", () => {
    const rows = [
      slot(1, 2, "语文"),
      slot(1, 2, "语文", "三年级一班"),
      slot(2, 3, "语文", "三年级一班"),
    ];
    const schedule = buildMySchedule(rows, mineOfClassResolver(rows, ["语文"]));
    expect(schedule.conflicts).toEqual([
      {
        day_of_week: 1,
        period: 2,
        entries: [
          { subject: "语文", class_name: "三年级二班" },
          { subject: "语文", class_name: "三年级一班" },
        ],
      },
    ]);
  });

  it("matches subjects after trimming and ignores empty subjects", () => {
    expect(isMySubject(" 语文 ", ["语文"])).toBe(true);
    expect(isMySubject("数学", ["语文", " 数学 "])).toBe(true);
    expect(isMySubject("数学", ["语文"])).toBe(false);
    expect(isMySubject("", ["", "语文"])).toBe(false);
    expect(isMySubject("  ", ["语文"])).toBe(false);

    const rows = [slot(1, 1, " 语文 "), slot(2, 1, "", "三年级一班")];
    const schedule = buildMySchedule(rows, mineOfClassResolver(rows, ["语文"]));
    expect(schedule.weekly_total).toBe(1);
    expect(schedule.conflicts).toEqual([]);
  });

  it("flattens sessions of one day in period order", () => {
    const rows = [
      slot(1, 2, "语文"),
      slot(1, 1, "数学"),
      slot(1, 6, "语文", "三年级一班"),
      slot(2, 1, "语文"),
    ];
    const schedule = buildMySchedule(rows, mineOfClassResolver(rows, ["语文", "数学"]));
    expect(mySessionsOnDay(schedule, 1)).toEqual([
      { class_name: "三年级二班", day_of_week: 1, period: 1, note: null, subject: "数学", start: "08:00", end: "08:40" },
      { class_name: "三年级二班", day_of_week: 1, period: 2, note: null, subject: "语文", start: "08:50", end: "09:30" },
      { class_name: "三年级一班", day_of_week: 1, period: 6, note: null, subject: "语文", start: "14:50", end: "15:30" },
    ]);
    expect(mySessionsOnDay(schedule, 5)).toEqual([]);
  });

  it("tells whether a session is happening now", () => {
    expect(sessionIsNow({ start: "08:00", end: "08:40" }, new Date(2026, 8, 7, 8, 20))).toBe(true);
    expect(sessionIsNow({ start: "08:00", end: "08:40" }, new Date(2026, 8, 7, 8, 40))).toBe(false);
    expect(sessionIsNow({ start: "", end: "" }, new Date(2026, 8, 7, 8, 20))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 调课例外：某天某节覆盖周课表                                           */
/* ------------------------------------------------------------------ */

import {
  buildMyDays,
  resolveDaySlots,
  subjectChipClass,
  subjectColorName,
  subjectDotClass,
} from "../src/lib/timetable";
import type { TimetableExceptionWithClass } from "../src/types";

function exc(
  date: string,
  period: number,
  subject: string,
  class_name = "三年级二班"
): TimetableExceptionWithClass {
  return {
    id: period,
    timetable_id: 1,
    exception_date: date,
    period,
    subject,
    note: null,
    class_name,
    created_at: "",
    updated_at: "",
  };
}

describe("resolveDaySlots (调课例外套用到某天)", () => {
  const base = [slot(1, 1, "数学"), slot(1, 2, "语文"), slot(1, 3, "英语")];

  it("passes through the weekly slots when no exception exists", () => {
    expect(resolveDaySlots(base, [])).toEqual([
      { period: 1, subject: "数学", note: null, state: "normal" },
      { period: 2, subject: "语文", note: null, state: "normal" },
      { period: 3, subject: "英语", note: null, state: "normal" },
    ]);
  });

  it("marks changed / cancelled / added slots", () => {
    const day = resolveDaySlots(
      base,
      [exc("2026-09-07", 2, "数学"), exc("2026-09-07", 3, ""), exc("2026-09-07", 5, "班会")]
    );
    expect(day).toEqual([
      { period: 1, subject: "数学", note: null, state: "normal" },
      { period: 2, subject: "数学", note: null, state: "changed" },
      { period: 3, subject: "英语", note: null, state: "cancelled" }, // 停课保留展示
      { period: 5, subject: "班会", note: null, state: "added" },
    ]);
  });

  it("cancelled slots keep the original subject for strikethrough display", () => {
    const day = resolveDaySlots(base, [exc("2026-09-07", 2, "")]);
    // 停课不删课：全天照常返回，只是第 2 节标记 cancelled（原科目保留给划线展示）
    expect(day).toEqual([
      { period: 1, subject: "数学", note: null, state: "normal" },
      { period: 2, subject: "语文", note: null, state: "cancelled" },
      { period: 3, subject: "英语", note: null, state: "normal" },
    ]);
  });

  it("ignores stop markers on empty periods and same-subject overrides stay normal", () => {
    // 对空格子记停课无意义 → 不出现
    expect(resolveDaySlots([], [exc("2026-09-07", 4, "")])).toEqual([]);
    // 例外科目与周课相同 → normal（只可能更新备注）
    expect(resolveDaySlots(base, [exc("2026-09-07", 1, "数学")]).find((s) => s.period === 1)?.state).toBe("normal");
  });
});

describe("buildMyDays (我的课表带日期投影)", () => {
  it("applies exceptions per class and keeps cancelled sessions of my subjects", () => {
    const rows = [
      slot(1, 2, "语文"), // 周一第2节 三(2) 语文（我）
      slot(1, 2, "语文", "三年级一班"),
      slot(1, 3, "体育"), // 非任教学科
    ];
    // 2026-09-07 是周一：三(2)第2节换成数学（我的课消失），三(1)第2节停课（保留，划线展示）
    const map = buildMyDays(
      rows,
      [exc("2026-09-07", 2, "数学"), exc("2026-09-07", 2, "", "三年级一班")],
      mineOfClassResolver(rows, ["语文"]),
      ["2026-09-07"]
    );
    expect(map.get("2026-09-07")).toEqual([
      {
        date: "2026-09-07",
        class_name: "三年级一班",
        period: 2,
        subject: "语文",
        note: null,
        start: "08:50",
        end: "09:30",
        state: "cancelled",
      },
    ]);
  });

  it("picks up classes moved onto empty periods and sorts by period", () => {
    const rows = [slot(1, 1, "数学")];
    const map = buildMyDays(
      rows,
      [exc("2026-09-07", 7, "语文")],
      mineOfClassResolver(rows, ["语文", "数学"]),
      ["2026-09-07"]
    );
    expect(map.get("2026-09-07")!.map((s) => `${s.period}-${s.subject}-${s.state}`)).toEqual([
      "1-数学-normal",
      "7-语文-added",
    ]);
  });

  it("honors per-class my_subjects marks with global fallback", () => {
    // 三(1) 标记了 [美术]（覆盖全局），三(2) 未标记（回退全局 [语文]）
    const rows = [
      slot(1, 1, "语文", "三年级二班", null),
      slot(1, 1, "美术", "三年级一班", ["美术"]),
      slot(1, 2, "美术", "三年级二班", null), // 三(2) 未标记美术 → 全局 [语文] 不含美术，不进
      slot(1, 2, "语文", "三年级一班", ["美术"]), // 三(1) 标记不含语文 → 不进
    ];
    const schedule = buildMySchedule(rows, mineOfClassResolver(rows, ["语文"]));
    expect(schedule.weekly_total).toBe(2);
    expect(schedule.bySubject.map((b) => b.subject)).toEqual(["美术", "语文"]);
    expect(schedule.bySubject[0].sessions[0].class_name).toBe("三年级一班");
    expect(schedule.bySubject[1].sessions[0].class_name).toBe("三年级二班");
  });
});

describe("crossClassConflictsAt (跨班撞课检测)", () => {
  /** 与 slot() 同构，但可指定 timetable_id（排除本班用） */
  function slotAt(
    timetableId: number,
    day: number,
    period: number,
    subject: string,
    class_name: string,
    my_subjects: string[] | null = null
  ): TimetableSlotWithClass {
    return {
      id: timetableId * 100 + day * 10 + period,
      timetable_id: timetableId,
      day_of_week: day,
      period,
      subject,
      note: null,
      updated_at: "",
      class_name,
      periods: null,
      my_subjects,
    };
  }

  it("returns other classes' my-subject slots at the same (day, period)", () => {
    const rows = [
      slotAt(1, 1, 2, "语文", "三年级二班"),
      slotAt(2, 1, 2, "语文", "三年级一班"),
      slotAt(2, 1, 3, "语文", "三年级一班"), // 不同节
    ];
    const mineOf = mineOfClassResolver(rows, ["语文"]);
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2, excludeTimetableId: 1 })).toEqual([
      { class_name: "三年级一班", subject: "语文" },
    ]);
  });

  it("excludes the current class by excludeTimetableId", () => {
    const rows = [slotAt(1, 1, 2, "语文", "三年级二班")];
    const mineOf = mineOfClassResolver(rows, ["语文"]);
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2, excludeTimetableId: 1 })).toEqual([]);
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2, excludeTimetableId: 7 })).toEqual([
      { class_name: "三年级二班", subject: "语文" },
    ]);
  });

  it("honors per-class marks: empty array opts out, null falls back to global", () => {
    const rows = [
      slotAt(2, 1, 2, "语文", "三年级一班", []), // 明确标记「本班没有我的课」
      slotAt(3, 1, 2, "语文", "三年级三班", null), // 未标记 → 回退全局
      slotAt(4, 1, 2, "语文", "三年级四班", ["数学"]), // 标记集合不含语文
    ];
    const mineOf = mineOfClassResolver(rows, ["语文"]);
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2 })).toEqual([
      { class_name: "三年级三班", subject: "语文" },
    ]);
  });

  it("ignores non-my subjects and other days/periods, sorts by class name", () => {
    const rows = [
      slotAt(2, 1, 2, "体育", "三年级一班"), // 非我的科目（帮别的老师录的课）
      slotAt(3, 2, 2, "语文", "三年级三班"),
      slotAt(4, 1, 3, "语文", "三年级四班"),
      slotAt(5, 1, 2, "语文", "三年级二班"),
    ];
    const mineOf = mineOfClassResolver(rows, ["语文"]);
    // 周一第 2 节只有三年级二班命中（体育非我的科目、三班在周二、四班在第 3 节）
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2 })).toEqual([
      { class_name: "三年级二班", subject: "语文" },
    ]);
    // 周二第 2 节命中三年级三班
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 2, period: 2 })).toEqual([
      { class_name: "三年级三班", subject: "语文" },
    ]);
  });

  it("trims subject in results and matches marked subjects after trimming", () => {
    const rows = [slotAt(2, 1, 2, " 语文 ", "三年级一班", ["语文 "])];
    const mineOf = mineOfClassResolver(rows, ["语文"]);
    expect(crossClassConflictsAt(rows, mineOf, { day_of_week: 1, period: 2 })).toEqual([
      { class_name: "三年级一班", subject: "语文" },
    ]);
  });
});

describe("subject colors (同科目稳定同色)", () => {
  it("presets map to fixed colors and unknown subjects hash stably", () => {
    expect(subjectColorName("语文")).toBe("rose");
    expect(subjectColorName("数学")).toBe("sky");
    expect(subjectColorName(" 语文 ")).toBe("rose"); // trim 后命中预设
    expect(subjectColorName("奥数")).toBe(subjectColorName("奥数")); // 散列稳定
    expect(subjectChipClass("语文")).toContain("bg-rose-50");
    expect(subjectDotClass("数学")).toBe("bg-sky-500");
    expect(subjectChipClass(" ")).toContain("bg-pearl"); // 空科目退回中性
    expect(subjectDotClass("")).toBe("bg-faint");
  });
});

describe("periodsUnion", () => {
  it("merges period configs ascending and keeps first non-empty times", () => {
    const a = [
      { period: 1, session: "morning", start: "08:00", end: "08:40" },
      { period: 2, session: "morning", start: "", end: "" },
    ] as TimetablePeriod[];
    const b = [
      { period: 2, session: "morning", start: "08:50", end: "09:30" },
      { period: 8, session: "afternoon", start: "16:30", end: "17:10" },
    ] as TimetablePeriod[];
    const merged = periodsUnion([a, b]);
    expect(merged.map((p) => p.period)).toEqual([1, 2, 8]);
    expect(merged[1].start).toBe("08:50");
    expect(merged[1].end).toBe("09:30");
  });

  it("falls back to defaultPeriods when everything is empty", () => {
    expect(periodsUnion([])).toEqual(defaultPeriods());
    expect(periodsUnion([null, null])).toEqual(defaultPeriods());
  });
});
