import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnalyzingOverlay from "../src/components/AnalyzingOverlay.vue";

describe("AnalyzingOverlay.vue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when hidden", () => {
    const wrapper = mount(AnalyzingOverlay, { props: { show: false } });
    expect(wrapper.find('[data-test="analyzing-overlay"]').exists()).toBe(false);
  });

  it("shows title, first step and elapsed time while analyzing", async () => {
    const wrapper = mount(AnalyzingOverlay, {
      props: { show: true, title: "智能识别中", steps: ["解析表格结构…", "AI 分析姓名列…"] },
    });

    expect(wrapper.get('[data-test="analyzing-overlay"]').text()).toContain("智能识别中");
    expect(wrapper.text()).toContain("解析表格结构…");
    expect(wrapper.text()).toContain("已用 0.0 秒");
  });

  it("cycles through steps as time passes", async () => {
    const wrapper = mount(AnalyzingOverlay, {
      props: { show: true, title: "智能识别中", steps: ["第一步…", "第二步…", "第三步…"] },
    });

    await vi.advanceTimersByTimeAsync(1300);
    expect(wrapper.text()).toContain("第二步…");
    expect(wrapper.text()).toContain("已用 1.3 秒");
    // 1.2s 一步：累计 2.4s 时到第三步（再过一轮会循环回第一步）
    await vi.advanceTimersByTimeAsync(1100);
    expect(wrapper.text()).toContain("第三步…");
    expect(wrapper.text()).toContain("已用 2.4 秒");
  });

  it("hides and stops timers when show turns false", async () => {
    const wrapper = mount(AnalyzingOverlay, { props: { show: true, steps: ["第一步…"] } });
    await vi.advanceTimersByTimeAsync(100);
    await wrapper.setProps({ show: false });
    await vi.advanceTimersByTimeAsync(2000);

    expect(wrapper.find('[data-test="analyzing-overlay"]').exists()).toBe(false);
  });
});
