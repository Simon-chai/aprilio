import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  saveTimetableSlot: vi.fn(),
  saveTimetablePeriods: vi.fn(),
}));

vi.mock("../src/lib/db", () => dbMocks);

import TimetableGrid from "../src/components/TimetableGrid.vue";
import type { Timetable, TimetableSlot } from "../src/types";

const timetable: Timetable = {
  id: 7,
  class_name: "三年级二班",
  semester: "2026-2027-1",
  note: null,
  periods: null, // 默认 8 节
  created_at: "",
  updated_at: "",
};

const slots: TimetableSlot[] = [
  { id: 1, timetable_id: 7, day_of_week: 1, period: 2, subject: "语文", note: "带课本", updated_at: "" },
];

function mountGrid(editable = true) {
  return mount(TimetableGrid, {
    props: { timetable, slots, editable, mySubjects: ["语文"], today: 3, currentPeriod: 2 },
  });
}

/** 默认 8 节：上午 1~4、下午 5~8。第 2 节是第 2 行 → 周一格子索引 5 */
function cellOf(wrapper: ReturnType<typeof mountGrid>, index = 5) {
  return wrapper.findAll('button[data-test="timetable-cell"]')[index];
}

beforeEach(() => {
  dbMocks.saveTimetableSlot.mockReset().mockResolvedValue(undefined);
  dbMocks.saveTimetablePeriods.mockReset().mockResolvedValue(undefined);
});

describe("TimetableGrid.vue", () => {
  it("renders the weekday header, slot content, note and my-subject dot", () => {
    const wrapper = mountGrid();
    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("语文");
    expect(wrapper.text()).toContain("带课本");
    // 我科小圆点
    expect(wrapper.find("span[title='我的课']").exists()).toBe(true);
  });

  it("is readonly without editable cell buttons", () => {
    const wrapper = mountGrid(false);
    expect(wrapper.findAll('button[data-test="timetable-cell"]')).toHaveLength(0);
    expect(wrapper.find('button[data-test="period-editor-btn"]').exists()).toBe(false);
  });

  it("opens the cell popover prefilled and saves via saveTimetableSlot", async () => {
    const wrapper = mountGrid();
    await cellOf(wrapper).trigger("click");

    const popover = wrapper.find('[data-test="timetable-popover"]');
    expect(popover.exists()).toBe(true);
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
    const popover = wrapper.find('[data-test="timetable-popover"]');
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
});
