import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLessonContext } from "../src/classroom/context";
import { deriveSeatingGrid, flattenGrid } from "../src/classroom/seating";
import type { PickerState } from "../src/classroom/activities/picker.activity";
import type { SeatingActivityState } from "../src/classroom/activities/seating.activity";
import type {
  ClassroomStudent,
  LessonEvent,
  LessonReadContext,
  LessonSession,
  SeatingGrid,
} from "../src/classroom/types";
import {
  clearAll,
  createStudent,
  listBehaviorRecords,
  listLessonEvents,
  openLessonSession,
} from "../src/lib/db";
import { emptyStudentInput } from "../src/types";

/**
 * LessonContext 容器：emit 双写通道与 settle 路由、撤销联动、广播总线、
 * attendance 名单联动、崩溃恢复全量重放 == 在线增量状态（核心等价性）。
 */

const CLASS = "课堂容器测试班";
const DATE = "2026-09-17";

const BEHAVIOR = {
  dimension_id: 1,
  dimension_name_snap: "课堂表现",
  category_snap: "behavior",
  type: "praise" as const,
  comment: "主动举手发言",
};

/** 内存学生（row/col/group 由回退推导补） */
function fakeStudent(id: number, name: string, no: string): ClassroomStudent {
  return { id, name, student_no: no, gender: "male", row_no: 0, col_no: 0, group_no: 0 };
}

/** 2 列回退座位网格：行优先铺开，组号 = 列号 */
function rosterOf(list: ClassroomStudent[]): { students: ClassroomStudent[]; seating: SeatingGrid } {
  const grid = deriveSeatingGrid(list, 2);
  return { students: flattenGrid(grid), seating: grid };
}

async function newSession(activities = [{ type: "picker" }, { type: "seating" }]) {
  const { session } = await openLessonSession({
    class_name: CLASS,
    subject: "数学",
    lesson_date: DATE,
    period: 1,
    activities,
  });
  return session;
}

/** 装配容器：显式给名单/座位/维度，避免依赖 db 种子数据 */
async function buildCtx(session: LessonSession, list: ClassroomStudent[], events?: LessonEvent[]) {
  const roster = rosterOf(list);
  return buildLessonContext({
    session,
    students: roster.students,
    seating: roster.seating,
    dimensions: [],
    events,
  });
}

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  await clearAll();
});

describe("lesson context: emit & settle routing", () => {
  it("guards the behavior double-write channel", async () => {
    const session = await newSession();
    const list = [fakeStudent(1, "路由甲", "01")];
    const { ctx, skipped } = await buildCtx(session, list);
    expect(skipped).toEqual([]);

    // settle='behavior' 的活动发 behavior 事件必须带档案负载
    await expect(
      ctx.emit({ activity: "seating", kind: "behavior", student_id: 1 }),
    ).rejects.toThrow("必须带 behavior 负载");
    // settle='session' 的活动不能夹带档案负载
    await expect(
      ctx.emit({ activity: "picker", kind: "pick", student_id: 1, behavior: BEHAVIOR }),
    ).rejects.toThrow("未声明 settle='behavior'");
    // behavior 事件必须带学生主体
    await expect(
      ctx.emit({ activity: "seating", kind: "behavior", behavior: BEHAVIOR }),
    ).rejects.toThrow("必须带 student_id");
    // 未注册/未生效的活动同样不能走私档案
    await expect(
      ctx.emit({ activity: "countdown", kind: "behavior", student_id: 1, behavior: BEHAVIOR }),
    ).rejects.toThrow("未声明 settle='behavior'");
  });

  it("double-writes behavior events and folds them into activity state", async () => {
    const studentId = await createStudent({ ...emptyStudentInput(), name: "双写甲", grade_class: CLASS });
    const session = await newSession();
    const { ctx } = await buildCtx(session, [fakeStudent(studentId, "双写甲", "01")]);

    const ev = await ctx.emit({
      activity: "seating",
      kind: "behavior",
      student_id: studentId,
      payload: { dimension_id: 1, type: "praise", via: "seat" },
      behavior: BEHAVIOR,
    });

    // 同一事务产出：事件背引用档案 id
    expect(ev.settled_record_id).not.toBeNull();
    const records = await listBehaviorRecords(studentId);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(ev.settled_record_id);
    expect(records[0].comment).toBe("主动举手发言");
    expect(records[0].recorded_date).toBe(DATE);

    // 增量归约即时生效（座位角标 + 时间线）
    const state = ctx.activityState("seating") as SeatingActivityState;
    expect(state.praise[studentId]).toBe(1);
    expect(state.timeline[0].student_id).toBe(studentId);
  });

  it("keeps unknown kinds as plain events and leaves state references untouched", async () => {
    const session = await newSession();
    const { ctx } = await buildCtx(session, [fakeStudent(1, "未知甲", "01")]);
    // 空事件流 → 状态为 null（组件自行兜底空态渲染）
    expect(ctx.activityState("picker")).toBeNull();

    await ctx.emit({ activity: "picker", kind: "pick", student_id: 1 });
    const before = ctx.activityState("picker");

    const ev = await ctx.emit({ activity: "picker", kind: "countdown_run", payload: { runs: 3 } });

    expect(ev.kind).toBe("countdown_run");
    // 未知 kind 活动原样跳过（红线）：状态引用不变
    expect(ctx.activityState("picker")).toBe(before);
    expect((await listLessonEvents(session.id)).map((e) => e.kind)).toEqual(["pick", "countdown_run"]);
  });
});

describe("lesson context: broadcast & roster", () => {
  it("broadcasts events to subscribers and tolerates listener errors", async () => {
    const session = await newSession();
    const list = [fakeStudent(1, "总线甲", "01"), fakeStudent(2, "总线乙", "02")];
    const { ctx } = await buildCtx(session, list);

    const seen: number[] = [];
    const off = ctx.onEvent((ev) => seen.push(ev.id));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ctx.onEvent(() => {
      throw new Error("订阅者故障");
    });

    const ev = await ctx.emit({ activity: "picker", kind: "pick", student_id: 1 });
    expect(seen).toEqual([ev.id]);

    off();
    await ctx.emit({ activity: "picker", kind: "pick", student_id: 2 });
    expect(seen).toEqual([ev.id]); // 已退订者不再收到
    // 广播失败不回滚事件（事件已是事实）
    expect((await listLessonEvents(session.id)).length).toBe(2);
    spy.mockRestore();
  });

  it("applies attendance events to roster, groups and picker pool", async () => {
    const session = await newSession();
    const list = [fakeStudent(1, "缺勤甲", "01"), fakeStudent(2, "在班乙", "02")];
    const { ctx } = await buildCtx(session, list);
    expect(ctx.students.map((s) => s.id)).toEqual([1, 2]);

    await ctx.emit({ activity: "seating", kind: "attendance", student_id: 1, payload: { absent: true } });

    expect(ctx.students.map((s) => s.id)).toEqual([2]);
    expect(ctx.groups.flatMap((g) => g.students.map((s) => s.id))).toEqual([2]);
    const state = ctx.activityState("seating") as SeatingActivityState;
    expect(state.absent.map((a) => a.student_id)).toEqual([1]);
    // 归约看到的名单已是缺勤后口径：点名池不含缺勤者
    expect((ctx.activityState("picker") as PickerState).pool.map((s) => s.id)).toEqual([2]);

    // 归班：回到名单与点名池
    await ctx.emit({ activity: "seating", kind: "attendance", student_id: 1, payload: { absent: false } });
    expect(ctx.students.map((s) => s.id)).toEqual([1, 2]);
    expect((ctx.activityState("seating") as SeatingActivityState).absent).toEqual([]);
  });
});

describe("lesson context: revoke & recovery", () => {
  it("revokes events: archive removed and states rolled back by replay", async () => {
    const a = await createStudent({ ...emptyStudentInput(), name: "撤销甲", grade_class: CLASS });
    const session = await newSession();
    const { ctx } = await buildCtx(session, [fakeStudent(a, "撤销甲", "01")]);

    const pickEv = await ctx.emit({ activity: "picker", kind: "pick", student_id: a });
    const behEv = await ctx.emit({
      activity: "seating",
      kind: "behavior",
      student_id: a,
      payload: { dimension_id: 1, type: "praise" },
      behavior: BEHAVIOR,
    });
    expect((ctx.activityState("seating") as SeatingActivityState).praise[a]).toBe(1);

    await ctx.revoke(behEv.id);
    // 联动删档案 + 状态全量重放回滚
    expect(await listBehaviorRecords(a)).toHaveLength(0);
    expect((ctx.activityState("seating") as SeatingActivityState).praise[a]).toBeUndefined();
    // 并行的点名状态不受影响
    expect((ctx.activityState("picker") as PickerState).pick_count).toBe(1);

    await ctx.revoke(pickEv.id);
    // 撤销后最后一条点名也没了 → 回到空事件流的 null 态
    expect(ctx.activityState("picker")).toBeNull();
  });

  it("rebuilds identical state from the event stream (recovery equivalence)", async () => {
    const a = await createStudent({ ...emptyStudentInput(), name: "恢复甲", grade_class: CLASS });
    const b = await createStudent({ ...emptyStudentInput(), name: "恢复乙", grade_class: CLASS });
    const c = await createStudent({ ...emptyStudentInput(), name: "恢复丙", grade_class: CLASS });
    const session = await newSession();
    const list = [
      fakeStudent(a, "恢复甲", "01"),
      fakeStudent(b, "恢复乙", "02"),
      fakeStudent(c, "恢复丙", "03"),
    ];
    const { ctx } = await buildCtx(session, list);

    // 在线操作序列（含点名/两种档案/缺勤）
    await ctx.emit({ activity: "picker", kind: "pick", student_id: a });
    await ctx.emit({ activity: "picker", kind: "pick", student_id: b, payload: { mode: "weighted", weight: 2 } });
    await ctx.emit({
      activity: "seating",
      kind: "behavior",
      student_id: a,
      payload: { dimension_id: 1, type: "praise" },
      behavior: BEHAVIOR,
    });
    await ctx.emit({
      activity: "seating",
      kind: "behavior",
      student_id: b,
      payload: { dimension_id: 1, type: "improve" },
      behavior: { ...BEHAVIOR, type: "improve", comment: "作业未交" },
    });
    await ctx.emit({ activity: "seating", kind: "attendance", student_id: c, payload: { absent: true } });

    const livePicker = ctx.activityState("picker");
    const liveSeating = ctx.activityState("seating");

    // 崩溃恢复：不传 events，从库里重读事件流全量重放
    const roster = rosterOf(list);
    const { ctx: restored } = await buildLessonContext({
      session,
      students: roster.students,
      seating: roster.seating,
      dimensions: [],
    });

    expect(restored.activityState("picker")).toEqual(livePicker);
    expect(restored.activityState("seating")).toEqual(liveSeating);
    expect(restored.students.map((s) => s.id)).toEqual(ctx.students.map((s) => s.id));

    // 第三条独立路径：手工把事件流喂给 def.reduce（框架重放 == 朴素折叠）
    const events = await listLessonEvents(session.id);
    const seatingDef = restored.activities.find((x) => x.def.type === "seating")!.def;
    const manualCtx: LessonReadContext = {
      session,
      students: roster.students,
      seating: roster.seating,
      groups: restored.groups,
      dimensions: [],
      daysSincePicked: () => null,
    };
    let manual: unknown = null;
    for (const ev of events) manual = seatingDef.reduce(manual as never, ev, manualCtx);
    expect(manual).toEqual(restored.activityState("seating"));
  });
});