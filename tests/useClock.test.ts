import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClock } from "../src/composables/useClock";

describe("useClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 30, 12, 34, 10, 500));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the clock stable between minute boundaries", async () => {
    const Harness = defineComponent({
      setup() {
        return useClock();
      },
      template: "<time>{{ hhmm }}</time>",
    });
    const wrapper = mount(Harness);
    const initial = wrapper.vm.now;

    await vi.advanceTimersByTimeAsync(1_000);
    await nextTick();
    expect(wrapper.vm.now.getTime()).toBe(initial.getTime());

    await vi.advanceTimersByTimeAsync(49_000);
    expect(wrapper.text()).toBe("12:35");
  });
});
