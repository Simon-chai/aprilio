import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  addCalendarEvent: vi.fn(),
  clearTimetableException: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  listClassEventsInRange: vi.fn(),
  listTimetableExceptionsInRange: vi.fn(),
  saveTimetableException: vi.fn(),
  setCalendarEventDone: vi.fn(),
}));

vi.mock("../src/lib/db", () => dbMocks);

import TimetableCalendar from "../src/components/TimetableCalendar.vue";
import type { CalendarEvent, Timetable, TimetableException, TimetableSlot } from "../src/types";

const timetable: Timetable & { slots: TimetableSlot[] } = {
  id: 7,
  class_name: "三年级二班",
  semester: "2026-2027-1",
  note: null,
  periods: null,
  created_at: "",
  updated_at: "",
  slots: [
    { id: 1, timetable_id: 7, day_of_week: 1, period: 1, subject: "数学", note: null, updated_at: "" },
    { id: 2, timetable_id: 7, day_of_week: 1, period: 2, subject: "语文", note: null, updated_at: "" },
    { id: 3, timetable_id: 7, day_of_week: 1, period: 3, subject: "英语", note: null, updated_at: "" },
    { id: 4, timetable_id: 7, day_of_week: 1, period: 5, subject: "体育", note: null, updated_at: "" },
  ],
};

/** 组件初始展示当前月；用当前月的真实周一锚定测试日期，避免跨月抖动 */
function mondayOfCurrentMonth(): string {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), 1 - offset + 7); // 第二周的周一必在本月
  const p = (n: number) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

function exceptionOn(date: string, period: number, subject: string): TimetableException {
  return {
    id: period,
    timetable_id: 7,
    exception_date: date,
    period,
    subject,
    note: null,
    created_at: "",
    updated_at: "",
  };
}

function eventOn(date: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 9,
    class_name: "三年级二班",
    event_date: date,
    type: "todo",
    content: "收秋游回执单",
    done: 0,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function mountCalendar(withTimetable = true) {
  return mount(TimetableCalendar, {
    props: {
      className: "三年级二班",
      timetable: withTimetable ? timetable : null,
    },
  });
}

beforeEach(() => {
  dbMocks.addCalendarEvent.mockReset().mockResolvedValue(99);
  dbMocks.listClassEventsInRange.mockReset().mockResolvedValue([]);
  dbMocks.listTimetableExceptionsInRange.mockReset().mockResolvedValue([]);
  dbMocks.saveTimetableException.mockReset().mockResolvedValue(undefined);
  dbMocks.clearTimetableException.mockReset().mockResolvedValue(undefined);
  dbMocks.setCalendarEventDone.mockReset().mockResolvedValue(undefined);
  dbMocks.deleteCalendarEvent.mockReset().mockResolvedValue(undefined);
});

describe("TimetableCalendar.vue", () => {
  it("renders the month grid with 42 cells and weekday header starting Monday", async () => {
    const wrapper = mountCalendar();
    await flushPromises();

    expect(wrapper.get('[data-test="calendar-title"]').text()).toMatch(/^\d{4}年\d{1,2}月$/);
    const cells = wrapper.findAll('[data-test="calendar-cell"]');
    expect(cells).toHaveLength(42);
    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("周日");
  });

  it("paints the surface style onto the month grid card when provided", async () => {
    const wrapper = mount(TimetableCalendar, {
      props: {
        className: "三年级二班",
        timetable,
        surfaceStyle: { backgroundImage: "url(cached://bg_test.png)" },
        surfaceClass: "aspect-[16/9]",
      },
    });
    await flushPromises();

    const card = wrapper.get("div.rounded-lg.border.bg-canvas");
    expect(card.attributes("style")).toContain("cached://bg_test.png");
    expect(card.classes()).toContain("aspect-[16/9]");

    // 不传 surfaceStyle / surfaceClass：保持纯色卡片、无比例约束
    const plain = mountCalendar();
    await flushPromises();
    const plainCard = plain.get("div.rounded-lg.border.bg-canvas");
    expect(plainCard.attributes("style")).toBeUndefined();
    expect(plainCard.classes()).not.toContain("aspect-[16/9]");
  });

  it("shows the selected day's courses with colored subject chips", async () => {
    const wrapper = mountCalendar();
    await flushPromises();

    const monday = mondayOfCurrentMonth();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="selected-title"]').text()).toContain("周一");
    const courses = wrapper.findAll('[data-test="day-course"]');
    expect(courses).toHaveLength(4); // 数学/语文/英语/体育
    expect(wrapper.text()).toContain("数学");
    // 科目色胶囊（预设色板）已上格子与日详情：语文 = rose
    expect(wrapper.html()).toContain("bg-rose-50");
  });

  it("applies exceptions on the selected day: cancelled shows strikethrough + restore action", async () => {
    const monday = mondayOfCurrentMonth();
    dbMocks.listTimetableExceptionsInRange.mockResolvedValue([exceptionOn(monday, 2, "")]);

    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const courses = wrapper.findAll('[data-test="day-course"]');
    expect(courses).toHaveLength(4); // 停课保留展示（划线），不是消失
    const cancelled = courses.find((c) => c.text().includes("语文"))!;
    expect(cancelled.html()).toContain("line-through");
    expect(cancelled.text()).toContain("停");

    await cancelled.get('[data-test="course-restore-btn"]').trigger("click");
    expect(dbMocks.clearTimetableException).toHaveBeenCalledWith(7, monday, 2);
  });

  it("swaps a course for that date only via the inline editor", async () => {
    const monday = mondayOfCurrentMonth();
    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const math = wrapper.findAll('[data-test="day-course"]').find((c) => c.text().includes("数学"))!;
    await math.get('[data-test="course-swap-btn"]').trigger("click");
    expect(wrapper.find('[data-test="swap-editor"]').exists()).toBe(true);

    await wrapper.get('[data-test="swap-subject-input"]').setValue("物理");
    await wrapper.findAll("button").find((b) => b.text() === "确定")!.trigger("click");
    expect(dbMocks.saveTimetableException).toHaveBeenCalledWith(7, monday, 1, "物理");
  });

  it("cancels a course (停课) with one click on the day panel", async () => {
    const monday = mondayOfCurrentMonth();
    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const english = wrapper.findAll('[data-test="day-course"]').find((c) => c.text().includes("英语"))!;
    await english.get('[data-test="course-cancel-btn"]').trigger("click");
    expect(dbMocks.saveTimetableException).toHaveBeenCalledWith(7, monday, 3, "");
  });

  it("adds an extra lesson on an empty period of the selected day", async () => {
    const monday = mondayOfCurrentMonth();
    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    await wrapper.get('[data-test="add-course-btn"]').trigger("click");
    await wrapper.get('[data-test="add-course-subject-input"]').setValue("语文");
    await wrapper.findAll("button").find((b) => b.text() === "确定")!.trigger("click");
    // 默认选第一个可加的节次（当天第 4 节为空）
    expect(dbMocks.saveTimetableException).toHaveBeenCalledWith(7, monday, 4, "语文");
  });

  it("works without a timetable: calendar + schedule hint, no exception calls", async () => {
    const wrapper = mountCalendar(false);
    await flushPromises();

    expect(wrapper.text()).toContain("点任意一天记日程");
    expect(wrapper.text()).toContain("暂无课表，点右上角「编辑课表」开始排课");
    expect(wrapper.text()).toContain("日程");
    expect(dbMocks.listTimetableExceptionsInRange).not.toHaveBeenCalled();
  });

  it("adds a typed event for the selected day and reloads the month", async () => {
    const wrapper = mountCalendar();
    await flushPromises();

    // 选类型「考试」再录入
    const examPill = wrapper.findAll('[data-test="event-type-pill"]').find((b) => b.text().includes("考试"))!;
    await examPill.trigger("click");
    await wrapper.get('[data-test="event-input"]').setValue("第一单元测验");
    await wrapper.findAll("button").find((b) => b.text() === "添加")!.trigger("click");
    await flushPromises();

    expect(dbMocks.addCalendarEvent).toHaveBeenCalledWith(
      "三年级二班",
      expect.any(String),
      "第一单元测验",
      "exam"
    );
    expect(dbMocks.listClassEventsInRange).toHaveBeenCalled();
  });

  it("toggles and deletes events via the day panel", async () => {
    const eventDate = mondayOfCurrentMonth();
    dbMocks.listClassEventsInRange.mockResolvedValue([eventOn(eventDate)]);

    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${eventDate}"]`).trigger("click");
    await flushPromises();

    const item = wrapper.get('[data-test="event-item"]');
    await item.find('button[aria-label="标记为已完成"]').trigger("click");
    expect(dbMocks.setCalendarEventDone).toHaveBeenCalledWith(9, true);
    await item.find('button[aria-label="删除日程"]').trigger("click");
    expect(dbMocks.deleteCalendarEvent).toHaveBeenCalledWith(9);
  });

  it("navigates months and refetches events + exceptions, then jumps back to today", async () => {
    const wrapper = mountCalendar();
    await flushPromises();
    const eventCalls = dbMocks.listClassEventsInRange.mock.calls.length;
    const exceptionCalls = dbMocks.listTimetableExceptionsInRange.mock.calls.length;

    await wrapper.find('button[aria-label="上一月"]').trigger("click");
    await flushPromises();
    expect(dbMocks.listClassEventsInRange.mock.calls.length).toBe(eventCalls + 1);
    expect(dbMocks.listTimetableExceptionsInRange.mock.calls.length).toBe(exceptionCalls + 1);

    await wrapper.findAll("button").find((b) => b.text() === "回到今天")!.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="selected-title"]').text()).toContain("今天");
  });

  it("offers the edit-timetable entry in the calendar header and emits edit", async () => {
    const wrapper = mountCalendar();
    await flushPromises();

    const editBtn = wrapper.get('button[data-test="edit-timetable-btn"]');
    expect(editBtn.text()).toContain("编辑课表");
    await editBtn.trigger("click");
    expect(wrapper.emitted("edit")).toHaveLength(1);
  });
});
