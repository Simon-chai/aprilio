import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ToastHost from "../src/components/ui/ToastHost.vue";
import { useToast, useToastState } from "../src/composables/useToast";

enableAutoUnmount(afterEach);

describe("useToast + ToastHost", () => {
  beforeEach(() => {
    // 显式把 requestAnimationFrame 一并 fake：TransitionGroup 的离场动画依赖 rAF，
    // 推进假时钟即可确定性走完离场并从 DOM 移除
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // 单例队列跨用例共享：清空条目与计时器，避免污染下一个用例
    useToastState().clearAll();
  });

  it("push 渲染条目并带上 tone 类名", async () => {
    const toast = useToast();
    const wrapper = mount(ToastHost);

    toast("已保存");
    toast("已归档", { tone: "success" });
    toast("删除失败", { tone: "error" });
    await nextTick();

    const items = wrapper.findAll('[data-test="quick-toast"]');
    expect(items.map((item) => item.text())).toEqual(["已保存", "已归档", "删除失败"]);
    expect(items[0].classes()).toContain("toast-info");
    expect(items[1].classes()).toContain("toast-success");
    expect(items[2].classes()).toContain("toast-error");
  });

  it("info 2400ms 后自动消失，duration 可覆盖默认时长", async () => {
    const toast = useToast();
    const wrapper = mount(ToastHost);

    toast("默认时长");
    toast("自定义时长", { duration: 1000 });
    await nextTick();
    expect(wrapper.findAll('[data-test="quick-toast"]')).toHaveLength(2);

    // 自定义 1000ms 先消失
    await vi.advanceTimersByTimeAsync(1100);
    expect(wrapper.findAll('[data-test="quick-toast"]').map((i) => i.text())).toEqual([
      "默认时长",
    ]);

    // 默认 2400ms（含离场动画的 rAF 余量）后消失
    await vi.advanceTimersByTimeAsync(1400);
    expect(wrapper.findAll('[data-test="quick-toast"]').length).toBe(0);
  });

  it("error 3600ms 后自动消失，比 info 停留更久", async () => {
    const toast = useToast();
    const wrapper = mount(ToastHost);

    toast("删除失败", { tone: "error" });
    await nextTick();

    // info 时长（2400ms）已过仍在
    await vi.advanceTimersByTimeAsync(2500);
    expect(wrapper.findAll('[data-test="quick-toast"]').length).toBe(1);

    // 到 3600ms（含离场动画余量）后消失
    await vi.advanceTimersByTimeAsync(1200);
    expect(wrapper.findAll('[data-test="quick-toast"]').length).toBe(0);
  });

  it("同屏最多 3 条，超出丢弃最旧", async () => {
    const toast = useToast();
    const wrapper = mount(ToastHost);

    toast("第一条");
    toast("第二条");
    toast("第三条");
    toast("第四条");
    await nextTick();

    const items = wrapper.findAll('[data-test="quick-toast"]');
    expect(items.map((item) => item.text())).toEqual(["第二条", "第三条", "第四条"]);
  });

  it("useToast 两次调用共享同一状态（单例）", async () => {
    const first = useToast();
    const second = useToast();
    const wrapper = mount(ToastHost);

    first("来自第一次调用");
    second("来自第二次调用");
    await nextTick();

    expect(wrapper.findAll('[data-test="quick-toast"]').map((i) => i.text())).toEqual([
      "来自第一次调用",
      "来自第二次调用",
    ]);
  });
});
