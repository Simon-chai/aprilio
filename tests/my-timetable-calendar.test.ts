import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  addCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  listTeacherEventsInRange: vi.fn(),
  listTimetableExceptionsWithClass: vi.fn(),
  setCalendarEventDone: vi.fn(),
  setCalendarEventTitle: vi.fn(),
}));

vi.mock("../src/lib/db", () => dbMocks);
vi.mock("../src/lib/memo-ai", () => ({ summarizeMemoTitle: vi.fn() }));

import MyTimetableCalendar from "../src/components/MyTimetableCalendar.vue";
import { summarizeMemoTitle } from "../src/lib/memo-ai";
import { mineOfClassResolver } from "../src/lib/timetable";
import type { CalendarEvent, TimetableSlotWithClass } from "../src/types";

/** 组件初始展示当前月；用「第二周的周一」锚定测试日期——它一定落在当前展示月内 */
function mondayOfCurrentMonth(): string {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), 1 - offset + 7);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${monday.getFullYear()}-${p(monday.getMonth() + 1)}-${p(monday.getDate())}`;
}

/** 该周一的我的课：两个班各一节语文（跨班聚合） + 一节数学（非我的科目） */
function rowsForMonday(): TimetableSlotWithClass[] {
  return [
    { id: 1, timetable_id: 1, day_of_week: 1, period: 2, subject: "语文", note: null, updated_at: "", class_name: "三年级二班", periods: null, my_subjects: null },
    { id: 2, timetable_id: 2, day_of_week: 1, period: 3, subject: "语文", note: null, updated_at: "", class_name: "三年级一班", periods: null, my_subjects: null },
    { id: 3, timetable_id: 2, day_of_week: 1, period: 5, subject: "数学", note: null, updated_at: "", class_name: "三年级一班", periods: null, my_subjects: null },
  ];
}

function eventOn(date: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 9,
    class_name: null,
    event_date: date,
    type: "todo",
    period: null,
    content: "收秋游回执单",
    done: 0,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function mountCalendar(props: Record<string, unknown> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/classes/:name", name: "class-detail", component: { template: "<div />" }, props: true },
    ],
  });
  const rows = rowsForMonday();
  return mount(MyTimetableCalendar, {
    props: {
      rows,
      mineOf: mineOfClassResolver(rows, ["语文"]),
      editable: true,
      ...props,
    },
    global: { plugins: [router] },
  });
}

beforeEach(() => {
  vi.mocked(summarizeMemoTitle).mockReset().mockResolvedValue(null);
  dbMocks.addCalendarEvent.mockReset().mockResolvedValue(99);
  dbMocks.listTeacherEventsInRange.mockReset().mockResolvedValue([]);
  dbMocks.listTimetableExceptionsWithClass.mockReset().mockResolvedValue([]);
  dbMocks.setCalendarEventDone.mockReset().mockResolvedValue(undefined);
  dbMocks.setCalendarEventTitle.mockReset().mockResolvedValue(undefined);
  dbMocks.deleteCalendarEvent.mockReset().mockResolvedValue(undefined);
});

describe("MyTimetableCalendar.vue（light：/timetable 日历 tab）", () => {
  it("renders a 42-cell month grid and projects my lessons (cross-class, my subjects only)", async () => {
    const wrapper = mountCalendar();
    await flushPromises();

    expect(wrapper.get('[data-test="my-calendar-title"]').text()).toMatch(/^\d{4}年\d{1,2}月$/);
    expect(wrapper.findAll('[data-test="my-calendar-cell"]')).toHaveLength(42);
    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("周日");

    // 选中有课的周一：日详情里只有我的语文（数学不是我的科目，不出现在「我的课表」投影里）
    const monday = mondayOfCurrentMonth();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();
    const courses = wrapper.findAll('[data-test="my-calendar-day-course"]');
    expect(courses).toHaveLength(2);
    expect(courses[0]!.text()).toContain("第2节");
    expect(courses[0]!.text()).toContain("语文");
    expect(courses[0]!.text()).toContain("三年级二班");
    expect(wrapper.text()).not.toContain("数学");
    // 科目稳定配色：语文 = rose
    expect(wrapper.html()).toContain("bg-rose-50");
  });

  it("keeps the profile timetable background on the month card", async () => {
    const wrapper = mountCalendar({
      surfaceClass: "aspect-[16/9]",
      surfaceStyle: { backgroundImage: "url(cached://bg_test.png)" },
    });
    await flushPromises();

    const card = wrapper.get('[data-test="my-calendar-card"]');
    expect(card.attributes("style")).toContain("cached://bg_test.png");
    expect(card.classes()).toContain("aspect-[16/9]");
  });

  it("applies the day's exceptions: cancelled lessons stay with strikethrough", async () => {
    const monday = mondayOfCurrentMonth();
    dbMocks.listTimetableExceptionsWithClass.mockResolvedValue([
      { id: 1, timetable_id: 1, exception_date: monday, period: 2, subject: "", note: "彩排", class_name: "三年级二班", created_at: "", updated_at: "" },
    ]);
    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const cancelled = wrapper
      .findAll('[data-test="my-calendar-day-course"]')
      .find((c) => c.text().includes("语文"))!;
    expect(cancelled.html()).toContain("line-through");
    expect(cancelled.text()).toContain("停");
  });

  it("shows memos in cells (1 + overflow) and in the day panel (sorted, labeled)", async () => {
    const monday = mondayOfCurrentMonth();
    dbMocks.listTeacherEventsInRange.mockResolvedValue([
      eventOn(monday, { id: 1, period: 2, content: "带课本" }),
      eventOn(monday, { id: 2, period: null, content: "收秋游回执单" }),
    ]);
    const wrapper = mountCalendar();
    await flushPromises();

    const cell = wrapper.get(`[data-date="${monday}"]`);
    expect(cell.text()).toContain("带课本");
    expect(cell.text()).toContain("+1"); // 第 2 条收进溢出

    await cell.trigger("click");
    await flushPromises();
    const labels = wrapper.findAll('[data-test="event-period-label"]').map((n) => n.text());
    expect(labels).toEqual(["第2节", "全天"]); // 节次升序、全天沉底
    expect(wrapper.findAll('[data-test="my-calendar-event-item"]')).toHaveLength(2);
  });

  it("quick-adds an all-day personal event for the selected day (with AI title backfill)", async () => {
    vi.mocked(summarizeMemoTitle).mockResolvedValue("收秋游回执单");
    const wrapper = mountCalendar();
    await flushPromises();

    const monday = mondayOfCurrentMonth();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const input = wrapper.get('[data-test="my-calendar-event-input"]');
    expect((input.element as HTMLInputElement).placeholder).toBe("记待办，回车");
    await input.setValue("周五放学前收秋游回执单");
    await input.trigger("keydown.enter");
    await flushPromises();

    // 日历速记的是全天个人事件（不绑班级、不绑节次）
    expect(dbMocks.addCalendarEvent).toHaveBeenCalledWith(null, monday, "周五放学前收秋游回执单", "todo");
    // 已配置 AI：后台生成快速浏览标题并回写
    expect(vi.mocked(summarizeMemoTitle)).toHaveBeenCalledWith("周五放学前收秋游回执单");
    expect(dbMocks.setCalendarEventTitle).toHaveBeenCalledWith(99, "收秋游回执单");
  });

  it("toggles and deletes events from the day panel", async () => {
    const monday = mondayOfCurrentMonth();
    dbMocks.listTeacherEventsInRange.mockResolvedValue([eventOn(monday)]);
    const wrapper = mountCalendar();
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const item = wrapper.get('[data-test="my-calendar-event-item"]');
    await item.find('button[aria-label="标记为已完成"]').trigger("click");
    expect(dbMocks.setCalendarEventDone).toHaveBeenCalledWith(9, true);
    await item.find('button[aria-label="删除日程"]').trigger("click");
    expect(dbMocks.deleteCalendarEvent).toHaveBeenCalledWith(9);
  });

  it("navigates months (refetch + selection follows) and jumps back to today", async () => {
    const wrapper = mountCalendar();
    await flushPromises();
    const eventCalls = dbMocks.listTeacherEventsInRange.mock.calls.length;
    const exceptionCalls = dbMocks.listTimetableExceptionsWithClass.mock.calls.length;

    const nowTitle = wrapper.get('[data-test="my-calendar-title"]').text();
    await wrapper.find('button[aria-label="上一月"]').trigger("click");
    await flushPromises();
    expect(dbMocks.listTeacherEventsInRange.mock.calls.length).toBe(eventCalls + 1);
    expect(dbMocks.listTimetableExceptionsWithClass.mock.calls.length).toBe(exceptionCalls + 1);
    expect(wrapper.get('[data-test="my-calendar-title"]').text()).not.toBe(nowTitle);
    // 选中日跟着月份落到该月 1 号，详情不悬空
    expect(wrapper.get('[data-test="my-calendar-selected-title"]').text()).toContain("1日");

    await wrapper.findAll("button").find((b) => b.text() === "回到今天")!.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="my-calendar-title"]').text()).toBe(nowTitle);
    expect(wrapper.get('[data-test="my-calendar-selected-title"]').text()).toContain("今天");
  });
});

describe("MyTimetableCalendar.vue（dark：首页面板内）", () => {
  it("renders the compact month grid read-only: no composer / checkbox / delete", async () => {
    const wrapper = mountCalendar({ variant: "dark" });
    await flushPromises();

    expect(wrapper.findAll('[data-test="my-calendar-cell"]')).toHaveLength(42);
    expect(wrapper.find('[data-test="my-calendar-event-input"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="删除日程"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="标记为已完成"]').exists()).toBe(false);
    // 课程以玻璃彩块呈现（首页深色面板口径）：1 条科目条 + 条外溢出数
    const monday = mondayOfCurrentMonth();
    const cell = wrapper.get(`[data-date="${monday}"]`);
    expect(cell.find('[data-test="my-calendar-course"]').text()).toBe("语文");
    expect(cell.text()).toContain("+1"); // 同天第 2 节收进溢出
  });

  it("filters the selected day's events with type pills (dim, not hide)", async () => {
    const monday = mondayOfCurrentMonth();
    dbMocks.listTeacherEventsInRange.mockResolvedValue([
      eventOn(monday, { id: 1, type: "todo", content: "收秋游回执单" }),
      eventOn(monday, { id: 2, type: "memo", content: "布置语文第 3 课抄写" }),
    ]);
    const wrapper = mountCalendar({ variant: "dark" });
    await flushPromises();
    await wrapper.find(`[data-date="${monday}"]`).trigger("click");
    await flushPromises();

    const pill = wrapper.findAll('[data-test="event-type-pill"]').find((b) => b.text().includes("待办"))!;
    await pill.trigger("click");
    const items = wrapper.findAll('[data-test="my-calendar-event-item"]');
    expect(items).toHaveLength(2);
    expect(items.filter((it) => it.classes().includes("opacity-40"))).toHaveLength(1);
    expect(wrapper.get('[data-test="my-calendar"]').text()).toContain("布置语文第 3 课抄写");

    // 再点取消筛选
    await pill.trigger("click");
    expect(wrapper.findAll('[data-test="my-calendar-event-item"].opacity-40')).toHaveLength(0);
  });
});
