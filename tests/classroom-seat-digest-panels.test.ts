import { describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SeatGridPanel from "../src/components/classroom/SeatGridPanel.vue";
import DigestPanel from "../src/components/classroom/DigestPanel.vue";
import { LESSON_CTX } from "../src/classroom/types";
import type {
  BehaviorDimension,
  ClassroomGroup,
  ClassroomStudent,
  LessonContext,
  LessonEvent,
  LessonSession,
  SeatingGrid,
} from "../src/classroom/types";
import type { SeatingActivityState } from "../src/classroom/activities/seating.activity";
import type { DigestActivityState } from "../src/classroom/activities/digest.activity";

/**
 * 座位大屏 / 小结面板浅挂载冒烟：假 LessonContext stub + props，
 * 断言关键元素渲染与 emit 调用契约（behavior / attendance / seat_change）。
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
  activities: [{ type: "seating" }, { type: "digest" }],
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

/** 2 行 3 列，右下角留一个空位（调座目标） */
const SEATING: SeatingGrid = {
  rows: 2,
  cols: 3,
  cells: [
    [A, B, null],
    [C, D, null],
  ],
  derived: false,
};

const GROUPS: ClassroomGroup[] = [
  { group_no: 1, name: "第 1 组", students: [A, B] },
  { group_no: 2, name: "第 2 组", students: [C, D] },
];

const DIMENSIONS: BehaviorDimension[] = [
  { id: 3, category: "behavior", code: "classroom", name: "课堂表现", icon: null, sort_order: 3, is_system: 1, is_active: 1 },
];

let seq = 100;

function event(partial: Partial<LessonEvent> & Pick<LessonEvent, "kind">): LessonEvent {
  seq += 1;
  return {
    id: seq,
    session_id: SESSION.id,
    student_id: null,
    activity: "seating",
    payload: {},
    settled_record_id: null,
    occurred_at: "2026-09-17 08:10:00",
    created_at: "2026-09-17 08:10:00",
    revoked_at: null,
    ...partial,
  };
}

/** 假容器：只提供组件真正用到的读模型 + 可断言的 emit/revoke/ui */
function makeContext(overrides: Partial<LessonContext> = {}): LessonContext {
  const ctx: LessonContext = {
    session: SESSION,
    students: [A, C, D], // 在班名单（陈子墨缺勤，不在其中）
    seating: SEATING,
    groups: GROUPS,
    dimensions: DIMENSIONS,
    daysSincePicked: () => null,
    activities: [],
    activityState: () => null,
    activityConfig: () => ({}),
    emit: vi.fn(async (input) =>
      event({ ...input, kind: input.kind, student_id: input.student_id ?? null }),
    ) as unknown as LessonContext["emit"],
    revoke: vi.fn(async () => {}),
    onEvent: () => () => {},
    ui: { toast: vi.fn(), confirm: vi.fn(async () => true) },
    ...overrides,
  };
  return ctx;
}

function mountPanel(component: unknown, ctx: LessonContext, props: Record<string, unknown>) {
  return mount(component as never, {
    props,
    global: { provide: { [LESSON_CTX as symbol]: ctx } },
  });
}

const SEAT_STATE: SeatingActivityState = {
  praise: { 1: 2 },
  improve: {},
  absent: [{ student_id: 2, student_name: "陈子墨" }],
  seatChanges: [],
  timeline: [
    {
      id: 11,
      kind: "behavior",
      student_id: 1,
      student_name: "林小满",
      text: "林小满 · 课堂表现 · 表扬",
      occurred_at: "2026-09-17 08:10:00",
    },
  ],
};

describe("SeatGridPanel", () => {
  it("渲染座位大屏：姓名 / 表扬角标 / 缺勤标记 / 统计与时间线", () => {
    const wrapper = mountPanel(SeatGridPanel, makeContext(), { state: SEAT_STATE, config: {} });

    expect(wrapper.find('[data-test="seat-grid-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="seat-1-1"]').text()).toContain("林小满");
    expect(wrapper.find('[data-test="seat-1-1"]').text()).toContain("表扬 2");
    expect(wrapper.find('[data-test="seat-1-2"]').text()).toContain("缺勤");
    expect(wrapper.find('[data-test="seat-2-3"]').text()).toContain("空位");
    expect(wrapper.find('[data-test="seat-praise-count"]').text()).toBe("2");
    expect(wrapper.find('[data-test="seat-absent-count"]').text()).toBe("1");
    expect(wrapper.find('[data-test="seat-absent-list"]').text()).toContain("陈子墨");
    expect(wrapper.findAll('[data-test="seat-timeline-row"]')).toHaveLength(1);
  });

  it("无座位表（derived）时展示回退提示", () => {
    const ctx = makeContext({ seating: { ...SEATING, derived: true } });
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: null, config: {} });
    expect(wrapper.find('[data-test="seat-derived-note"]').text()).toContain("按学号临时排座");
  });

  it("点座位 → 选维度/三态/评语 → emit behavior（payload 与档案负载齐备）", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: SEAT_STATE, config: {} });

    expect(wrapper.find('[data-test="seat-sheet"]').exists()).toBe(false);
    await wrapper.find('[data-test="seat-2-1"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="seat-sheet"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="seat-sheet"]').text()).toContain("王一诺");

    await wrapper.find('[data-test="seat-polarity-improve"]').trigger("click");
    await wrapper.find('[data-test="seat-comment"]').setValue("课堂专注度需提升");
    await wrapper.find('[data-test="seat-submit"]').trigger("click");
    await flushPromises();

    const emit = ctx.emit as unknown as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      activity: "seating",
      kind: "behavior",
      student_id: 3,
      payload: { dimension_id: 3, type: "improve", via: "seat" },
      behavior: {
        dimension_id: 3,
        dimension_name_snap: "课堂表现",
        category_snap: "behavior",
        type: "improve",
        comment: "课堂专注度需提升",
      },
    });
    // 提交后浮层关闭
    expect(wrapper.find('[data-test="seat-sheet"]').exists()).toBe(false);
  });

  it("评语为空时不发事件（toast 提示）", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: SEAT_STATE, config: {} });

    await wrapper.find('[data-test="seat-1-1"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="seat-submit"]').trigger("click");
    await flushPromises();

    expect(ctx.emit as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(ctx.ui.toast).toHaveBeenCalled();
  });

  it("缺勤/归班：emit attendance，payload.absent 取反", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: SEAT_STATE, config: {} });

    // 陈子墨当前缺勤（state.absent 命中）→ 应发归班
    await wrapper.find('[data-test="seat-1-2"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="seat-absent"]').text()).toContain("归班");
    await wrapper.find('[data-test="seat-absent"]').trigger("click");
    await flushPromises();

    const emit = ctx.emit as unknown as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      activity: "seating",
      kind: "attendance",
      student_id: 2,
      payload: { absent: false },
    });
  });

  it("调座：浮层「调整座位」→ 点空位 → emit seat_change（真实命令走 assignSeat）", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: SEAT_STATE, config: {} });

    await wrapper.find('[data-test="seat-1-1"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="seat-move"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="seat-move-hint"]').text()).toContain("林小满");

    await wrapper.find('[data-test="seat-2-3"]').trigger("click");
    await flushPromises();

    const emit = ctx.emit as unknown as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      activity: "seating",
      kind: "seat_change",
      student_id: 1,
      payload: { student_id: 1, from: { row: 1, col: 1 }, to: { row: 2, col: 3 } },
    });
    expect(wrapper.find('[data-test="seat-move-hint"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="seat-2-3"]').text()).toContain("林小满");
  });

  it("时间线撤销走 ctx.revoke（确认门 + 撤销）", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(SeatGridPanel, ctx, { state: SEAT_STATE, config: {} });

    await wrapper.find('[data-test="seat-revoke-11"]').trigger("click");
    await flushPromises();

    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(ctx.revoke).toHaveBeenCalledWith(11);
  });
});

describe("DigestPanel", () => {
  const DIGEST_EVENTS: LessonEvent[] = [
    event({ kind: "pick", student_id: 1, activity: "picker" }),
    event({ kind: "behavior", student_id: 1, payload: { dimension_id: 3, type: "praise", via: "seat" } }),
    event({ kind: "behavior", student_id: 3, payload: { dimension_id: 3, type: "improve", via: "seat" } }),
    event({ kind: "attendance", student_id: 2, payload: { absent: true } }),
    event({ kind: "pick", student_id: 3, activity: "picker" }),
    event({ kind: "group_point", activity: "group-race", payload: { group_no: 1, delta: 2, reason: "发言" } }),
    event({ kind: "pick", student_id: 1, activity: "picker" }),
  ];

  const DIGEST_STATE: DigestActivityState = { events: DIGEST_EVENTS };

  it("实时统计：点名人次 / 表扬 / 待改进 / 沉默预警 / 时间线", () => {
    const wrapper = mountPanel(DigestPanel, makeContext(), { state: DIGEST_STATE, config: {} });

    expect(wrapper.find('[data-test="digest-pick-count"]').text()).toBe("3");
    expect(wrapper.find('[data-test="digest-praise-count"]').text()).toBe("1");
    expect(wrapper.find('[data-test="digest-improve-count"]').text()).toBe("1");
    // roster = 在班 3 人 + 座位里的缺勤 1 人 → 缺勤姓名可解析
    expect(wrapper.find('[data-test="digest-absent"]').text()).toContain("陈子墨");
    // 李思远既未被点也无表现记录 → 沉默预警
    expect(wrapper.find('[data-test="digest-silent"]').text()).toContain("李思远");
    expect(wrapper.find('[data-test="digest-groups"]').text()).toContain("第 1 组");
    expect(wrapper.findAll('[data-test="digest-timeline-row"]')).toHaveLength(DIGEST_EVENTS.length);
  });

  it("「生成小结」→ 演示态回退数据版并渲染预览", async () => {
    const ctx = makeContext();
    const wrapper = mountPanel(DigestPanel, ctx, { state: DIGEST_STATE, config: {} });

    expect(wrapper.find('[data-test="digest-preview"]').exists()).toBe(false);
    await wrapper.find('[data-test="digest-generate"]').trigger("click");
    await flushPromises();

    const preview = wrapper.find('[data-test="digest-preview"]');
    expect(preview.exists()).toBe(true);
    expect(preview.text()).toContain("三(2)班");
    expect(wrapper.text()).toContain("数据版");
    expect(ctx.ui.toast).toHaveBeenCalled();
  });

  it("空事件流不报错（面板显示空态）", () => {
    const wrapper = mountPanel(DigestPanel, makeContext(), {
      state: { events: [] } as DigestActivityState,
      config: {},
    });
    expect(wrapper.find('[data-test="digest-pick-count"]').text()).toBe("0");
    expect(wrapper.text()).toContain("本节课暂无记录");
  });
});