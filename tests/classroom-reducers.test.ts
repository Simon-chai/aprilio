import { describe, expect, it } from "vitest";
import pickerActivity, {
  emptyPickerState,
  reduce as reducePicker,
  SILENCE_CAP_DAYS,
  silenceWeight,
  weightedIndex,
  type PickerState,
} from "../src/classroom/activities/picker.activity";
import groupRaceActivity, {
  emptyGroupRaceState,
  reduce as reduceGroupRace,
  type GroupRaceState,
} from "../src/classroom/activities/group-race.activity";
import type {
  ClassroomGroup,
  ClassroomStudent,
  LessonActivityDef,
  LessonEvent,
  LessonReadContext,
  LessonSession,
  SeatingGrid,
} from "../src/classroom/types";

/**
 * 课堂活动 reduce 纯函数（picker / group-race）：
 * 点名池与覆盖率、沉默权重、组分聚合、撤销后重放一致、未知 kind 原样跳过、空事件流语义。
 */

const SESSION: LessonSession = {
  id: 7,
  class_name: "三(2)班",
  subject: "数学",
  lesson_date: "2026-09-17",
  period: 3,
  started_at: "2026-09-17 10:05:00",
  ended_at: null,
  status: "live",
  activities: [{ type: "picker" }, { type: "group-race" }],
  stats: null,
  digest_md: null,
  digest_source: null,
  created_at: "2026-09-17 10:05:00",
};

/** 在班学生（缺勤者由框架在装配 ctx 时剔除，本文件的 ctx 一律是「已过滤」名单） */
function stu(id: number, name: string, groupNo: number): ClassroomStudent {
  return {
    id,
    name,
    student_no: String(id).padStart(4, "0"),
    gender: "男",
    row_no: id,
    col_no: groupNo,
    group_no: groupNo,
  };
}

/** 造只读上下文：组按 group_no 升序聚合，days 表给出跨会话沉默读模型 */
function makeCtx(
  students: ClassroomStudent[],
  days: Record<number, number | null> = {},
): LessonReadContext {
  const groupNos = [...new Set(students.map((s) => s.group_no))].filter((g) => g > 0).sort((a, b) => a - b);
  const groups: ClassroomGroup[] = groupNos.map((group_no) => ({
    group_no,
    name: `第 ${group_no} 组`,
    students: students.filter((s) => s.group_no === group_no),
  }));
  const seating: SeatingGrid = {
    rows: 1,
    cols: students.length,
    cells: [students.map((s) => s)],
    derived: true,
  };
  return {
    session: SESSION,
    students,
    seating,
    groups,
    dimensions: [],
    daysSincePicked: (studentId: number) => (studentId in days ? days[studentId] : null),
  };
}

/** 造事件（id 显式给，便于断言撤销目标） */
function ev(
  id: number,
  kind: string,
  studentId: number | null,
  payload: Record<string, unknown> = {},
  occurredAt = "2026-09-17 10:10:00",
): LessonEvent {
  return {
    id,
    session_id: SESSION.id,
    student_id: studentId,
    activity: "picker",
    kind,
    payload,
    settled_record_id: null,
    occurred_at: occurredAt,
    created_at: occurredAt,
    revoked_at: null,
  };
}

/** 全量重放（与框架 replay 同语义：从 null 起折叠整条事件流） */
function replay<S>(
  def: LessonActivityDef<S>,
  events: LessonEvent[],
  ctx: LessonReadContext,
): S | null {
  let state: S | null = null;
  for (const e of events) state = def.reduce(state, e, ctx);
  return state;
}

/** 增量归约（emit 快路径：逐条 reduce） */
function incremental<S>(
  def: LessonActivityDef<S>,
  events: LessonEvent[],
  ctx: LessonReadContext,
): S | null {
  return events.reduce<S | null>((state, e) => def.reduce(state, e, ctx), null);
}

/* ------------------------------------------------------------------ */

describe("picker reduce（点名池 / 覆盖率 / 沉默权重）", () => {
  const ctx = makeCtx([stu(1, "林小满", 1), stu(2, "陈子墨", 1), stu(3, "王一诺", 2)], {
    1: 0,
    2: 5,
    3: null,
  });

  const PICK_A1 = ev(1, "pick", 1, { mode: "random", weight: 1 }, "2026-09-17 10:10:00");
  const PICK_B = ev(2, "pick", 2, { mode: "weighted", weight: 5.8 }, "2026-09-17 10:12:00");
  const PICK_A2 = ev(3, "pick", 1, { mode: "random" }, "2026-09-17 10:15:00");

  it("已点名单含次数与最后被点时间，点名池扣减，覆盖率按在班名单算", () => {
    const state = replay(pickerActivity, [PICK_A1, PICK_B, PICK_A2], ctx)!;

    expect(state.pick_count).toBe(3);
    expect(state.called.map((p) => p.event_id)).toEqual([1, 2, 3]);
    expect(state.called.map((p) => p.mode)).toEqual(["random", "weighted", "random"]);
    expect(state.stats).toEqual([
      { student_id: 1, student_name: "林小满", count: 2, last_picked_at: "2026-09-17 10:15:00" },
      { student_id: 2, student_name: "陈子墨", count: 1, last_picked_at: "2026-09-17 10:12:00" },
    ]);

    // 点名池 = ctx.students 去掉已点（attendance 已由框架过滤，3 人即在班名单）
    expect(state.pool.map((s) => s.id)).toEqual([3]);
    expect(state.coverage).toBeCloseTo(2 / 3, 6);

    // 沉默权重原料：按权重降序，「从未被点」最前
    expect(state.silent.map((s) => s.student_id)).toEqual([3, 2, 1]);
    expect(state.silent[0]).toMatchObject({ student_name: "王一诺", days: null, weight: silenceWeight(null) });
    expect(state.silent[1].days).toBe(5);
  });

  it("缺勤学生不进池也不进分母；点缺勤者不抬高覆盖率（姓名兜底占位）", () => {
    // 缺勤的 9 号已被框架从 ctx.students 剔除，但历史事件里可能有他的点名
    const state = replay(
      pickerActivity,
      [PICK_A1, ev(4, "pick", 9, { mode: "hand" })],
      ctx,
    )!;

    expect(state.pool.map((s) => s.id)).toEqual([2, 3]);
    expect(state.coverage).toBeCloseTo(1 / 3, 6);
    expect(state.called[1].student_name).toBe("同学 9");
  });

  it("未被点过的学生按权重优先：沉默权重单调递增，从未被点按封顶", () => {
    expect(silenceWeight(null)).toBe(silenceWeight(SILENCE_CAP_DAYS));
    expect(silenceWeight(null)).toBeGreaterThan(silenceWeight(10));
    expect(silenceWeight(10)).toBeGreaterThan(silenceWeight(0));
    // 抽样确定性：rand 落在权重大的区间即命中它
    expect(weightedIndex([1, 50], 0)).toBe(0);
    expect(weightedIndex([1, 50], 0.999)).toBe(1);
    expect(weightedIndex([0, 0], 0.5)).toBe(0);
  });
});

describe("picker：红线与撤销重放", () => {
  const ctx = makeCtx([stu(1, "林小满", 1), stu(2, "陈子墨", 1), stu(3, "王一诺", 2)], {
    1: 3,
    2: 3,
    3: 3,
  });
  const events = [
    ev(1, "pick", 1, { mode: "random" }, "2026-09-17 10:10:00"),
    ev(2, "pick", 2, { mode: "random" }, "2026-09-17 10:11:00"),
    ev(3, "pick", 3, { mode: "random" }, "2026-09-17 10:12:00"),
  ];

  it("未知 kind 原样跳过（引用不变，state 不被污染）", () => {
    const state = replay(pickerActivity, events, ctx)!;
    const unknown = ev(90, "future_thing", null, { anything: true });

    expect(reducePicker(state, unknown, ctx)).toBe(state);
    expect(reducePicker(state, ev(91, "behavior", 1, { dimension_id: 3 }), ctx)).toBe(state);
    // 起点为 null 时，未知 kind 只给出空态（不消费事件、不崩）
    expect(replay(pickerActivity, [unknown], ctx)).toEqual(emptyPickerState(ctx));
  });

  it("撤销后重放一致：去掉 revoked 事件重放 == 逐条增量归约（且状态同步回滚）", () => {
    const incAll = incremental(pickerActivity, events, ctx)!;
    expect(replay(pickerActivity, events, ctx)).toEqual(incAll);
    expect(incAll.coverage).toBeCloseTo(1, 6);
    expect(incAll.pool).toEqual([]);

    // 撤销 id=3（框架标记 revoked_at 后不再返回该事件，随后全量重放）
    const kept = events.filter((e) => e.id !== 3);
    const replayed = replay(pickerActivity, kept, ctx)!;

    expect(replayed).toEqual(incremental(pickerActivity, kept, ctx));
    expect(replayed.called.map((p) => p.event_id)).toEqual([1, 2]);
    expect(replayed.stats).toHaveLength(2);
    expect(replayed.coverage).toBeCloseTo(2 / 3, 6);
    // 被撤销的点名回到点名池，天数权重随之恢复
    expect(replayed.pool.map((s) => s.id)).toEqual([3]);
  });

  it("空事件流 → state = null（框架重放语义）；空态由 emptyPickerState 给出", () => {
    expect(replay(pickerActivity, [], ctx)).toBeNull();
    const empty: PickerState = emptyPickerState(ctx);
    expect(empty.called).toEqual([]);
    expect(empty.stats).toEqual([]);
    expect(empty.pick_count).toBe(0);
    expect(empty.coverage).toBe(0);
    expect(empty.pool.map((s) => s.id)).toEqual([1, 2, 3]);
  });
});

describe("group-race reduce（组分聚合）", () => {
  const ctx = makeCtx(
    [stu(1, "林小满", 1), stu(2, "陈子墨", 1), stu(3, "王一诺", 2), stu(4, "李思远", 3)],
    {},
  );

  const points = [
    ev(11, "group_point", null, { group_no: 1, delta: 1, reason: "发言" }, "2026-09-17 10:11:00"),
    ev(12, "group_point", null, { group_no: 1, delta: 2, reason: "合作" }, "2026-09-17 10:12:00"),
    ev(13, "group_point", null, { group_no: 2, delta: -1, reason: "纪律提醒" }, "2026-09-17 10:13:00"),
    ev(14, "group_point", null, { group_no: 2, delta: 3, reason: "作业" }, "2026-09-17 10:14:00"),
  ];

  it("各组分数 = 事件聚合（多组 / 多次 / 负分），领先组与流水一并产出", () => {
    const state = replay(groupRaceActivity, points, ctx)!;

    expect(state.groups.map((g) => [g.group_no, g.score])).toEqual([
      [1, 3],
      [2, 2],
      [3, 0],
    ]);
    expect(state.leader_group_no).toBe(1);
    expect(state.leader_score).toBe(3);
    expect(state.total_points).toBe(5);
    expect(state.last_event_id).toBe(14);
    // 每组流水带 score_after（供跳动动画）
    expect(state.groups[0].history.map((h) => h.score_after)).toEqual([1, 3]);
    expect(state.groups[1].history.map((h) => h.score_after)).toEqual([-1, 2]);
    expect(state.groups[1].history.map((h) => h.delta)).toEqual([-1, 3]);
    // 组名/成员来自座位分组（P0 组名统一「第 N 组」）
    expect(state.groups[0].name).toBe("第 1 组");
    expect(state.groups[1].members.map((m) => m.id)).toEqual([3]);
  });

  it("事件引入座位分组之外的新组：按组号兜底命名，且可成为领先组", () => {
    const state = replay(
      groupRaceActivity,
      [...points, ev(15, "group_point", null, { group_no: 5, delta: 4, reason: "发言" })],
      ctx,
    )!;

    expect(state.groups.map((g) => g.group_no)).toEqual([1, 2, 3, 5]);
    expect(state.groups[3]).toMatchObject({ group_no: 5, name: "第 5 组", score: 4, members: [] });
    expect(state.leader_group_no).toBe(5);
    expect(state.total_points).toBe(9);
  });

  it("未知 kind 与非法 payload 都原样跳过（引用不变）", () => {
    const state = replay(groupRaceActivity, points, ctx)!;

    expect(reduceGroupRace(state, ev(90, "future_thing", null, { delta: 99 }), ctx)).toBe(state);
    expect(reduceGroupRace(state, ev(91, "behavior", 1, { dimension_id: 3 }), ctx)).toBe(state);
    // 组号 0 = 未分组、delta 非数 / 为 0 → 不消费
    expect(reduceGroupRace(state, ev(92, "group_point", null, { group_no: 0, delta: 1 }), ctx)).toBe(state);
    expect(reduceGroupRace(state, ev(93, "group_point", null, { group_no: 1, delta: 0 }), ctx)).toBe(state);
    expect(reduceGroupRace(state, ev(94, "group_point", null, { group_no: 1, delta: "3" }), ctx)).toBe(state);
  });

  it("撤销一条 group_point 后重放：分数回退、领先组易主", () => {
    const incAll = incremental(groupRaceActivity, points, ctx)!;
    expect(replay(groupRaceActivity, points, ctx)).toEqual(incAll);

    // 撤销 id=12（第 1 组 +2）
    const kept = points.filter((p) => p.id !== 12);
    const replayed = replay(groupRaceActivity, kept, ctx)!;

    expect(replayed).toEqual(incremental(groupRaceActivity, kept, ctx));
    expect(replayed.groups.map((g) => [g.group_no, g.score])).toEqual([
      [1, 1],
      [2, 2],
      [3, 0],
    ]);
    expect(replayed.leader_group_no).toBe(2);
    expect(replayed.leader_score).toBe(2);
    expect(replayed.total_points).toBe(3);
    expect(replayed.last_event_id).toBe(14);
    expect(replayed.groups[0].history).toHaveLength(1);
  });

  it("空事件流 → state = null；空态是各组 0 分、无领先组", () => {
    expect(replay(groupRaceActivity, [], ctx)).toBeNull();
    const empty: GroupRaceState = emptyGroupRaceState(ctx);
    expect(empty.groups.map((g) => g.score)).toEqual([0, 0, 0]);
    expect(empty.leader_group_no).toBeNull();
    expect(empty.leader_score).toBe(0);
    expect(empty.total_points).toBe(0);
    expect(empty.last_event_id).toBeNull();
  });
});

describe("活动定义契约", () => {
  it("两个活动只消费自己的 kind，且结算声明为 session（不产生档案记录）", () => {
    expect(pickerActivity).toMatchObject({
      type: "picker",
      title: "点名台",
      requires: ["students", "dimensions"],
      settle: "session",
    });
    expect(groupRaceActivity).toMatchObject({
      type: "group-race",
      title: "小组积分赛",
      requires: ["students", "seating"],
      settle: "session",
    });
    // fallback 只在数据缺失时给文案，正常课堂为 null
    expect(pickerActivity.fallback?.(makeCtx([stu(1, "林小满", 1)]))).toBeNull();
    expect(groupRaceActivity.fallback?.(makeCtx([stu(1, "林小满", 1)]))).toBeNull();
  });
});