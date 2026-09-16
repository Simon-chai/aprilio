import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLessonEvent,
  clearAll,
  createStudent,
  listBehaviorRecords,
  listLessonEvents,
  openLessonSession,
  parseJsonObject,
  revokeLessonEvent,
  lastPickedAtByStudent,
} from "../src/lib/db";
import { emptyStudentInput } from "../src/types";

/**
 * 课堂事件流（lesson_events）：append/revoke、双写一致性、跨会话沉默读模型、开放 kind/payload。
 */

const CLASS = "课堂事件测试班";
const DATE = "2026-09-17";

async function newStudent(name: string): Promise<number> {
  return createStudent({ ...emptyStudentInput(), name, grade_class: CLASS });
}

async function newSession(period: number | null = 1) {
  const { session } = await openLessonSession({
    class_name: CLASS,
    subject: "数学",
    lesson_date: DATE,
    period,
    activities: [{ type: "picker" }],
  });
  return session;
}

const BEHAVIOR = {
  dimension_id: 3,
  dimension_name_snap: "课堂表现",
  category_snap: "behavior",
  type: "praise" as const,
  comment: "主动举手发言",
};

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  await clearAll();
});

describe("lesson event data access", () => {
  it("appends a plain event with default payload and occurred_at", async () => {
    const session = await newSession();
    const ev = await appendLessonEvent({
      session_id: session.id,
      activity: "picker",
      kind: "pick",
      student_id: null,
    });

    expect(ev.id).toBeGreaterThan(0);
    expect(ev.session_id).toBe(session.id);
    expect(ev.student_id).toBeNull();
    expect(ev.kind).toBe("pick");
    expect(ev.payload).toEqual({});
    expect(ev.settled_record_id).toBeNull();
    expect(ev.revoked_at).toBeNull();
    expect(ev.occurred_at).toBeTruthy();
    expect(ev.created_at).toBeTruthy();

    const listed = await listLessonEvents(session.id);
    expect(listed.map((e) => e.id)).toEqual([ev.id]);
  });

  it("keeps unknown kinds and arbitrary payload (open extension)", async () => {
    const session = await newSession();
    const ev = await appendLessonEvent({
      session_id: session.id,
      activity: "countdown",
      kind: "countdown_run",
      payload: { runs: 3, note: "口算" },
    });
    expect(ev.kind).toBe("countdown_run");
    expect(ev.payload).toEqual({ runs: 3, note: "口算" });
    expect((await listLessonEvents(session.id))[0].payload).toEqual({ runs: 3, note: "口算" });
  });

  it("writes behavior events through the double-write channel", async () => {
    const studentId = await newStudent("事件甲");
    const session = await newSession();
    const ev = await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "behavior",
      student_id: studentId,
      payload: { dimension_id: 3, type: "praise", via: "seating" },
      behavior: BEHAVIOR,
    });

    expect(ev.settled_record_id).not.toBeNull();

    const records = await listBehaviorRecords(studentId);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(ev.settled_record_id);
    expect(records[0].comment).toBe("主动举手发言");
    expect(records[0].category_snap).toBe("behavior");
    // recorded_date 取会话的 lesson_date
    expect(records[0].recorded_date).toBe(DATE);
  });

  it("revokes a behavior event and removes the linked archive record", async () => {
    const studentId = await newStudent("事件乙");
    const session = await newSession();
    const ev = await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "behavior",
      student_id: studentId,
      behavior: BEHAVIOR,
    });
    expect(await listBehaviorRecords(studentId)).toHaveLength(1);

    await revokeLessonEvent(ev.id);

    const [revoked] = await listLessonEvents(session.id, { includeRevoked: true });
    expect(revoked.revoked_at).toBeTruthy();
    expect(await listBehaviorRecords(studentId)).toHaveLength(0);
    // 默认列表不含撤销事件
    expect(await listLessonEvents(session.id)).toEqual([]);
  });

  it("revokes idempotently and tolerates unknown ids / non-archive events", async () => {
    const studentId = await newStudent("事件丙");
    const session = await newSession();
    const behavior = await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "behavior",
      student_id: studentId,
      behavior: BEHAVIOR,
    });
    const pick = await appendLessonEvent({
      session_id: session.id,
      activity: "picker",
      kind: "pick",
      student_id: studentId,
    });

    await revokeLessonEvent(behavior.id);
    await expect(revokeLessonEvent(behavior.id)).resolves.toBeUndefined();
    await expect(revokeLessonEvent(999999)).resolves.toBeUndefined();
    await expect(revokeLessonEvent(pick.id)).resolves.toBeUndefined();

    const events = await listLessonEvents(session.id);
    expect(events).toEqual([]);
    expect((await listLessonEvents(session.id, { includeRevoked: true })).length).toBe(2);
    // 撤销普通事件不误删档案
    await expect(listBehaviorRecords(studentId)).resolves.toHaveLength(0);
  });

  it("computes last picked time across sessions", async () => {
    const a = await newStudent("沉默甲");
    const b = await newStudent("沉默乙");
    const c = await newStudent("沉默丙");
    const s1 = await newSession(1);
    const s2 = await newSession(2);

    await appendLessonEvent({
      session_id: s1.id,
      activity: "picker",
      kind: "pick",
      student_id: a,
      occurred_at: "2026-09-15 08:00:00",
    });
    await appendLessonEvent({
      session_id: s2.id,
      activity: "picker",
      kind: "pick",
      student_id: a,
      occurred_at: "2026-09-16 10:00:00",
    });
    await appendLessonEvent({
      session_id: s2.id,
      activity: "picker",
      kind: "pick",
      student_id: b,
      occurred_at: "2026-09-16 09:00:00",
    });
    const revoked = await appendLessonEvent({
      session_id: s2.id,
      activity: "picker",
      kind: "pick",
      student_id: c,
      occurred_at: "2026-09-16 11:00:00",
    });
    await revokeLessonEvent(revoked.id);
    await appendLessonEvent({
      session_id: s2.id,
      activity: "picker",
      kind: "pick",
      student_id: c,
      occurred_at: "2026-09-18 09:00:00", // beforeIso 之后
    });
    // 非同 kind 不参与
    await appendLessonEvent({
      session_id: s2.id,
      activity: "seating",
      kind: "attendance",
      student_id: b,
      occurred_at: "2026-09-16 20:00:00",
    });

    const map = await lastPickedAtByStudent([a, b, c], "2026-09-16 23:59:59");
    expect(map.get(a)).toBe("2026-09-16 10:00:00");
    expect(map.get(b)).toBe("2026-09-16 09:00:00");
    expect(map.has(c)).toBe(false);
    expect(map.size).toBe(2);

    const earlier = await lastPickedAtByStudent([a], "2026-09-15 23:59:59");
    expect(earlier.get(a)).toBe("2026-09-15 08:00:00");

    expect((await lastPickedAtByStudent([], "2026-09-16 23:59:59")).size).toBe(0);
  });

  it("rejects malformed input with Chinese errors", async () => {
    const session = await newSession();
    await expect(
      appendLessonEvent({ session_id: session.id, activity: "", kind: "pick" })
    ).rejects.toThrow("发出活动");
    await expect(
      appendLessonEvent({ session_id: session.id, activity: "picker", kind: "" })
    ).rejects.toThrow("事件类型");
    await expect(
      appendLessonEvent({ session_id: session.id, activity: "picker", kind: "behavior", behavior: BEHAVIOR })
    ).rejects.toThrow("学生");
    await expect(
      appendLessonEvent({ activity: "picker", kind: "pick" })
    ).rejects.toThrow("课堂会话");
  });

  it("tolerates broken JSON in TEXT columns", async () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("{坏 JSON")).toEqual({});
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject({ ok: true })).toEqual({ ok: true });
  });
});