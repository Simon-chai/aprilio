import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MyTimetableView from "../src/views/MyTimetableView.vue";
import { profile } from "../src/lib/profile";
import { summarizeMemoTitle } from "../src/lib/memo-ai";
import { DEFAULT_PROFILE } from "../src/types";

// AI 标题生成打桩：默认不生成（null = 未配置模型路径），个别用例再改为返回标题
vi.mock("../src/lib/memo-ai", () => ({ summarizeMemoTitle: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(summarizeMemoTitle).mockResolvedValue(null);
});

/** jsdom 无 Tauri 外壳 → db.ts 走内存示例数据（三年级二班/三年级一班演示课表，周一第2节撞课） */
function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/timetable", name: "timetable", component: MyTimetableView },
      { path: "/profile", name: "profile", component: { template: "<div>profile</div>" } },
      { path: "/classes", name: "classes", component: { template: "<div>classes</div>" } },
      {
        path: "/classes/:name",
        name: "class-detail",
        component: { template: "<div>class</div>" },
        props: true,
      },
    ],
  });
  return mount(MyTimetableView, { global: { plugins: [router] } });
}

describe("MyTimetableView.vue", () => {
  // 必须排在第一个：内存示例数据以「今天」为基准生成，且模块级单例只种一次——
  // 先固定到周三再挂载，后续用例复用这份种子也不受影响（结构断言与日期无关）。
  it("shows demo memos inside their cells and day events in the header (fixed date)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // 周三，本周第 3 天
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    // 演示事件 id5 绑定今天(周三)第 4 节 → 显示在周三第 4 节的格子里（period-major 索引 = (4-1)*5+2）；
    // 未配置 AI → 显示全文前几个字（8 字截断 + 省略号）
    const cells = wrapper.findAll('[data-test="week-cell"]');
    expect(cells[17]?.text()).toContain("布置语文第 3…");
    // 演示事件 id4 绑定周五第 6 节 → (6-1)*5+4（8 字内不截断）
    expect(cells[29]?.text()).toContain("数学第一单元测验");
    // 班级事件在格子备忘里带班级名标签；个人事件（id5）不带
    expect(cells[29]!.get('[data-test="week-cell-memo"]').text()).toContain("三年级二班");
    expect(cells[17]!.get('[data-test="week-cell-memo"]').text()).not.toContain("三年级");
    // 演示事件 id6 不绑节次 → 出现在周三列头
    const headers = wrapper.findAll('[data-test="week-day-header"]');
    expect(headers[2]?.text()).toContain("下午教研组会议");

    // 点列头打开全天编辑器并速记一条
    await headers[2]!.trigger("click");
    const dayInput = wrapper.get('[data-test="week-cell-input"]');
    await dayInput.setValue("收教案");
    await dayInput.trigger("keydown.enter");
    await flushPromises();
    expect(headers[2]!.text()).toContain("收教案");

    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("defaults to the full week grid: 8 period rows even where I have no class", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-test="subjects-missing-banner"]').text()).toContain("未登记任教学科");
    expect(wrapper.text()).toContain("周课表");
    // 节次行 = 全部默认节次（8 行），不随「我的课」缩水
    const periodCells = wrapper.findAll('[data-test="week-period-cell"]');
    expect(periodCells).toHaveLength(8);
    // 节次栏只显示序号，不带时间
    for (const cell of periodCells) expect(cell.text()).not.toMatch(/\d{1,2}:\d{2}/);
    // 空格子可见（虚线占位）
    expect(wrapper.findAll('[data-test="week-empty-cell"]').length).toBeGreaterThan(0);
    // 全部课表格子可点击编辑（8 节 × 5 天），列头 5 个（全天日程入口），没有独立的日程操作区
    expect(wrapper.findAll('[data-test="week-cell"]')).toHaveLength(40);
    expect(wrapper.findAll('[data-test="week-day-header"]')).toHaveLength(5);
    expect(wrapper.find('[data-test="week-event-cell"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the three-step guide when there is nothing to show", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const wrapper = mountView();
    await flushPromises();

    const guide = wrapper.get('[data-test="timetable-guide"]');
    expect(guide.text()).toContain("登记任教学科");
    expect(guide.text()).toContain("导入课表");
    expect(guide.text()).toContain("手工排课");
    wrapper.unmount();
  });

  it("aggregates my subjects across classes and flags conflicts (按科目视图整表)", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    // 默认周课表，切到按科目
    await wrapper.findAll("button").find((b) => b.text() === "按科目")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("每周共 8 节");
    expect(wrapper.find('[data-test="conflict-banner"]').exists()).toBe(true);
    // 按科目的网格也画满 8 行节次
    const blockGrid = wrapper.get('[data-test="subject-block-grid"]');
    expect(blockGrid.findAll('[data-test="block-period-cell"]')).toHaveLength(8);
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("week view renders dated columns, subject chips and clickable cells", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("周五");
    expect(wrapper.text()).toContain("调课后的实际行程");
    // 科目稳定配色落在课程格上（语文 = rose）
    expect(wrapper.html()).toContain("bg-rose-50");
    // 40 个可点击格子；类型胶囊（图例 + 速记类型）只在课表右上角出现一处
    expect(wrapper.findAll('[data-test="week-cell"]')).toHaveLength(40);
    expect(wrapper.findAll('[data-test="event-type-pill"]')).toHaveLength(4);
    // header 常驻导入入口
    expect(wrapper.get('[data-test="import-timetable-btn"]').text()).toContain("导入课表");
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("clicks a timetable cell to add a memo right in it", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    // 第一个格子 = 周一第 1 节：点开格内编辑器
    const cell = wrapper.get('[data-test="week-cell"]');
    await cell.trigger("click");
    const input = wrapper.get('[data-test="week-cell-editor"] [data-test="week-cell-input"]');
    expect((input.element as HTMLInputElement).placeholder).toBe("记待办，回车");
    await input.setValue("带三角板");
    await input.trigger("keydown.enter");
    await flushPromises();

    // 备忘落回该格子里，编辑器保持打开可连续记
    expect(cell.text()).toContain("带三角板");
    expect(wrapper.find('[data-test="week-cell-editor"]').exists()).toBe(true);
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("binds memo type via the dot dropdown in front of the cell input", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    const cell = wrapper.get('[data-test="week-cell"]');
    await cell.trigger("click");
    const editor = wrapper.get('[data-test="week-cell-editor"]');

    // 收起态只有当前类型的色点指示器（无箭头无文字）；悬浮出现小卡片显示类型文案
    const selectBtn = editor.get('[data-test="event-type-select"]');
    expect((selectBtn.element as HTMLElement).getAttribute("aria-label")).toContain("待办");
    await selectBtn.trigger("mouseenter");
    expect(document.body.querySelector('[data-test="event-type-tip"]')?.textContent).toContain("待办");
    await selectBtn.trigger("mouseleave");

    // 展开菜单（teleport 到 body）：每项只有色点、无文字
    await selectBtn.trigger("click");
    const menuEl = document.body.querySelector('[data-test="event-type-menu"]');
    expect(menuEl).not.toBeNull();
    expect(menuEl!.textContent).not.toContain("备忘");
    const options = Array.from(menuEl!.querySelectorAll('[data-test="event-type-option"]')).map(
      (o) => new DOMWrapper(o),
    );
    expect(options).toHaveLength(4);

    // 悬浮「考试」选项 → 悬浮小卡片显示对应类型文案
    await options[2]!.trigger("mouseenter");
    expect(document.body.querySelector('[data-test="event-type-tip"]')?.textContent).toContain("考试");

    // 选「考试」→ 菜单收起、输入框 placeholder 联动
    await options[2]!.trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-test="event-type-menu"]')).toBeNull();
    const input = editor.get('[data-test="week-cell-input"]');
    expect((input.element as HTMLInputElement).placeholder).toBe("记考试，回车");

    // 速记落格（同格可能还有此前用例的备忘，按内容定位），带考试色点
    await input.setValue("周五单元测");
    await input.trigger("keydown.enter");
    await flushPromises();
    const memos = cell.findAll('[data-test="week-cell-memo"]');
    const added = memos.find((m) => m.text().includes("周五单元测"));
    expect(added).toBeDefined();
    expect(added!.find(".bg-danger").exists()).toBe(true);
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("type pills filter the grid: dim non-matching memos, highlight matching cells", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // 周三，与种子基准同周
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    // 点「考试」胶囊（memo/todo/exam/homework 第 3 枚）
    const pills = wrapper.findAll('[data-test="event-type-pill"]');
    expect(pills).toHaveLength(4);
    await pills[2]!.trigger("click");
    await flushPromises();

    // 非考试类备忘置灰（周三第 4 节的作业）
    let cells = wrapper.findAll('[data-test="week-cell"]');
    expect(cells[17]!.get('[data-test="week-cell-memo"]').classes()).toContain("opacity-40");
    // 命中考试类型的格子高亮（周五第 6 节）
    expect(cells[29]!.classes()).toContain("ring-1");
    // 列头全天待办置灰，列头本身不高亮
    const headers = wrapper.findAll('[data-test="week-day-header"]');
    expect(headers[2]!.find(".opacity-40").exists()).toBe(true);
    expect(headers[2]!.classes()).not.toContain("ring-1");

    // 再点一次取消筛选，全部恢复
    await wrapper.findAll('[data-test="event-type-pill"]')[2]!.trigger("click");
    await flushPromises();
    cells = wrapper.findAll('[data-test="week-cell"]');
    expect(cells[17]!.get('[data-test="week-cell-memo"]').classes()).not.toContain("opacity-40");
    expect(cells[29]!.classes()).not.toContain("ring-1");

    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("shows an AI quick-browse title after saving when a model is configured", async () => {
    vi.mocked(summarizeMemoTitle).mockResolvedValue("三年二班收回执");
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    const cell = wrapper.get('[data-test="week-cell"]');
    await cell.trigger("click");
    const input = wrapper.get('[data-test="week-cell-editor"] [data-test="week-cell-input"]');
    await input.setValue("周五放学前收秋游回执单，没交的名单报我");
    await input.trigger("keydown.enter");
    await flushPromises();

    // 格子里显示 AI 总结标题而非全文 / 前几字
    expect(vi.mocked(summarizeMemoTitle)).toHaveBeenCalledWith("周五放学前收秋游回执单，没交的名单报我");
    expect(cell.text()).toContain("三年二班收回执");
    expect(cell.text()).not.toContain("名单");
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("quick title reveals full text on hover and in a popover card on click", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 9, 10, 0, 0)); // 周三，与种子基准同周
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    const cells = wrapper.findAll('[data-test="week-cell"]');
    const target = cells[17]!; // 周三第 4 节 homework（8 字预览）
    const title = target.get('[data-test="memo-title"]');
    expect(title.text()).toBe("布置语文第 3…");
    // 悬浮 = 原生 tooltip 全文
    expect(title.attributes("title")).toBe("布置语文第 3 课抄写");

    // 点击标题 → 悬浮卡片展示全文；不冒泡到格子（不打开编辑器）
    await title.trigger("click");
    const pop = wrapper.get('[data-test="memo-pop"]');
    expect(pop.text()).toContain("布置语文第 3 课抄写");
    expect(pop.text()).toContain("作业");
    expect(wrapper.find('[data-test="week-cell-editor"]').exists()).toBe(false);

    // 点外面收起（VTU 挂载在游离 DOM，document 监听收不到冒泡，直接在 document 派发）
    document.dispatchEvent(new MouseEvent("mousedown"));
    await nextTick();
    expect(wrapper.find('[data-test="memo-pop"]').exists()).toBe(false);
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });
});
