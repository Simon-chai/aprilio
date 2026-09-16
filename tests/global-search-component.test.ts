import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import GlobalSearch from "../src/components/GlobalSearch.vue";

/** 全局搜索浮层：数据走 db.ts 的内存演示数据（非 Tauri），跳转用内存路由观察 */
function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/home", name: "home", component: { template: "<div>Home</div>" } },
      { path: "/photos", name: "photos", component: { template: "<div>Photos</div>" } },
      { path: "/classes/:name", name: "class-detail", component: { template: "<div>Class</div>" } },
      { path: "/students/:id", name: "student-detail", component: { template: "<div>Student</div>" } },
    ],
  });
}

async function setup() {
  const router = createTestRouter();
  await router.push("/home");
  await router.isReady();
  const wrapper = mount(GlobalSearch, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  return { wrapper, router };
}

/** Ctrl/Cmd+F：cancelable 才能观测 preventDefault 效果 */
function pressCtrlF() {
  const event = new KeyboardEvent("keydown", {
    key: "f",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function panel(wrapper: VueWrapper) {
  return wrapper.find('[data-test="global-search"]');
}

function items(wrapper: VueWrapper) {
  return wrapper.findAll('[data-test="global-search-item"]');
}

function searchInput(wrapper: VueWrapper) {
  return wrapper.get('[data-test="global-search-input"] input');
}

/** 输入关键词并等过 200ms 防抖 */
async function typeAndSettle(wrapper: VueWrapper, keyword: string) {
  await searchInput(wrapper).setValue(keyword);
  vi.advanceTimersByTime(200);
  await flushPromises();
}

describe("GlobalSearch.vue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("toggles with Ctrl+F (browser find is suppressed) and closes on Esc", async () => {
    const { wrapper } = await setup();
    expect(panel(wrapper).exists()).toBe(false);

    const opened = pressCtrlF();
    await flushPromises();
    expect(opened.defaultPrevented).toBe(true);
    expect(panel(wrapper).exists()).toBe(true);
    // 打开后自动聚焦搜索框
    expect(document.activeElement).toBe(searchInput(wrapper).element);

    const closed = pressCtrlF();
    await flushPromises();
    expect(closed.defaultPrevented).toBe(true);
    expect(panel(wrapper).exists()).toBe(false);

    // Esc 关闭并清空关键词
    pressCtrlF();
    await flushPromises();
    await typeAndSettle(wrapper, "林知远");
    expect(items(wrapper)).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(panel(wrapper).exists()).toBe(false);

    pressCtrlF();
    await flushPromises();
    expect((searchInput(wrapper).element as HTMLInputElement).value).toBe("");

    wrapper.unmount();
  });

  it("searches after a 200ms debounce and groups the results", async () => {
    const { wrapper } = await setup();
    pressCtrlF();
    await flushPromises();
    expect(wrapper.text()).toContain("输入关键词搜索学生、班级、考试、照片与备忘");
    expect(wrapper.text()).toContain("↑↓ 切换 · Enter 跳转 · Esc 关闭");

    await searchInput(wrapper).setValue("林知远");
    vi.advanceTimersByTime(100);
    await flushPromises();
    expect(wrapper.findAll('[data-test="global-search-group"]')).toHaveLength(0); // 防抖未到点

    vi.advanceTimersByTime(100);
    await flushPromises();
    expect(wrapper.findAll("h3").map((h) => h.text())).toEqual(["学生"]);
    expect(items(wrapper)).toHaveLength(1);
    expect(items(wrapper)[0]!.text()).toContain("林知远");
    expect(items(wrapper)[0]!.text()).toContain("20230001");

    wrapper.unmount();
  });

  it("moves the active row with ↑↓ (wrapping) and jumps on Enter", async () => {
    const { wrapper, router } = await setup();
    pressCtrlF();
    await flushPromises();
    await typeAndSettle(wrapper, "校园运动会"); // 命中多条学生照片

    const rows = items(wrapper);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.attributes("data-active")).toBe("true");
    expect(rows[1]!.attributes("data-active")).toBe("false");

    await searchInput(wrapper).trigger("keydown", { key: "ArrowDown" });
    expect(items(wrapper)[1]!.attributes("data-active")).toBe("true");

    // 从第一条再往上：循环到最后一条
    await searchInput(wrapper).trigger("keydown", { key: "ArrowUp" });
    await searchInput(wrapper).trigger("keydown", { key: "ArrowUp" });
    expect(items(wrapper).at(-1)!.attributes("data-active")).toBe("true");

    await searchInput(wrapper).trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("photos");
    expect(panel(wrapper).exists()).toBe(false);

    wrapper.unmount();
  });

  it("jumps with route params when a row is clicked", async () => {
    const { wrapper, router } = await setup();
    pressCtrlF();
    await flushPromises();
    await typeAndSettle(wrapper, "林知远");

    await items(wrapper)[0]!.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("student-detail");
    expect(router.currentRoute.value.params.id).toBe("1");
    expect(panel(wrapper).exists()).toBe(false);

    wrapper.unmount();
  });

  it("shows 未找到匹配结果 when nothing matches", async () => {
    const { wrapper } = await setup();
    pressCtrlF();
    await flushPromises();

    await typeAndSettle(wrapper, "zzz不存在的关键词");
    expect(items(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain("未找到匹配结果");

    wrapper.unmount();
  });
});