import { describe, expect, it } from "vitest";
import { seatingActivity } from "../src/classroom/activities/seating.activity";
import type { SeatingActivityState } from "../src/classroom/activities/seating.activity";
import type {
  BehaviorDimension,
  ClassroomGroup,
  ClassroomStudent,
  LessonEvent,
  LessonReadContext,
  LessonSession,
  SeatingGrid,
} from "../src/classroom/types";

/**
 * seating 活动 reduce（纯函数）：缺勤过滤/归班、表扬计数与角标、seat_change 摘要、
 * 未知 kind 跳过、撤销后重放一致、无座位表回退文案。
 */

const SESSION: LessonSession = {
  id: 1,
  class_name: "三(2)班",
  subject: "数学",
  lesson_date: "2026-09-17",
  period: 3,
  started_at: "2026-09-17 08:00:00",
  ended_at: null,
  status: "live",
  activities: [{ type: "seating" }],
  stats: null,
  digest_md: null,
  digest_source: null,
  created_at: "2026-09-17 08:00:00",
};

function student(
  id: number,
  name: string,
  row: number,
  col: number,
  group: number,
): ClassroomStudent {
  return { id, name, student_no: `2024${id}`, gender: "男", row_no: row, col_no: col, group_no: group };
}

const A = student(1, "林小满", 1, 1, 1);
const B = student(2, "陈子墨", 1, 2, 1);
const C = student(3, "王一诺", 2, 1, 2);
const D = student(4, "李思远", 2, 2, 2);

const STUDENTS = [A, B, C, D];
const SEATING: SeatingGrid = { rows: 2, cols: 2, cells: [[A, B], [C, D]], derived: false };
const GROUPS: ClassroomGroup[] = [
  { group_no: 1, name: "第 1 组", students: [A, B] },
  { group_no: 2, name: "第 2 组", students: [C, D] },
];
const DIMENSIONS: BehaviorDimension[] = [
  { id: 3, category: "behavior", code: "classroom", name: "课堂表现", icon: null, sort_order: 1, is_system: 1, is_active: 1 },
];

function ctxOf(overrides: Partial<LessonReadContext> = {}): LessonReadContext {
  return {
    session: SESSION,
    students: STUDENTS,
    seating: SEATING,
    groups: GROUPS,
    dimensions: DIMENSIONS,
    daysSincePicked: () => null,
    ...overrides,
  };
}

let seq = 0;

function event(partial: Partial<LessonEvent> & Pick<LessonEvent, "kind">): LessonEvent {
  seq += 1;
  return {
    id: seq,
    session_id: SESSION.id,
    student_id: null,
    activity: "seating",
    payload: {},
    settled_record_id: null,
    occurred_at: `2026-09-17 10:0${seq % 10}:00`,
    created_at: `2026-09-17 10:0${seq % 10}:00`,
    revoked_at: null,
    ...partial,
  };
}

function behaviorEvent(studentId: number, type: string, dimensionId = 3): LessonEvent {
  return event({
    kind: "behavior",
    student_id: studentId,
    payload: { dimension_id: dimensionId, type, via: "seat" },
    settled_record_id: 100 + seq,
  });
}

function replay(events: LessonEvent[], ctx: LessonReadContext = ctxOf()): SeatingActivityState {
  let state: SeatingActivityState | null = null;
  for (const ev of events) state = seatingActivity.reduce(state, ev, ctx);
  if (!state) throw new Error("空事件流不应产生状态");
  return state;
}

describe("seating 活动定义", () => {
  it("声明 type / 能力 / 结算（行为型 = 走双写通道）", () => {
    expect(seatingActivity.type).toBe("seating");
    expect(seatingActivity.requires).toEqual(["students", "seating", "dimensions"]);
    expect(seatingActivity.settle).toBe("behavior");
    expect(seatingActivity.component).toBeTruthy();
  });

  it("无座位表 → 回退提示（不是错误）；有座位表 → 无需降级", () => {
    const derived: SeatingGrid = { ...SEATING, derived: true };
    expect(seatingActivity.fallback!(ctxOf({ seating: derived }))).toContain("按学号临时排座");
    expect(seatingActivity.fallback!(ctxOf())).toBeNull();
  });
});

describe("seating reduce：记表现与角标", () => {
  it("按 payload.type 累加表扬/待改进计数，撰写时间线", () => {
    const state = replay([
      behaviorEvent(1, "praise"),
      behaviorEvent(1, "improve"),
      behaviorEvent(3, "praise"),
      behaviorEvent(1, "neutral"),
    ]);

    expect(state.praise[1]).toBe(1);
    expect(state.improve[1]).toBe(1);
    expect(state.praise[3]).toBe(1);
    // neutral 只进时间线，不产生角标
    expect(state.praise[4]).toBeUndefined();
    expect(state.timeline).toHaveLength(4);
    expect(state.timeline[0].text).toContain("林小满");
    expect(state.timeline[0].text).toContain("课堂表现");
    expect(state.timeline[0].text).toContain("中立");
    expect(state.timeline.every((t) => t.kind === "behavior")).toBe(true);
  });

  it("角标按学生累积（同生两次表扬 = 2）", () => {
    const state = replay([behaviorEvent(2, "praise"), behaviorEvent(2, "praise")]);
    expect(state.praise[2]).toBe(2);
  });

  it("行为事件缺 student_id 时安全跳过（不崩、不计数）", () => {
    const state = replay([event({ kind: "behavior", payload: { type: "praise" } })]);
    expect(state.praise).toEqual({});
    expect(state.timeline).toHaveLength(0);
  });

  it("维度名从读上下文的维度字典解析（维度缺失回退「表现」）", () => {
    const state = replay([behaviorEvent(1, "praise", 999)]);
    expect(state.timeline[0].text).toContain("表现");
  });
});

describe("seating reduce：缺勤与归班", () => {
  it("attendance(absent=true) 进缺勤名单，撑开名字与缺勤标记", () => {
    const state = replay([event({ kind: "attendance", student_id: 2, payload: { absent: true } })]);
    expect(state.absent).toEqual([{ student_id: 2, student_name: "陈子墨" }]);
    expect(state.timeline[0].text).toContain("标记缺勤");
  });

  it("缺勤学生不在 ctx.students 时仍能从座位网格取到名字", () => {
    const inClassOnly = STUDENTS.filter((s) => s.id !== 2);
    const state = replay(
      [event({ kind: "attendance", student_id: 2, payload: { absent: true } })],
      ctxOf({ students: inClassOnly }),
    );
    expect(state.absent[0].student_name).toBe("陈子墨");
  });

  it("attendance(absent=false) 归班：末条事件定状态", () => {
    const state = replay([
      event({ kind: "attendance", student_id: 2, payload: { absent: true } }),
      event({ kind: "attendance", student_id: 2, payload: { absent: false } }),
    ]);
    expect(state.absent).toEqual([]);
    expect(state.timeline[0].text).toContain("归班");
  });

  it("多次缺勤不重复入名单", () => {
    const state = replay([
      event({ kind: "attendance", student_id: 1, payload: { absent: true } }),
      event({ kind: "attendance", student_id: 1, payload: { absent: true } }),
    ]);
    expect(state.absent).toHaveLength(1);
  });
});

describe("seating reduce：调座摘要与未知 kind", () => {
  it("seat_change 只进摘要与时间线（真实座位命令是幂等的 assignSeat）", () => {
    const state = replay([
      behaviorEvent(1, "praise"),
      event({
        kind: "seat_change",
        student_id: 4,
        payload: { student_id: 4, from: { row: 2, col: 2 }, to: { row: 1, col: 1 } },
      }),
    ]);
    expect(state.seatChanges).toEqual([
      { student_id: 4, student_name: "李思远", from: { row: 2, col: 2 }, to: { row: 1, col: 1 } },
    ]);
    expect(state.timeline[0].text).toContain("调座");
    // 调座不影响表扬计数
    expect(state.praise[1]).toBe(1);
  });

  it("未知 kind 原样跳过（pick / group_point 等他人事件）", () => {
    const behavior = behaviorEvent(1, "praise");
    const before = replay([behavior]);
    const after = replay([
      behavior,
      event({ kind: "pick", student_id: 1, activity: "picker" }),
      event({ kind: "group_point", activity: "group-race", payload: { group_no: 1, delta: 1 } }),
      event({ kind: "future_kind", payload: { anything: [1, 2, 3] } }),
    ]);
    expect(after).toEqual(before);
  });

  it("reduce 不修改入参状态（纯函数）", () => {
    const state = replay([behaviorEvent(1, "praise")]);
    const frozen = JSON.stringify(state);
    seatingActivity.reduce(state, behaviorEvent(1, "improve"), ctxOf());
    expect(JSON.stringify(state)).toBe(frozen);
  });
});

describe("seating reduce：撤销后重放一致", () => {
  it("撤销一条 behavior → 重放结果等价于「未发生该事件」", () => {
    const praise = behaviorEvent(1, "praise");
    const improve = behaviorEvent(1, "improve");
    const attendance = event({ kind: "attendance", student_id: 3, payload: { absent: true } });
    const events = [praise, improve, attendance];

    const before = replay(events);
    expect(before.praise[1]).toBe(1);
    expect(before.improve[1]).toBe(1);
    expect(before.absent).toHaveLength(1);

    // 框架撤销：事件标记 revoked_at 后重新读流（列表里不再有该事件）→ 全量重放
    const afterRevoke = replay(events.filter((e) => e.id !== praise.id));
    expect(afterRevoke.praise[1]).toBeUndefined();
    expect(afterRevoke.improve[1]).toBe(1);
    expect(afterRevoke.absent).toEqual(before.absent);
    expect(afterRevoke.timeline).toHaveLength(before.timeline.length - 1);
  });

  it("重放与逐条增量等价（崩溃恢复 = 手工操作序列）", () => {
    const events = [
      behaviorEvent(1, "praise"),
      event({ kind: "attendance", student_id: 4, payload: { absent: true } }),
      event({
        kind: "seat_change",
        student_id: 4,
        payload: { student_id: 4, from: { row: 2, col: 2 }, to: { row: 1, col: 2 } },
      }),
    ];

    // 增量（emit 快路径）
    let incremental: SeatingActivityState | null = null;
    for (const ev of events) incremental = seatingActivity.reduce(incremental, ev, ctxOf());
    // 全量重放（恢复路径）
    const recovered = replay(events);

    expect(incremental).toEqual(recovered);
  });
});