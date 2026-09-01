import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { nextTick } from "vue";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import HomeView from "../src/views/HomeView.vue";

vi.mock("../src/composables/usePagedScroll", () => ({
  usePagedScroll: () => ({
    index: ref(0),
    heroProgress: ref(0),
    goTo: vi.fn(),
    next: vi.fn(),
  }),
}));

describe("HomeView", () => {
  it("keeps the down cue horizontally centered while applying vertical motion", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/home", component: HomeView }],
    });
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
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/home", component: HomeView }],
    });
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
});
