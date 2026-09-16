import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  endLessonSession,
  findLiveLessonSession,
  getLessonSession,
  listLessonSessions,
  listLiveLessonSessions,
  openLessonSession,
} from "../src/lib/db";
import type { LessonStats } from "../src/classroom/types";

/**
 * 课堂会话数据层（lesson_sessions）：槽位幂等、临时课堂、状态迁移、列表过滤排序。
 * vitest 下 isTauri() = false → 实际跑内存态（项目既有双态模式）。
 */

const CLASS_A = "课堂会话测试班甲";
const CLASS_B = "课堂会话测试班乙";
const DATE = "2026-09-17";
const ACTIVITIES = [{ type: "picker" }, { type: "seating" }];

function emptyStats(): LessonStats {
  return {
    picks: [],
    pick_coverage: 0,
    praise_count: 0,
    improve_count: 0,
    absent: [],
    groups: [],
    silent: [],
    duration_min: 40,
  };
}

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  await clearAll();
});

describe("lesson session data access", () => {
  it("opens a live session with an activity snapshot", async () => {
    const { session, created } = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
      activities: ACTIVITIES,
    });

    expect(created).toBe(true);
    expect(session.id).toBeGreaterThan(0);
    expect(session.class_name).toBe(CLASS_A);
    expect(session.subject).toBe("数学");
    expect(session.lesson_date).toBe(DATE);
    expect(session.period).toBe(3);
    expect(session.status).toBe("live");
    expect(session.ended_at).toBeNull();
    expect(session.stats).toBeNull();
    expect(session.digest_md).toBeNull();
    expect(session.digest_source).toBeNull();
    expect(session.activities).toEqual(ACTIVITIES);
    expect(session.started_at).toBeTruthy();
    expect(session.created_at).toBeTruthy();

    expect(await getLessonSession(session.id)).toEqual(session);
    expect(await getLessonSession(999999)).toBeNull();
  });

  it("treats the same class/date/period slot as idempotent (reopen = resume)", async () => {
    const first = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
      activities: ACTIVITIES,
    });
    const again = await openLessonSession({
      class_name: CLASS_A,
      subject: "语文", // 重复开课不覆盖既有会话
      lesson_date: DATE,
      period: 3,
      activities: [{ type: "digest" }],
    });

    expect(again.created).toBe(false);
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.subject).toBe("数学");
    expect(again.session.activities).toEqual(ACTIVITIES);
    expect(await listLessonSessions({ class_name: CLASS_A })).toHaveLength(1);
  });

  it("returns the existing slot even after it ended (不新建也不复活)", async () => {
    const first = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
      activities: ACTIVITIES,
    });
    await endLessonSession(first.session.id, {
      stats: emptyStats(),
      digest_md: "小结",
      digest_source: "data",
    });

    const again = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 3,
      activities: ACTIVITIES,
    });
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.status).toBe("ended");
  });

  it("allows multiple temporary sessions (period = null) on the same day", async () => {
    const first = await openLessonSession({
      class_name: CLASS_A,
      subject: "",
      lesson_date: DATE,
      period: null,
      activities: [],
    });
    const second = await openLessonSession({
      class_name: CLASS_A,
      subject: "",
      lesson_date: DATE,
      period: null,
      activities: [],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
    expect(await listLessonSessions({ class_name: CLASS_A })).toHaveLength(2);
  });

  it("finds a live session only by its exact slot", async () => {
    const { session } = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 2,
      activities: [],
    });
    await openLessonSession({
      class_name: CLASS_B,
      subject: "数学",
      lesson_date: DATE,
      period: 2,
      activities: [],
    });

    expect((await findLiveLessonSession(CLASS_A, DATE, 2))?.id).toBe(session.id);
    expect(await findLiveLessonSession(CLASS_A, DATE, 3)).toBeNull();
    expect(await findLiveLessonSession(CLASS_A, "2026-09-18", 2)).toBeNull();
    expect(await findLiveLessonSession(CLASS_B, DATE, 2)).not.toBeNull();

    await endLessonSession(session.id, {
      stats: emptyStats(),
      digest_md: "小结",
      digest_source: "data",
    });
    expect(await findLiveLessonSession(CLASS_A, DATE, 2)).toBeNull();
    // 临时课堂（period=null）不参与槽位查重
    expect(await findLiveLessonSession(CLASS_A, DATE, null)).toBeNull();
  });

  it("lists live sessions across classes for crash recovery", async () => {
    const a = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 1,
      activities: [],
    });
    const b = await openLessonSession({
      class_name: CLASS_B,
      subject: "语文",
      lesson_date: DATE,
      period: 2,
      activities: [],
    });

    const live = await listLiveLessonSessions();
    expect(live.map((s) => s.id).sort()).toEqual([a.session.id, b.session.id].sort());
    // started_at 降序（同秒并列时非增即可）
    for (let i = 1; i < live.length; i++) {
      expect(live[i - 1].started_at >= live[i].started_at).toBe(true);
    }

    await endLessonSession(a.session.id, {
      stats: emptyStats(),
      digest_md: "小结",
      digest_source: "data",
    });
    expect((await listLiveLessonSessions()).map((s) => s.id)).toEqual([b.session.id]);
  });

  it("ends a session with stats and digest", async () => {
    const { session } = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: DATE,
      period: 4,
      activities: ACTIVITIES,
    });
    const stats = { ...emptyStats(), praise_count: 3, pick_coverage: 0.5 };

    await endLessonSession(session.id, {
      stats,
      digest_md: "## 课堂小结",
      digest_source: "ai",
    });

    const ended = await getLessonSession(session.id);
    expect(ended?.status).toBe("ended");
    expect(ended?.ended_at).toBeTruthy();
    expect(ended?.stats).toEqual(stats);
    expect(ended?.digest_md).toBe("## 课堂小结");
    expect(ended?.digest_source).toBe("ai");
  });

  it("lists sessions by date desc then started_at desc, with filters", async () => {
    const older = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: "2026-09-15",
      period: 1,
      activities: [],
    });
    const newer = await openLessonSession({
      class_name: CLASS_A,
      subject: "数学",
      lesson_date: "2026-09-16",
      period: 1,
      activities: [],
    });
    const otherClass = await openLessonSession({
      class_name: CLASS_B,
      subject: "语文",
      lesson_date: "2026-09-16",
      period: 1,
      activities: [],
    });

    const byClass = await listLessonSessions({ class_name: CLASS_A });
    expect(byClass.map((s) => s.id)).toEqual([newer.session.id, older.session.id]);

    const byDate = await listLessonSessions({ lesson_date: "2026-09-16" });
    expect(byDate.map((s) => s.id).sort()).toEqual([newer.session.id, otherClass.session.id].sort());

    const inRange = await listLessonSessions({ class_name: CLASS_A, start: "2026-09-16", end: "2026-09-17" });
    expect(inRange.map((s) => s.id)).toEqual([newer.session.id]);

    const limited = await listLessonSessions({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].lesson_date).toBe("2026-09-16");

    expect(await listLessonSessions({ class_name: "不存在的班" })).toEqual([]);
  });

  it("rejects invalid input with Chinese errors", async () => {
    await expect(
      openLessonSession({ class_name: "  ", subject: "", lesson_date: DATE, period: 1, activities: [] })
    ).rejects.toThrow("班级名不能为空");
    await expect(
      openLessonSession({ class_name: CLASS_A, subject: "", lesson_date: "2026/09/17", period: 1, activities: [] })
    ).rejects.toThrow("日期格式");
    await expect(
      openLessonSession({ class_name: CLASS_A, subject: "", lesson_date: DATE, period: 0, activities: [] })
    ).rejects.toThrow("节次");
    await expect(
      openLessonSession({
        class_name: CLASS_A,
        subject: "",
        lesson_date: DATE,
        period: 1,
        activities: "picker" as unknown as [],
      })
    ).rejects.toThrow("活动组合");
  });
});