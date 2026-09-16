import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import PickerPanel from "../src/components/classroom/PickerPanel.vue";
import GroupRacePanel from "../src/components/classroom/GroupRacePanel.vue";
import { reduce as reducePicker } from "../src/classroom/activities/picker.activity";
import { reduce as reduceGroupRace } from "../src/classroom/activities/group-race.activity";
import { LESSON_CTX } from "../src/classroom/types";
import type {
  ClassroomGroup,
  ClassroomStudent,
  LessonContext,
  LessonEvent,
  LessonEventInput,
  LessonSession,
  SeatingGrid,
} from "../src/classroom/types";

/**
 * 两个活动面板（PickerPanel / GroupRacePanel）浅挂载冒烟：
 * 关键文案与按钮在位、点击后按契约发事件、撤销走 ctx.revoke。
 * LessonContext 用自造 stub 注入（不触碰 db / 框架装配）。
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

const STUDENTS: ClassroomStudent[] = [stu(1, "林小满", 1), stu(2, "陈子墨", 1), stu(3, "王一诺", 2)];
const GROUPS: ClassroomGroup[] = [
  { group_no: 1, name: "第 1 组", students: STUDENTS.slice(0, 2) },
  { group_no: 2, name: "第 2 组", students: STUDENTS.slice(2) },
];
const SEATING: SeatingGrid = {
  rows: 1,
  cols: STUDENTS.length,
  cells: [STUDENTS.map((s) => s)],
  derived: true,
};

/** 假 LessonContext：emit/revoke 是 spy，其余按契约形状给最小实现 */
function makeStubCtx(days: Record<number, number | null> = {}) {
  const emit = vi.fn(
    async (input: LessonEventInput): Promise<LessonEvent> => ({
      id: 900,
      session_id: SESSION.id,
      student_id: input.student_id ?? null,
      activity: input.activity,
      kind: input.kind,
      payload: input.payload ?? {},
      settled_record_id: null,
      occurred_at: "2026-09-17 10:20:00",
      created_at: "2026-09-17 10:20:00",
      revoked_at: null,
    }),
  );
  const revoke = vi.fn(async () => {});
  const toast = vi.fn();
  const ctx: LessonContext = {
    session: SESSION,
    students: STUDENTS,
    seating: SEATING,
    groups: GROUPS,
    dimensions: [],
    daysSincePicked: (studentId: number) => (studentId in days ? days[studentId] : null),
    activities: [],
    activityState: () => null,
    activityConfig: () => ({}),
    emit,
    revoke,
    onEvent: () => () => {},
    ui: { toast, confirm: async () => true },
  };
  return { ctx, emit, revoke, toast };
}

/** 造一条 pick 事件（挂在 state 上供撤销用） */
function pickEvent(id: number, studentId: number): LessonEvent {
  return {
    id,
    session_id: SESSION.id,
    student_id: studentId,
    activity: "picker",
    kind: "pick",
    payload: { mode: "random", weight: 1 },
    settled_record_id: null,
    occurred_at: "2026-09-17 10:10:00",
    created_at: "2026-09-17 10:10:00",
    revoked_at: null,
  };
}

/** 造一条 group_point 事件 */
function pointEvent(id: number, groupNo: number, delta: number, reason = "发言"): LessonEvent {
  return {
    id,
    session_id: SESSION.id,
    student_id: null,
    activity: "group-race",
    kind: "group_point",
    payload: { group_no: groupNo, delta, reason },
    settled_record_id: null,
    occurred_at: "2026-09-17 10:12:00",
    created_at: "2026-09-17 10:12:00",
    revoked_at: null,
  };
}

function mountWithCtx(component: Parameters<typeof mount>[0], ctx: LessonContext, props: Record<string, unknown>) {
  return mount(component, { props, global: { provide: { [LESSON_CTX]: ctx } } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("PickerPanel.vue", () => {
  it("零事件（state=null）时按空态渲染：模式、覆盖率、点名池、沉默预警", () => {
    const { ctx } = makeStubCtx({ 1: null, 2: 5, 3: 0 });
    const w = mountWithCtx(PickerPanel, ctx, { state: null, config: {} });

    expect(w.get('[data-test="pick-name"]').text()).toBe("准备好了吗？");
    expect(w.get('[data-test="pick-coverage"]').text()).toContain("已覆盖 0 / 3 人");
    expect(w.get('[data-test="pick-called-empty"]').text()).toContain("还没点过");
    expect(w.get('[data-test="pick-mode-chip"]').text()).toContain("均匀随机");
    expect(w.get('[data-test="pick-mode-random"]').exists()).toBe(true);
    expect(w.get('[data-test="pick-mode-weighted"]').exists()).toBe(true);
    expect(w.get('[data-test="pick-roll"]').text()).toContain("开始抽取");
    expect(w.findAll('[data-test="pick-pool-item"]')).toHaveLength(3);
    expect(w.get('[data-test="pick-pool-hint"]').text()).toContain("未点 3 人");
    // 沉默预警按未点天数降序：从未被点的排最前
    const silentRows = w.findAll('[data-test="pick-silent-row"]');
    expect(silentRows[0].text()).toContain("林小满");
    expect(silentRows[0].text()).toContain("从未被点到");
    w.unmount();
  });

  it("点「开始抽取」走动画后 emit pick（均匀随机 → weight=1）", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ctx, emit } = makeStubCtx({ 1: 0, 2: 5, 3: null });
    const w = mountWithCtx(PickerPanel, ctx, { state: null, config: {} });

    await w.get('[data-test="pick-roll"]').trigger("click");
    expect(w.get('[data-test="pick-roll"]').attributes("disabled")).toBeDefined();

    vi.advanceTimersByTime(900);
    await flushPromises();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      activity: "picker",
      kind: "pick",
      student_id: 1,
      payload: { mode: "random", weight: 1 },
    });
    expect(w.get('[data-test="pick-name"]').text()).toBe("林小满");
    w.unmount();
  });

  it("切「关注沉默」后抽取：payload.mode=weighted，weight 取未点天数权重", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ctx, emit } = makeStubCtx({ 1: null, 2: 5, 3: 0 });
    const w = mountWithCtx(PickerPanel, ctx, { state: null, config: { mode: "weighted" } });

    expect(w.get('[data-test="pick-mode-chip"]').text()).toContain("关注沉默");
    await w.get('[data-test="pick-roll"]').trigger("click");
    vi.advanceTimersByTime(900);
    await flushPromises();

    expect(emit).toHaveBeenCalledWith({
      activity: "picker",
      kind: "pick",
      student_id: 1,
      payload: { mode: "weighted", weight: 50 },
    });
    w.unmount();
  });

  it("点池中姓名 = 手动点名（mode=hand，不带权重）", async () => {
    vi.useFakeTimers();
    const { ctx, emit } = makeStubCtx({ 1: 0, 2: 0, 3: 0 });
    const w = mountWithCtx(PickerPanel, ctx, { state: null, config: {} });

    await w.findAll('[data-test="pick-pool-item"]')[1].trigger("click");
    vi.advanceTimersByTime(900);
    await flushPromises();

    expect(emit).toHaveBeenCalledWith({
      activity: "picker",
      kind: "pick",
      student_id: 2,
      payload: { mode: "hand" },
    });
    w.unmount();
  });

  it("已点名单可撤销：按事件 id 调 ctx.revoke", async () => {
    const { ctx, revoke } = makeStubCtx({ 1: 0, 2: 0, 3: 0 });
    const state = reducePicker(null, pickEvent(321, 2), ctx);
    const w = mountWithCtx(PickerPanel, ctx, { state, config: {} });

    expect(w.findAll('[data-test="pick-called-chip"]')).toHaveLength(1);
    expect(w.get('[data-test="pick-called-list"]').text()).toContain("陈子墨");
    expect(w.get('[data-test="pick-coverage"]').text()).toContain("已覆盖 1 / 3 人");

    await w.get('[data-test="pick-called-list"] button[aria-label="撤销这次点名"]').trigger("click");
    await flushPromises();

    expect(revoke).toHaveBeenCalledWith(321);
    w.unmount();
  });
});

describe("GroupRacePanel.vue", () => {
  it("零事件（state=null）时各组 0 分，撤销按钮禁用", () => {
    const { ctx } = makeStubCtx();
    const w = mountWithCtx(GroupRacePanel, ctx, { state: null, config: {} });

    expect(w.findAll('[data-test="group-board"] article')).toHaveLength(2);
    expect(w.get('[data-test="group-card-1"]').text()).toContain("第 1 组");
    expect(w.get('[data-test="group-score-1"]').text()).toBe("0");
    expect(w.get('[data-test="group-score-2"]').text()).toBe("0");
    expect(w.get('[data-test="group-total"]').text()).toContain("共 0 分");
    expect(w.get('[data-test="group-undo"]').attributes("disabled")).toBeDefined();
    expect(w.findAll('[data-test="group-reason-发言"]')).toHaveLength(1);
    w.unmount();
  });

  it("点 ＋1 按钮 emit group_point（组号 / 分值 / 理由）", async () => {
    const { ctx, emit } = makeStubCtx();
    const w = mountWithCtx(GroupRacePanel, ctx, { state: null, config: {} });

    await w.get('[data-test="group-point-1-p1"]').trigger("click");
    await flushPromises();

    expect(emit).toHaveBeenCalledWith({
      activity: "group-race",
      kind: "group_point",
      payload: { group_no: 1, delta: 1, reason: "发言" },
    });

    await w.get('[data-test="group-point-2-m1"]').trigger("click");
    await flushPromises();
    expect(emit).toHaveBeenLastCalledWith({
      activity: "group-race",
      kind: "group_point",
      payload: { group_no: 2, delta: -1, reason: "发言" },
    });
    w.unmount();
  });

  it("自定义理由优先于胶囊理由；config.deltaPresets 可定制档位", async () => {
    const { ctx, emit } = makeStubCtx();
    const w = mountWithCtx(GroupRacePanel, ctx, { state: null, config: { deltaPresets: [2, -2] } });

    expect(w.find('[data-test="group-point-1-p1"]').exists()).toBe(false);
    await w.get('[data-test="group-reason-custom"] input').setValue("小组互助到位");
    await w.get('[data-test="group-point-1-p2"]').trigger("click");
    await flushPromises();

    expect(emit).toHaveBeenCalledWith({
      activity: "group-race",
      kind: "group_point",
      payload: { group_no: 1, delta: 2, reason: "小组互助到位" },
    });
    w.unmount();
  });

  it("领先组高亮 + 撤销刚才的加分 → ctx.revoke(最近一条事件 id)", async () => {
    const { ctx, revoke } = makeStubCtx();
    let state = reduceGroupRace(null, pointEvent(777, 1, 3, "合作"), ctx);
    state = reduceGroupRace(state, pointEvent(778, 2, 1, "发言"), ctx);
    const w = mountWithCtx(GroupRacePanel, ctx, { state, config: {} });

    expect(w.get('[data-test="group-score-1"]').text()).toBe("3");
    expect(w.findAll('[data-test="group-lead-badge"]')).toHaveLength(1);
    expect(w.get('[data-test="group-card-1"]').text()).toContain("领先");
    expect(w.get('[data-test="group-card-1"] [data-test="group-last-point"]').text()).toContain("合作");
    expect(w.get('[data-test="group-total"]').text()).toContain("共 4 分");

    await w.get('[data-test="group-undo"]').trigger("click");
    await flushPromises();
    expect(revoke).toHaveBeenCalledWith(778);
    w.unmount();
  });
});