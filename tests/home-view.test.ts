import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { nextTick } from "vue";
import { ref } from "vue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** 首页面板测试需要稳定的数据源：只 mock 课表/日程相关函数，其余（isTauri 等）保留真实现 */
const dbMocks = vi.hoisted(() => ({
  addCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  getStats: vi.fn(),
  listStudents: vi.fn(),
  listTeacherEventsInRange: vi.fn(),
  listTimetableExceptionsWithClass: vi.fn(),
  listTimetableSlotsWithClass: vi.fn(),
  setCalendarEventDone: vi.fn(),
}));

vi.mock("../src/composables/usePagedScroll", () => ({
  usePagedScroll: () => ({
    index: ref(0),
    heroProgress: ref(0),
    goTo: vi.fn(),
    next: vi.fn(),
  }),
}));

vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, ...dbMocks };
});

import HomeView from "../src/views/HomeView.vue";
import { profile } from "../src/lib/profile";
import { DEFAULT_PROFILE } from "../src/types";
import type { TimetableSlotWithClass } from "../src/types";

/** 全文件默认 mock：不配置返回值的函数（getStats/listStudents）也要给安全返回，避免渲染崩溃 */
beforeEach(() => {
  dbMocks.getStats.mockResolvedValue({ students: 10, photos: 5, month_new: 1 });
  dbMocks.listStudents.mockResolvedValue([]);
  dbMocks.listTimetableSlotsWithClass.mockResolvedValue([]);
  dbMocks.listTimetableExceptionsWithClass.mockResolvedValue([]);
  dbMocks.listTeacherEventsInRange.mockResolvedValue([]);
  dbMocks.addCalendarEvent.mockResolvedValue(99);
  dbMocks.setCalendarEventDone.mockResolvedValue(undefined);
  dbMocks.deleteCalendarEvent.mockResolvedValue(undefined);
});

function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/home", component: HomeView },
      { path: "/timetable", component: { template: "<div>timetable</div>" } },
    ],
  });
  return router;
}

describe("HomeView", () => {
  it("keeps the down cue horizontally centered while applying vertical motion", async () => {
    const router = makeRouter();
    await router.push("/home");
    await router.isReady();

    const wrapper = mount(HomeView, { global: { plugins: [router] } });
    const cue = wrapper.get('button[aria-label="向下滚动到功能页"]');

    expect(cue.attributes("style")).toContain("transform: translate3d(-50%, 0px, 0)");
    expect(cue.classes()).not.toContain("-translate-x-1/2");
  });

  it("removes inline parallax and fade styles when reduced motion is preferred", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener,
        removeEventListener,
      })),
    );
    const router = makeRouter();
    await router.push("/home");
    await router.isReady();

    const wrapper = mount(HomeView, { global: { plugins: [router] } });
    await nextTick();

    expect(wrapper.get("section[data-page=\"0\"] > div").attributes("style")).toBeFalsy();
    expect(wrapper.get("section[data-page=\"0\"] > div:nth-of-type(3)").attributes("style")).toBeFalsy();
    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(removeEventListener).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    vi.unstubAllGlobals();
  });

  it("keeps a permanent timetable entry on the features grid", async () => {
    const router = makeRouter();
    await router.push("/home");
    await router.isReady();

    const wrapper = mount(HomeView, { global: { plugins: [router] } });
    await flushPromises();

    // 常驻入口：不依赖今天是否有课 / 是否登记任教学科
    const entry = wrapper.get('[data-test="timetable-entry"]');
    expect(entry.text()).toContain("课程表");
    expect(entry.text()).toContain("排课 · 调课 · 日程"); // 空态描述：短句，不放长说明
    await entry.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/timetable");
    wrapper.unmount();
  });
});

/* ------------------------------------------------------------------ */
/* 今日课程条 + 展开面板（冻结到 2026-09-07 周一 10:00，数据确定）          */
/* ------------------------------------------------------------------ */

/** 周一（冻结日）的两节语文：三(2) 与 三(1)，用于验证跨班聚合 */
const mondayRows: TimetableSlotWithClass[] = [
  { id: 1, timetable_id: 1, day_of_week: 1, period: 2, subject: "语文", note: null, updated_at: "", class_name: "三年级二班", periods: null },
  { id: 2, timetable_id: 2, day_of_week: 1, period: 2, subject: "语文", note: null, updated_at: "", class_name: "三年级一班", periods: null },
];

describe("HomeView today panel", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 7, 10, 0)); // 周一
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    localStorage.clear();
    profile.value = { ...DEFAULT_PROFILE };
  });

  function mountHome() {
    const router = makeRouter();
    return mount(HomeView, { global: { plugins: [router] } });
  }

  async function mountWithMondayLessons() {
    // ensureProfile 的初始化 Promise 会被同文件前面的用例缓存，
    // 因此直接预设共享 profile ref（读不到任教学科就不会有今日课程条）
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    dbMocks.listTimetableSlotsWithClass.mockResolvedValue(mondayRows);
    dbMocks.listTimetableExceptionsWithClass.mockResolvedValue([]);
    dbMocks.listTeacherEventsInRange.mockResolvedValue([
      { id: 5, class_name: null, event_date: "2026-09-07", type: "homework", period: 4, content: "布置语文第 3 课抄写", done: 0, created_at: "", updated_at: "" },
      { id: 6, class_name: null, event_date: "2026-09-07", type: "todo", period: null, content: "下午教研组会议", done: 0, created_at: "", updated_at: "" },
    ]);
    const wrapper = mountHome();
    await flushPromises();
    return wrapper;
  }

  it("expands a centered semi-transparent week timetable from the left-side toggle", async () => {
    const wrapper = await mountWithMondayLessons();

    // 入口常驻左侧中间：显示今天节数角标
    const toggle = wrapper.get('[data-test="timetable-toggle"]');
    expect(toggle.text()).toContain("课表");
    expect(toggle.text()).toContain("2");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    // 常驻入口卡显示聚合数据 + 今天课程速览胶囊
    const entry = wrapper.get('[data-test="timetable-entry"]');
    expect(entry.text()).toContain("每周 2 节");
    expect(wrapper.find('[data-test="entry-today-chips"]').exists()).toBe(true);

    // 一键展开：遮罩压暗背景 + 面板含周课表与今日日程
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(false);
    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find('[data-test="panel-scrim"]').exists()).toBe(true);
    const panel = wrapper.get('[data-test="today-panel"]');
    expect(panel.text()).toContain("课程表 · 本周");
    const grid = wrapper.get('[data-test="panel-week-grid"]');
    expect(grid.text()).toContain("周一");
    expect(wrapper.findAll('[data-test="panel-period-cell"]')).toHaveLength(8);
    expect(wrapper.findAll('[data-test="panel-grid-session"]')).toHaveLength(2);
    expect(panel.text()).toContain("三年级一班");
    expect(panel.text()).toContain("今日日程");
    expect(panel.text()).toContain("布置语文第 3 课抄写");
    expect(panel.text()).toContain("下午教研组会议");
    expect(panel.text()).toContain("完整课表");

    // 再点入口一键收起
    await toggle.trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("closes the panel via the scrim", async () => {
    const wrapper = await mountWithMondayLessons();
    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(true);

    await wrapper.get('[data-test="panel-scrim"]').trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("marks a lesson cancelled in the week grid when an exception exists for today", async () => {
    // 周一第 2 节三(2)的语文停课；异常按 exception_date 命中今天
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    dbMocks.listTimetableSlotsWithClass.mockResolvedValue(mondayRows);
    dbMocks.listTimetableExceptionsWithClass.mockResolvedValue([
      { id: 1, timetable_id: 1, exception_date: "2026-09-07", period: 2, subject: "", note: "彩排", class_name: "三年级二班", created_at: "", updated_at: "" },
    ]);
    dbMocks.listTeacherEventsInRange.mockResolvedValue([]);
    const wrapper = mountHome();
    await flushPromises();

    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");
    const sessions = wrapper.findAll('[data-test="panel-grid-session"]');
    expect(sessions).toHaveLength(2); // 停课保留展示（划线），另一班照常
    const cancelled = sessions.find((s) => s.text().includes("三年级二班"))!;
    expect(cancelled.html()).toContain("line-through");
    expect(cancelled.text()).toContain("停");
    wrapper.unmount();
  });

  it("adds and toggles personal events inline in the panel", async () => {
    const wrapper = await mountWithMondayLessons();
    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");

    // 选类型「考试」再录入 → 个人事件（class_name = null）
    const examPill = wrapper.findAll("button").find((b) => b.text().includes("考试"))!;
    await examPill.trigger("click");
    await wrapper.get('[data-test="panel-event-input"]').setValue("下周一单元测验");
    await wrapper.get('[data-test="panel-event-input"]').trigger("keydown.enter");
    expect(dbMocks.addCalendarEvent).toHaveBeenCalledWith(null, "2026-09-07", "下周一单元测验", "exam");

    // 勾选完成
    const item = wrapper.get('[data-test="panel-event"]');
    await item.find('button[aria-label="标记为已完成"]').trigger("click");
    expect(dbMocks.setCalendarEventDone).toHaveBeenCalledWith(5, true);

    // 删除
    await item.find('button[aria-label="删除日程"]').trigger("click");
    expect(dbMocks.deleteCalendarEvent).toHaveBeenCalledWith(5);
    wrapper.unmount();
  });

  it("keeps the timetable entry usable without registered subjects", async () => {
    // 未登记任教学科：入口仍在（无节数角标），面板可展开看空课表 + 日程
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const wrapper = mountHome();
    await flushPromises();

    const toggle = wrapper.get('[data-test="timetable-toggle"]');
    expect(toggle.text()).not.toContain("2"); // 不知道「你的课」就不显示节数角标

    await toggle.trigger("click");
    const panel = wrapper.get('[data-test="today-panel"]');
    expect(wrapper.find('[data-test="panel-week-grid"]').exists()).toBe(true);
    expect(panel.text()).toContain("登记任教学科后");
    expect(panel.text()).toContain("今日日程");
    wrapper.unmount();
  });
});

describe("HomeView weekend fallback", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 12, 10, 0)); // 周六
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    localStorage.clear();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("keeps the left-side timetable toggle usable on weekends", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const router = makeRouter();
    const wrapper = mount(HomeView, { global: { plugins: [router] } });
    await flushPromises();

    // 周末没有单日课 → 无节数角标，但左侧入口保留且可一键展开周课表
    const toggle = wrapper.get('[data-test="timetable-toggle"]');
    expect(toggle.text()).not.toContain("2");

    await toggle.trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
