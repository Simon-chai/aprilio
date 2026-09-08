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

// 课表背景解析打桩：非 Tauri 环境拿不到缓存目录，把 bg_ 文件解析成可断言的地址
vi.mock("../src/lib/backgrounds", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backgrounds")>();
  return {
    ...actual,
    backgroundCacheUrl: (file: string) => `cached://${file}`,
    backgroundsFileUrl: (file: string) => `cached://${file}`,
  };
});

import HomeView from "../src/views/HomeView.vue";
import BackgroundPickerDialog from "../src/components/BackgroundPickerDialog.vue";
import { emitPageAction } from "../src/agent/page-action-bus";
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
      { id: 5, class_name: null, event_date: "2026-09-07", type: "memo", period: null, content: "布置语文第 3 课抄写", done: 0, created_at: "", updated_at: "" },
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
    // 格子只显示科目，不展示班级名
    expect(panel.text()).toContain("语文");
    expect(panel.text()).not.toContain("三年级一班");
    // 底部只读展示当天全部日程，其他类型不提供编辑入口
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

  it("switches the panel background from the library and keeps the old one in history", async () => {
    const { backgroundLibrary, registerLocalBackground } = await import(
      "../src/lib/backgrounds"
    );
    await registerLocalBackground("timetable_bg", "bg_history.png");
    const before = backgroundLibrary.value.length;

    const wrapper = await mountWithMondayLessons();
    profile.value = { ...DEFAULT_PROFILE, timetable_bg: "" };
    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");
    await wrapper.get('[data-test="panel-bg-btn"]').trigger("click");

    const picker = wrapper.findComponent(BackgroundPickerDialog);
    expect(picker.props("open")).toBe(true);

    picker.vm.$emit("select", "bg_history.png", false);
    await vi.advanceTimersByTimeAsync(420);
    expect(profile.value.timetable_bg).toBe("bg_history.png");

    // 背景立即铺上首页课表面板（深色遮罩 + 图）
    const panelStyle = wrapper.get('[data-test="today-panel"]').attributes("style") ?? "";
    expect(panelStyle).toContain("cached://bg_history.png");

    // 移除背景只清引用：图仍在图库里，随时可以再切回来
    picker.vm.$emit("clear");
    await vi.advanceTimersByTimeAsync(420);
    expect(profile.value.timetable_bg).toBe("");
    expect(wrapper.get('[data-test="today-panel"]').attributes("style") ?? "").not.toContain(
      "cached://bg_history.png",
    );
    expect(backgroundLibrary.value).toHaveLength(before);
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
    const cancelled = sessions.find((s) => s.text().includes("停"))!;
    expect(cancelled.html()).toContain("line-through");
    expect(cancelled.text()).toContain("停");
    wrapper.unmount();
  });

  it("filters today events with type pills in the read-only panel", async () => {
    const wrapper = await mountWithMondayLessons();
    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");

    // 只读：没有速记输入、勾选、删除等编辑入口
    expect(wrapper.find('[data-test="panel-event-input"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="删除备忘"]').exists()).toBe(false);

    // 点「待办」胶囊 → 选中高亮，非待办条目置灰
    const pill = wrapper.findAll('[data-test="event-type-pill"]').find((b) => b.text().includes("待办"))!;
    expect(pill.attributes("aria-pressed")).toBe("false");
    await pill.trigger("click");
    expect(pill.attributes("aria-pressed")).toBe("true");

    const items = wrapper.findAll('[data-test="panel-event"]');
    expect(items).toHaveLength(2); // 置灰不隐藏
    const dimmed = items.filter((it) => it.classes().includes("opacity-40"));
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0].text()).toContain("布置语文第 3 课抄写"); // memo 被置灰

    // 再点取消筛选，恢复全部正常展示
    await pill.trigger("click");
    expect(pill.attributes("aria-pressed")).toBe("false");
    expect(wrapper.findAll('[data-test="panel-event"].opacity-40')).toHaveLength(0);
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
    expect(panel.text()).toContain("登记任教学科");
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

/* ------------------------------------------------------------------ */
/* 番茄时钟沉浸层（冻结到 2026-09-07 周一 10:00，计时可控）               */
/* ------------------------------------------------------------------ */

describe("HomeView pomodoro", () => {
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

  it("opens a fullscreen overlay that hides hero texts and closes the timetable panel", async () => {
    const wrapper = mountHome();
    await flushPromises();

    // 先展开课表面板，进入番茄钟应把它一并收起
    await wrapper.get('[data-test="timetable-toggle"]').trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(true);

    await wrapper.get('[data-test="pomodoro-toggle"]').trigger("click");
    expect(wrapper.find('[data-test="today-panel"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="timetable-toggle"]').attributes("aria-expanded")).toBe("false");

    const overlay = wrapper.get('[data-test="pomodoro-overlay"]');
    expect(overlay.text()).toContain("25:00");
    expect(overlay.text()).toContain("专注");

    // 背景只剩图：顶栏、问候区、课表入口、向下提示全部隐藏
    expect(wrapper.get("header").isVisible()).toBe(false);
    expect(wrapper.get('section[data-page="0"] > div:nth-of-type(3)').isVisible()).toBe(false);
    expect(wrapper.get('[data-test="timetable-toggle"]').isVisible()).toBe(false);
    expect(wrapper.get('button[aria-label="向下滚动到功能页"]').isVisible()).toBe(false);

    // 退出后文字层恢复（jsdom 的 computed style 在移除 display 后有缓存滞后，
    // 这里直接断言内联样式不再带 display: none）
    await wrapper.get('[data-test="pomodoro-close"]').trigger("click");
    expect(wrapper.find('[data-test="pomodoro-overlay"]').exists()).toBe(false);
    expect(wrapper.get("header").attributes("style")).not.toContain("display: none");
    wrapper.unmount();
  });

  it("counts down while running, pauses and continues", async () => {
    const wrapper = mountHome();
    await flushPromises();
    await wrapper.get('[data-test="pomodoro-toggle"]').trigger("click");

    const primary = () => wrapper.get('[data-test="pomodoro-primary"]');
    expect(primary().text()).toBe("开始");
    await primary().trigger("click");
    expect(primary().text()).toBe("暂停");

    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(wrapper.get('[data-test="pomodoro-overlay"]').text()).toContain("24:57");

    // 暂停后时间冻结
    await primary().trigger("click");
    expect(primary().text()).toBe("继续");
    vi.advanceTimersByTime(5000);
    await nextTick();
    expect(wrapper.get('[data-test="pomodoro-overlay"]').text()).toContain("24:57");

    // 继续走表
    await primary().trigger("click");
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(wrapper.get('[data-test="pomodoro-overlay"]').text()).toContain("24:55");
    wrapper.unmount();
  });

  it("switches modes and resets the countdown to the mode duration", async () => {
    const wrapper = mountHome();
    await flushPromises();
    await wrapper.get('[data-test="pomodoro-toggle"]').trigger("click");

    const modePill = (label: string) =>
      wrapper.findAll('[data-test="pomodoro-mode"]').find((b) => b.text() === label)!;
    const overlayText = () => wrapper.get('[data-test="pomodoro-overlay"]').text();

    await modePill("短休息").trigger("click");
    expect(overlayText()).toContain("05:00");
    expect(overlayText()).toContain("短休息");

    await modePill("长休息").trigger("click");
    expect(overlayText()).toContain("15:00");

    await modePill("专注").trigger("click");
    expect(overlayText()).toContain("25:00");
    wrapper.unmount();
  });

  it("toggles run with Space, closes with Escape and keeps the paused countdown", async () => {
    const wrapper = mountHome();
    await flushPromises();
    await wrapper.get('[data-test="pomodoro-toggle"]').trigger("click");

    // 空格 = 开始/暂停
    window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    await nextTick();
    expect(wrapper.get('[data-test="pomodoro-primary"]').text()).toBe("暂停");

    vi.advanceTimersByTime(3000);
    // Esc = 退出，且退出即暂停
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(wrapper.find('[data-test="pomodoro-overlay"]').exists()).toBe(false);

    // 重新进入：倒计时停在退出时刻，可继续
    await wrapper.get('[data-test="pomodoro-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="pomodoro-overlay"]').text()).toContain("24:57");
    expect(wrapper.get('[data-test="pomodoro-primary"]').text()).toBe("继续");
    wrapper.unmount();
  });

  it("enters the immersive overlay when the Agent ui_action broadcast arrives", async () => {
    const wrapper = mountHome();
    await flushPromises();

    // Agent 经 ui_action → 页面动作总线广播（src/agent/page-actions/home.ts）
    emitPageAction("home/open-pomodoro");
    await nextTick();
    const overlay = wrapper.get('[data-test="pomodoro-overlay"]');
    expect(overlay.text()).toContain("25:00");

    // 进入的是同一个状态机：正常退出路径可用
    await wrapper.get('[data-test="pomodoro-close"]').trigger("click");
    expect(wrapper.find('[data-test="pomodoro-overlay"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
