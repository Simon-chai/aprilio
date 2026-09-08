import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  saveTimetableSlot: vi.fn(),
  saveTimetablePeriods: vi.fn(),
  listClassEventsInRange: vi.fn(),
  addCalendarEvent: vi.fn(),
  setCalendarEventDone: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  setCalendarEventTitle: vi.fn(),
}));

vi.mock("../src/lib/db", () => dbMocks);
vi.mock("../src/lib/memo-ai", () => ({ summarizeMemoTitle: vi.fn().mockResolvedValue(null) }));

import TimetableGrid from "../src/components/TimetableGrid.vue";
import type { CalendarEvent, Timetable, TimetableSlot, TimetableSlotWithClass } from "../src/types";

/** 邻班撞课素材：周一第 2 节也是语文（本班 timetable_id=7，邻班=8） */
function conflictRow(overrides: Partial<TimetableSlotWithClass> = {}): TimetableSlotWithClass {
  return {
    id: 101,
    timetable_id: 8,
    day_of_week: 1,
    period: 2,
    subject: "语文",
    note: null,
    updated_at: "",
    class_name: "三年级一班",
    periods: null,
    my_subjects: null,
    ...overrides,
  };
}

const timetable: Timetable = {
  id: 7,
  class_name: "三年级二班",
  semester: "2026-2027-1",
  note: null,
  periods: null, // 默认 8 节
  my_subjects: null,
  created_at: "",
  updated_at: "",
};

const slots: TimetableSlot[] = [
  { id: 1, timetable_id: 7, day_of_week: 1, period: 2, subject: "语文", note: "带课本", updated_at: "" },
];

function mountGrid(editable = true, extraProps: Record<string, unknown> = {}) {
  return mount(TimetableGrid, {
    props: {
      timetable,
      slots,
      editable,
      mySubjects: ["语文"],
      today: 3,
      currentPeriod: 2,
      ...extraProps,
    },
  });
}

/** CSS Grid 列式渲染后按（天:节）定位格子 */
function cellOf(wrapper: ReturnType<typeof mountGrid>, day = 1, period = 2) {
  return wrapper.get(`[data-cell="${day}:${period}"]`);
}

beforeEach(() => {
  dbMocks.saveTimetableSlot.mockReset().mockResolvedValue(undefined);
  dbMocks.saveTimetablePeriods.mockReset().mockResolvedValue(undefined);
  dbMocks.listClassEventsInRange.mockReset().mockResolvedValue([]);
  dbMocks.addCalendarEvent.mockReset().mockResolvedValue(1);
  dbMocks.setCalendarEventDone.mockReset().mockResolvedValue(undefined);
  dbMocks.deleteCalendarEvent.mockReset().mockResolvedValue(undefined);
  dbMocks.setCalendarEventTitle.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimetableGrid.vue", () => {
  it("renders the weekday header, slot content, note and my-subject dot", () => {
    const wrapper = mountGrid();
    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("语文");
    expect(wrapper.text()).toContain("带课本");
    // 我科小圆点（班级未标记 → 回退全局任教学科）
    expect(wrapper.find("span[title='我的课']").exists()).toBe(true);
  });

  it("is readonly without editable cell buttons", () => {
    const wrapper = mountGrid(false);
    expect(wrapper.findAll('[data-test="timetable-cell"][role="button"]')).toHaveLength(0);
    expect(wrapper.find('button[data-test="period-editor-btn"]').exists()).toBe(false);
  });

  it("opens the cell popover prefilled and saves via saveTimetableSlot", async () => {
    const wrapper = mountGrid();
    await cellOf(wrapper).trigger("click");

    const popover = wrapper.get('[data-test="timetable-popover"]');
    expect((popover.get('input[data-test="slot-subject-input"]').element as HTMLInputElement).value).toBe("语文");
    expect((popover.get('input[data-test="slot-note-input"]').element as HTMLInputElement).value).toBe("带课本");

    await popover.get('input[data-test="slot-subject-input"]').setValue("英语");
    const saveBtn = popover.findAll("button").find((b) => b.text() === "保存");
    await saveBtn!.trigger("click");
    await flushPromises();

    expect(dbMocks.saveTimetableSlot).toHaveBeenCalledWith(7, 1, 2, "英语", "带课本");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
  });

  it("saves a preset chip subject and clears the cell on 清空", async () => {
    const wrapper = mountGrid();
    await cellOf(wrapper).trigger("click");
    const popover = wrapper.get('[data-test="timetable-popover"]');
    await popover.findAll("button").find((b) => b.text() === "数学")!.trigger("click");
    const saveBtn = popover.findAll("button").find((b) => b.text() === "保存");
    await saveBtn!.trigger("click");
    await flushPromises();
    expect(dbMocks.saveTimetableSlot).toHaveBeenLastCalledWith(7, 1, 2, "数学", "带课本");

    await cellOf(wrapper).trigger("click");
    await wrapper.get('button[data-test="slot-clear"]').trigger("click");
    await flushPromises();
    expect(dbMocks.saveTimetableSlot).toHaveBeenLastCalledWith(7, 1, 2, "");
  });

  it("merges consecutive periods with the same subject into one spanning block", () => {
    const mergedSlots: TimetableSlot[] = [
      { id: 1, timetable_id: 7, day_of_week: 2, period: 1, subject: "数学", note: null, updated_at: "" },
      { id: 2, timetable_id: 7, day_of_week: 2, period: 2, subject: "数学", note: null, updated_at: "" },
      { id: 3, timetable_id: 7, day_of_week: 3, period: 1, subject: "数学", note: "单节", updated_at: "" },
    ];
    const wrapper = mount(TimetableGrid, {
      props: { timetable, slots: mergedSlots, editable: false, mySubjects: [], today: null, currentPeriod: null },
    });
    // 周二第 1、2 节合并成一个块（同科目同备注），定位容器从 2:1 开始且跨 2 行
    const block = wrapper.get('[data-cell="2:1"]');
    expect(block.element.parentElement?.getAttribute("style")).toContain("span 2");
    // 被合并的第 2 节不再单独渲染
    expect(wrapper.find('[data-cell="2:2"]').exists()).toBe(false);
    // 备注不同不合并
    expect(wrapper.get('[data-cell="3:1"]').element.parentElement?.getAttribute("style")).not.toContain("span 2");
  });

  it("marks class-level my subjects: class marks override global fallback", () => {
    // 班级标记 [数学]：数学格子加蓝点，语文（全局学科）不加
    const wrapper = mountGrid(true, { classMarked: ["数学"] });
    const mathSlot: TimetableSlot[] = [
      { id: 1, timetable_id: 7, day_of_week: 4, period: 3, subject: "数学", note: null, updated_at: "" },
    ];
    const w2 = mount(TimetableGrid, {
      props: { timetable, slots: mathSlot, editable: false, mySubjects: ["语文"], classMarked: ["数学"], today: null, currentPeriod: null },
    });
    expect(w2.get('[data-cell="4:3"]').find("span[title='我的课']").exists()).toBe(true);
    void wrapper;
  });

  it("edits period config: default 8 rows, remove one and save", async () => {
    const wrapper = mountGrid();
    await wrapper.get('button[data-test="period-editor-btn"]').trigger("click");

    const editor = wrapper.get('[data-test="period-editor"]');
    expect(editor.findAll('input[type="time"]')).toHaveLength(16); // 8 节 × 起止

    await editor.find('button[aria-label="删除该节次"]').trigger("click");
    const saveBtn = editor.findAll("button").find((b) => b.text() === "保存");
    await saveBtn!.trigger("click");
    await flushPromises();

    expect(dbMocks.saveTimetablePeriods).toHaveBeenCalledOnce();
    const saved = dbMocks.saveTimetablePeriods.mock.calls[0][1] as { period: number }[];
    expect(saved).toHaveLength(7);
    expect(saved.map((p) => p.period)).toEqual([2, 3, 4, 5, 6, 7, 8]); // 删除的是第 1 节
    expect(wrapper.emitted("changed")).toHaveLength(1);
  });

  describe("跨班撞课检测", () => {
    it("arms the warning on first save: shows conflict, keeps popover, does not persist", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow()] });
      await cellOf(wrapper).trigger("click"); // 预填「语文」，与邻班周一第 2 节撞课
      const popover = wrapper.get('[data-test="timetable-popover"]');

      await popover.get('button[data-test="slot-save"]').trigger("click");

      const warning = wrapper.get('[data-test="conflict-warning"]');
      expect(warning.text()).toContain("这个时段你还要上别的班");
      expect(warning.text()).toContain("三年级一班（语文）");
      expect(wrapper.get('button[data-test="slot-save"]').text()).toBe("仍要保存");
      expect(dbMocks.saveTimetableSlot).not.toHaveBeenCalled();
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);
    });

    it("persists on the second save (仍要保存) and closes the popover", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow()] });
      await cellOf(wrapper).trigger("click");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await flushPromises();

      expect(dbMocks.saveTimetableSlot).toHaveBeenCalledExactlyOnceWith(7, 1, 2, "语文", "带课本");
      expect(wrapper.emitted("changed")).toHaveLength(1);
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
    });

    it("resets the armed state when subject changes, re-arms on the next save", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow()] });
      await cellOf(wrapper).trigger("click");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      expect(wrapper.get('[data-test="conflict-warning"]').exists()).toBe(true);

      // 改科目 → 警告消失、按钮回「保存」
      await wrapper.get('input[data-test="slot-subject-input"]').setValue("英语");
      expect(wrapper.find('[data-test="conflict-warning"]').exists()).toBe(false);
      expect(wrapper.get('button[data-test="slot-save"]').text()).toBe("保存");

      // 改回冲突科目 → 重新武装
      await wrapper.get('input[data-test="slot-subject-input"]').setValue("语文");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      expect(wrapper.get('[data-test="conflict-warning"]').exists()).toBe(true);
      expect(dbMocks.saveTimetableSlot).not.toHaveBeenCalled();
    });

    it("skips detection for non-my subjects (e.g. P.E. taught by someone else)", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow({ subject: "体育" })] });
      await cellOf(wrapper).trigger("click");
      await wrapper.get('input[data-test="slot-subject-input"]').setValue("体育");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await flushPromises();

      expect(dbMocks.saveTimetableSlot).toHaveBeenCalledExactlyOnceWith(7, 1, 2, "体育", "带课本");
      expect(wrapper.find('[data-test="conflict-warning"]').exists()).toBe(false);
    });

    it("stays silent without conflictRows (zero behavior change)", async () => {
      const wrapper = mountGrid(); // 不传 conflictRows
      await cellOf(wrapper).trigger("click");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await flushPromises();

      expect(dbMocks.saveTimetableSlot).toHaveBeenCalledExactlyOnceWith(7, 1, 2, "语文", "带课本");
      expect(wrapper.find('[data-test="conflict-warning"]').exists()).toBe(false);
    });

    it("skips detection when the class marks no my-subjects (classMarked: [])", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow()], classMarked: [] });
      await cellOf(wrapper).trigger("click");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await flushPromises();

      expect(dbMocks.saveTimetableSlot).toHaveBeenCalledExactlyOnceWith(7, 1, 2, "语文", "带课本");
      expect(wrapper.find('[data-test="conflict-warning"]').exists()).toBe(false);
    });

    it("does not arm on an empty subject (clearing a cell)", async () => {
      const wrapper = mountGrid(true, { conflictRows: [conflictRow()] });
      await cellOf(wrapper).trigger("click");
      await wrapper.get('input[data-test="slot-subject-input"]').setValue("");
      await wrapper.get('button[data-test="slot-save"]').trigger("click");
      await flushPromises();

      expect(dbMocks.saveTimetableSlot).toHaveBeenCalledExactlyOnceWith(7, 1, 2, "", "带课本");
      expect(wrapper.find('[data-test="conflict-warning"]').exists()).toBe(false);
    });
  });

  describe("day-header all-day memos (class-bound, period-less)", () => {
    /** 固定到 2026-09-09（周三）：本周一 = 2026-09-07，列头日期可断言 */
    function useFixedWednesday() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0));
    }

    function memoEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
      return {
        id: 1,
        class_name: "三年级二班",
        event_date: "2026-09-07",
        type: "memo",
        period: null,
        content: "收秋游回执",
        title: null,
        done: 0,
        created_at: "",
        updated_at: "",
        ...overrides,
      };
    }

    it("loads this week's all-day class events into the weekday headers", async () => {
      useFixedWednesday();
      dbMocks.listClassEventsInRange.mockResolvedValue([
        memoEvent({ id: 1, content: "收秋游回执" }),
        memoEvent({ id: 2, content: "带跳绳", event_date: "2026-09-08" }),
        memoEvent({ id: 3, content: "第三条溢出" }),
        memoEvent({ id: 5, content: "第四条也溢出" }),
        memoEvent({ id: 4, content: "绑节次的不进列头", period: 2 }),
      ]);
      const wrapper = mountGrid();
      await flushPromises();

      // 区间查询 = 本班 × 本周一~周五
      expect(dbMocks.listClassEventsInRange).toHaveBeenCalledWith("三年级二班", "2026-09-07", "2026-09-11");
      const headers = wrapper.findAll('[data-test="grid-day-header"]');
      expect(headers).toHaveLength(5);
      // 列头带本周日期，备忘能关联到具体哪一天
      expect(headers[0]!.get('[data-test="grid-day-date"]').text()).toBe("9/7");
      // 周一列头 3 条全天事件只展示 2 条 + 溢出数；绑节次的不显示
      expect(headers[0]!.findAll('[data-test="grid-day-memo"]')).toHaveLength(2);
      expect(headers[0]!.text()).toContain("收秋游回执");
      expect(headers[0]!.text()).toContain("第三条溢出");
      expect(headers[0]!.text()).not.toContain("第四条也溢出");
      expect(headers[0]!.get('[data-test="grid-day-memo-more"]').text()).toBe("+1");
      expect(headers[1]!.text()).toContain("带跳绳");
      // 绑节次的备忘不进列头，而是落在对应格子里
      expect(headers[0]!.text()).not.toContain("绑节次的不进列头");
      expect(wrapper.get('[data-cell="1:2"]').text()).toContain("绑节次的不进列头");

      wrapper.unmount();
    });

    it("adds a memo from the header editor as an all-day class event", async () => {
      useFixedWednesday();
      const wrapper = mountGrid();
      await flushPromises();

      const headers = wrapper.findAll('[data-test="grid-day-header"]');
      await headers[0]!.trigger("click");
      const editor = wrapper.get('[data-test="grid-day-memo-editor"]');
      expect(editor.text()).toContain("全天 · 9/7 周一");

      const input = editor.get('[data-test="grid-day-memo-input"]');
      const saveBtn = editor.get('[data-test="grid-memo-save"]');
      // 空草稿时保存按钮不可点，避免落空条目
      expect((saveBtn.element as HTMLButtonElement).disabled).toBe(true);

      await input.setValue("收秋游回执");
      expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false);
      await saveBtn.trigger("click");
      await flushPromises();

      expect(dbMocks.addCalendarEvent).toHaveBeenCalledExactlyOnceWith(
        "三年级二班",
        "2026-09-07",
        "收秋游回执",
        "memo",
        null
      );
      // 保存成功后卡片自动收起
      expect(wrapper.find('[data-test="grid-day-memo-editor"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("shows the memo in the weekday header right after saving", async () => {
      useFixedWednesday();
      const wrapper = mountGrid();
      await flushPromises();

      const headers = wrapper.findAll('[data-test="grid-day-header"]');
      await headers[0]!.trigger("click");
      await wrapper.get('[data-test="grid-day-memo-input"]').setValue("收秋游回执");
      // 保存后查询返回刚落库的这条
      dbMocks.listClassEventsInRange.mockResolvedValue([memoEvent({ id: 1, content: "收秋游回执" })]);
      await wrapper.get('[data-test="grid-memo-save"]').trigger("click");
      await flushPromises();

      expect(headers[0]!.text()).toContain("收秋游回执");
      wrapper.unmount();
    });

    it("toggles done and removes a memo from the header editor", async () => {
      useFixedWednesday();
      dbMocks.listClassEventsInRange.mockResolvedValue([memoEvent({ id: 9, done: 0 })]);
      const wrapper = mountGrid();
      await flushPromises();

      await wrapper.findAll('[data-test="grid-day-header"]')[0]!.trigger("click");
      const row = wrapper.get('[data-test="grid-day-memo-row"]');

      await row.get('button[aria-label="标记为已完成"]').trigger("click");
      await flushPromises();
      expect(dbMocks.setCalendarEventDone).toHaveBeenCalledExactlyOnceWith(9, true);

      await row.get('button[aria-label="删除备忘"]').trigger("click");
      await flushPromises();
      expect(dbMocks.deleteCalendarEvent).toHaveBeenCalledExactlyOnceWith(9);

      wrapper.unmount();
    });

    it("closes the memo editor when a cell editor opens (mutual exclusion)", async () => {
      useFixedWednesday();
      const wrapper = mountGrid();
      await flushPromises();

      await wrapper.findAll('[data-test="grid-day-header"]')[0]!.trigger("click");
      expect(wrapper.find('[data-test="grid-day-memo-editor"]').exists()).toBe(true);

      await cellOf(wrapper).trigger("click");
      expect(wrapper.find('[data-test="grid-day-memo-editor"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);

      wrapper.unmount();
    });

    it("does not open the memo editor in readonly mode", async () => {
      useFixedWednesday();
      const wrapper = mountGrid(false);
      await flushPromises();

      await wrapper.findAll('[data-test="grid-day-header"]')[0]!.trigger("click");
      expect(wrapper.find('[data-test="grid-day-memo-editor"]').exists()).toBe(false);

      wrapper.unmount();
    });
  });

  describe("格子备忘（右键打开）与浮层收起", () => {
    /** 固定到 2026-09-09（周三）：本周一 = 2026-09-07 */
    function useFixedWednesday() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0));
    }

    function cellMemo(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
      return {
        id: 1,
        class_name: "三年级二班",
        event_date: "2026-09-07",
        type: "todo",
        period: 2,
        content: "收作业本",
        title: null,
        done: 0,
        created_at: "",
        updated_at: "",
        ...overrides,
      };
    }

    it("opens the cell memo editor on right click and saves a period-bound class event", async () => {
      useFixedWednesday();
      const wrapper = mountGrid();
      await flushPromises();

      await cellOf(wrapper).trigger("contextmenu");
      const editor = wrapper.get('[data-test="grid-cell-memo-editor"]');
      expect(editor.text()).toContain("周一 · 第2节");
      // 左键排课浮层不打开
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);

      const input = editor.get('[data-test="grid-cell-memo-input"]');
      const saveBtn = editor.get('[data-test="grid-cell-memo-save"]');
      expect((saveBtn.element as HTMLButtonElement).disabled).toBe(true);
      await input.setValue("收作业本");
      expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false);
      await saveBtn.trigger("click");
      await flushPromises();

      expect(dbMocks.addCalendarEvent).toHaveBeenCalledExactlyOnceWith(
        "三年级二班",
        "2026-09-07",
        "收作业本",
        "memo",
        2
      );
      // 点保存后收起
      expect(wrapper.find('[data-test="grid-cell-memo-editor"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("renders period-bound memos inside the matching cell", async () => {
      useFixedWednesday();
      dbMocks.listClassEventsInRange.mockResolvedValue([cellMemo()]);
      const wrapper = mountGrid();
      await flushPromises();

      expect(wrapper.get('[data-cell="1:2"]').text()).toContain("收作业本");
      expect(wrapper.findAll('[data-test="timetable-cell-memo"]')).toHaveLength(1);
      wrapper.unmount();
    });

    it("toggles done and removes a cell memo from the editor", async () => {
      useFixedWednesday();
      dbMocks.listClassEventsInRange.mockResolvedValue([cellMemo({ id: 9 })]);
      const wrapper = mountGrid();
      await flushPromises();

      await cellOf(wrapper).trigger("contextmenu");
      const row = wrapper.get('[data-test="grid-cell-memo-row"]');

      await row.get('button[aria-label="标记为已完成"]').trigger("click");
      await flushPromises();
      expect(dbMocks.setCalendarEventDone).toHaveBeenCalledExactlyOnceWith(9, true);

      await row.get('button[aria-label="删除备忘"]').trigger("click");
      await flushPromises();
      expect(dbMocks.deleteCalendarEvent).toHaveBeenCalledExactlyOnceWith(9);
      wrapper.unmount();
    });

    it("keeps the schedule popover and the cell memo editor mutually exclusive", async () => {
      useFixedWednesday();
      const wrapper = mountGrid();
      await flushPromises();

      await cellOf(wrapper).trigger("contextmenu");
      expect(wrapper.find('[data-test="grid-cell-memo-editor"]').exists()).toBe(true);

      await cellOf(wrapper).trigger("click");
      expect(wrapper.find('[data-test="grid-cell-memo-editor"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);

      await cellOf(wrapper).trigger("contextmenu");
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="grid-cell-memo-editor"]').exists()).toBe(true);
      wrapper.unmount();
    });

    it("does not open the cell memo editor in readonly mode", async () => {
      useFixedWednesday();
      const wrapper = mountGrid(false);
      await flushPromises();

      await cellOf(wrapper).trigger("contextmenu");
      expect(wrapper.find('[data-test="grid-cell-memo-editor"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("closes the schedule popover on Escape", async () => {
      const wrapper = mountGrid();
      await cellOf(wrapper).trigger("click");
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await flushPromises();
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("closes the schedule popover when clicking blank space outside", async () => {
      const wrapper = mountGrid();
      await cellOf(wrapper).trigger("click");
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);

      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await flushPromises();
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("keeps the popover on inside mousedown but closes it on right click", async () => {
      const wrapper = mountGrid();
      await cellOf(wrapper).trigger("click");
      const popover = wrapper.get('[data-test="timetable-popover"]');

      await popover.trigger("mousedown");
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(true);

      document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      await flushPromises();
      expect(wrapper.find('[data-test="timetable-popover"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it("labels each memo with its period inside a merged block", async () => {
      useFixedWednesday();
      const mergedSlots: TimetableSlot[] = [
        { id: 1, timetable_id: 7, day_of_week: 2, period: 1, subject: "数学", note: null, updated_at: "" },
        { id: 2, timetable_id: 7, day_of_week: 2, period: 2, subject: "数学", note: null, updated_at: "" },
      ];
      // 2026-09-08 是周二：两块合并成一个跨行块，备忘分属第 1 / 第 2 节
      dbMocks.listClassEventsInRange.mockResolvedValue([
        cellMemo({ id: 1, event_date: "2026-09-08", period: 1, content: "第一节备忘" }),
        cellMemo({ id: 2, event_date: "2026-09-08", period: 2, content: "第二节备忘" }),
      ]);
      const wrapper = mount(TimetableGrid, {
        props: { timetable, slots: mergedSlots, editable: true, mySubjects: [], today: null, currentPeriod: null },
      });
      await flushPromises();

      const block = wrapper.get('[data-cell="2:1"]');
      const labels = block.findAll('[data-test="cell-memo-period"]').map((n) => n.text());
      expect(labels).toEqual(["第1节", "第2节"]);
      wrapper.unmount();
    });
  });
});
