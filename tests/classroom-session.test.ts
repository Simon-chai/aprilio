import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  findOrCreateTimetable,
  getProfile,
  saveClassroomActivitySet,
  saveProfile,
  saveTimetableException,
  saveTimetablePeriods,
  saveTimetableSlot,
} from "../src/lib/db";
import { semesterOfDate } from "../src/lib/timetable";
import type { Profile, TimetablePeriod } from "../src/types";
import { DEFAULT_ACTIVITY_SET, resolveActivitySet } from "../src/classroom/activity-sets";
import { resolveActivityEntries } from "../src/classroom/registry";
import {
  detectCurrentLesson,
  listResumableSessions,
  startDetectedLesson,
  startLesson,
} from "../src/classroom/session";

/**
 * 会话生命周期：detect 节次感知 / start 开课幂等 / 活动组合解析。
 * vitest 下 isTauri() = false → 走 db.ts 内存演示态（项目既有双态模式）；
 * 内存态与 SQLite 用例同构，本文件只跑内存态（db 双态由 tests/classroom-session-db.test.ts 覆盖）。
 */

const CLASS_A = "课堂节次测试班甲";
const CLASS_B = "课堂节次测试班乙";
/** 2026-09-17 是周四（1 = 周一） */
const DATE = "2026-09-17";
const WEEKDAY = 4;
const SEMESTER = semesterOfDate(DATE);

const PERIODS: TimetablePeriod[] = [
  { period: 1, session: "morning", start: "08:00", end: "08:40" },
  { period: 3, session: "morning", start: "10:00", end: "10:40" },
];

/** 命中第 3 节（10:00~10:40）的时刻 */
const DURING_PERIOD_3 = new Date(2026, 8, 17, 10, 10);
/** 课间（不在任何节次区间内） */
const BETWEEN_PERIODS = new Date(2026, 8, 17, 12, 0);

let originalProfile: Profile;

beforeEach(async () => {
  await clearAll();
  originalProfile = await getProfile();
});

afterEach(async () => {
  await clearAll();
  // clearAll 不重置内存态 profile（memProfile 在 store 之外），手工还原
  await saveProfile(originalProfile);
});

/** 造一个班的课表格子（含固定节次配置） */
async function seedClass(
  className: string,
  subject: string,
  opts: { day_of_week?: number; period?: number; periods?: TimetablePeriod[] } = {}
) {
  const { timetable } = await findOrCreateTimetable(className, SEMESTER);
  await saveTimetablePeriods(timetable.id, opts.periods ?? PERIODS);
  await saveTimetableSlot(timetable.id, opts.day_of_week ?? WEEKDAY, opts.period ?? 3, subject);
  return timetable;
}

async function setMySubjects(subjects: string[]) {
  await saveProfile({ ...(await getProfile()), my_subjects: subjects });
}

describe("detectCurrentLesson 节次感知", () => {
  it("命中此刻的我的一节课（班级 / 科目 / 节次 / 起止）", async () => {
    await seedClass(CLASS_A, "数学");
    await setMySubjects(["数学"]);

    expect(await detectCurrentLesson(DURING_PERIOD_3)).toEqual({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
      start: "10:00",
      end: "10:40",
    });
  });

  it("当天没有我的课 → null（→ 手动选班开临时课堂）", async () => {
    // 只有周五的课，周四探测不到
    await seedClass(CLASS_A, "数学", { day_of_week: 5 });
    await setMySubjects(["数学"]);

    expect(await detectCurrentLesson(DURING_PERIOD_3)).toBeNull();
  });

  it("此刻不在任何节次时段内 → null", async () => {
    await seedClass(CLASS_A, "数学");
    await setMySubjects(["数学"]);

    expect(await detectCurrentLesson(BETWEEN_PERIODS)).toBeNull();
  });

  it("该节被停课（例外）→ 跳过，不命中", async () => {
    const timetable = await seedClass(CLASS_A, "数学");
    await setMySubjects(["数学"]);
    await saveTimetableException(timetable.id, DATE, 3, ""); // 空科目 = 停课

    expect(await detectCurrentLesson(DURING_PERIOD_3)).toBeNull();
  });

  it("科目不是我的任教学科 → null", async () => {
    await seedClass(CLASS_A, "数学");
    await setMySubjects(["语文"]);

    expect(await detectCurrentLesson(DURING_PERIOD_3)).toBeNull();
  });

  it("多命中（跨班连堂/撞课）按节次最小取第一", async () => {
    // 甲班第 3 节、乙班第 1 节，把乙班第 1 节时间设成与甲班第 3 节重叠 → 两个都命中
    await seedClass(CLASS_A, "数学");
    await seedClass(CLASS_B, "数学", {
      period: 1,
      periods: [{ period: 1, session: "morning", start: "10:00", end: "10:40" }],
    });
    await setMySubjects(["数学"]);

    const hit = await detectCurrentLesson(DURING_PERIOD_3);
    expect(hit?.class_name).toBe(CLASS_B);
    expect(hit?.period).toBe(1);
  });
});

describe("startLesson 开课", () => {
  it("开课快照默认集；同班同日同节二次调用 = 恢复（created=false 且 id 相同）", async () => {
    const first = await startLesson({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
    });
    expect(first.created).toBe(true);
    expect(first.session.status).toBe("live");
    expect(first.session.period).toBe(3);
    expect(first.session.activities).toEqual(DEFAULT_ACTIVITY_SET);
    // 未注册活动由注册表决定（activities/*.activity.ts 为并行任务）：断言解析口径一致
    expect(first.skipped).toEqual(resolveActivityEntries(DEFAULT_ACTIVITY_SET).skipped);

    const again = await startLesson({
      class_name: CLASS_A,
      subject: "语文", // 重复开课不覆盖既有会话
      lesson_date: DATE,
      period: 3,
    });
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.subject).toBe("数学");
    expect(again.session.activities).toEqual(DEFAULT_ACTIVITY_SET);
  });

  it("临时课堂（period = null）同日可开多次", async () => {
    const first = await startLesson({
      class_name: CLASS_A,
      subject: "",
      lesson_date: DATE,
      period: null,
    });
    const second = await startLesson({
      class_name: CLASS_A,
      subject: "",
      lesson_date: DATE,
      period: null,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.session.period).toBeNull();
    expect(second.session.id).not.toBe(first.session.id);
  });

  it("组合含未注册的 type → skipped 回报且不阻断开课（快照原样保留）", async () => {
    await saveClassroomActivitySet({
      name: "数学课",
      subject: "数学",
      activities: [{ type: "__missing_a__" }, { type: "__missing_b__" }],
    });

    const res = await startLesson({
      class_name: CLASS_A,
      subject: " 数学 ",
      lesson_date: DATE,
      period: 3,
    });

    expect(res.created).toBe(true);
    expect(res.session.status).toBe("live");
    expect(res.session.activities.map((a) => a.type)).toEqual(["__missing_a__", "__missing_b__"]);
    expect(res.skipped).toEqual(["__missing_a__", "__missing_b__"]);
  });

  it("班级名空 / 日期格式错 → 沿用 db 层校验抛中文错误", async () => {
    await expect(
      startLesson({ class_name: "  ", subject: "", lesson_date: DATE, period: 1 })
    ).rejects.toThrow("班级名不能为空");
    await expect(
      startLesson({ class_name: CLASS_A, subject: "", lesson_date: "2026/09/17", period: 1 })
    ).rejects.toThrow("日期格式");
  });
});

describe("startDetectedLesson 入口快捷开课", () => {
  it("命中当前节次 → 直接开课；二次调用 = 恢复（幂等，同 id）", async () => {
    await seedClass(CLASS_A, "数学");
    await setMySubjects(["数学"]);

    const first = await startDetectedLesson(DURING_PERIOD_3);
    expect(first?.created).toBe(true);
    expect(first?.session.class_name).toBe(CLASS_A);
    expect(first?.session.subject).toBe("数学");
    expect(first?.session.period).toBe(3);

    const again = await startDetectedLesson(DURING_PERIOD_3);
    expect(again?.created).toBe(false);
    expect(again?.session.id).toBe(first?.session.id);
  });

  it("当前不在课表时段 → null（由调用方跳启动页手动选班）", async () => {
    await seedClass(CLASS_A, "数学");
    await setMySubjects(["数学"]);

    expect(await startDetectedLesson(BETWEEN_PERIODS)).toBeNull();
  });
});

describe("listResumableSessions 崩溃恢复", () => {
  it("列出全部 live 会话（多班连堂可能多个）", async () => {
    const a = await startLesson({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
    });
    const b = await startLesson({
      class_name: CLASS_B,
      subject: "语文",
      lesson_date: DATE,
      period: 3,
    });

    const live = await listResumableSessions();
    expect(live.map((s) => s.id).sort()).toEqual([a.session.id, b.session.id].sort());
    expect(live.every((s) => s.status === "live")).toBe(true);
  });
});

describe("resolveActivitySet 组合解析", () => {
  it("表里没有自定义集 → 代码默认集兜底（返回副本，不污染常量）", async () => {
    const resolved = await resolveActivitySet("数学");

    expect(resolved.source).toBe("default");
    expect(resolved.activities).toEqual(DEFAULT_ACTIVITY_SET);
    expect(resolved.activities).not.toBe(DEFAULT_ACTIVITY_SET);
    // 未指定科目同样兜底
    expect((await resolveActivitySet("  ")).source).toBe("default");
  });

  it("通用集（subject 空串）优先于默认集，空白科目也走通用集", async () => {
    await saveClassroomActivitySet({
      name: "通用",
      subject: "",
      activities: [{ type: "digest" }],
    });

    const resolved = await resolveActivitySet("数学");
    expect(resolved.source).toBe("common");
    expect(resolved.activities).toEqual([{ type: "digest" }]);

    const blank = await resolveActivitySet("   ");
    expect(blank.source).toBe("common");
    expect(blank.activities).toEqual([{ type: "digest" }]);
  });

  it("科目专属集优先于通用集（科目 trim 后相等）", async () => {
    await saveClassroomActivitySet({
      name: "通用",
      subject: "",
      activities: [{ type: "digest" }],
    });
    await saveClassroomActivitySet({
      name: "数学课",
      subject: "数学",
      activities: [{ type: "picker" }, { type: "group-race" }],
    });

    const resolved = await resolveActivitySet(" 数学 ");
    expect(resolved.source).toBe("subject");
    expect(resolved.activities).toEqual([{ type: "picker" }, { type: "group-race" }]);
    // 别的科目仍走通用集
    expect((await resolveActivitySet("语文")).source).toBe("common");
  });

  it("同优先级多条：取 sort_order 最小，其次 id 最小", async () => {
    await saveClassroomActivitySet({
      name: "通用甲",
      subject: "",
      activities: [{ type: "digest" }],
      sort_order: 5,
    });
    const firstLow = await saveClassroomActivitySet({
      name: "通用乙",
      subject: " ",
      activities: [{ type: "picker" }],
      sort_order: 1,
    });
    await saveClassroomActivitySet({
      name: "通用丙",
      subject: "",
      activities: [{ type: "seating" }],
      sort_order: 1,
    });

    const resolved = await resolveActivitySet("数学");
    expect(resolved.source).toBe("common");
    expect(resolved.activities).toEqual([{ type: "picker" }]);
    expect(firstLow.sort_order).toBe(1);
  });
});