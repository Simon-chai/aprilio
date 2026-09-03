import { mount } from "@vue/test-utils";
import { nextTick, type Ref } from "vue";
import { describe, expect, it, vi, beforeEach } from "vitest";
import AgentChat from "../src/components/agent/AgentChat.vue";

interface ChatItemLite {
  kind: string;
  text: string;
}

/** vi.mock 工厂会被提升到顶层，用 vi.hoisted 的容器把 items 带给测试用例 */
const state = vi.hoisted(() => ({
  items: undefined as Ref<{ kind: string; text: string }[]> | undefined,
}));

vi.mock("../src/composables/useAgent", async () => {
  const { computed, ref } = await import("vue");
  const itemsRef = ref<{ kind: string; text: string }[]>([]);
  const sending = ref(false);
  state.items = itemsRef;
  return {
    useAgent: () => ({
      items: itemsRef,
      sending,
      error: ref(""),
      aiReady: computed(() => true),
      canSend: computed(() => !sending.value),
      send: vi.fn(),
      clear: vi.fn(),
    }),
  };
});

async function mountChat() {
  const wrapper = mount(AgentChat);
  await nextTick();
  return wrapper;
}

describe("AgentChat", () => {
  beforeEach(() => {
    if (state.items) state.items.value = [];
  });

  it("shows only the input bar before the conversation starts", async () => {
    const wrapper = await mountChat();

    expect(wrapper.find("#agent-log").exists()).toBe(false);
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.find('[aria-label="收起消息区"]').exists()).toBe(false);
  });

  it("reveals the message area once chatting starts and supports stage-one collapse", async () => {
    const wrapper = await mountChat();
    state.items!.value = [{ kind: "user", text: "你好" }];
    await nextTick();

    const log = wrapper.get("#agent-log");
    expect(log.classes()).toContain("max-h-[26rem]");

    // 阶段一：收起消息区 → 面板折叠、输入条上方出现展开手柄
    await wrapper.get('[aria-label="收起消息区"]').trigger("click");
    expect(wrapper.get("#agent-log").classes()).toContain("max-h-0");

    const peek = wrapper.get('[aria-label="展开对话记录"]');
    expect(peek.text()).toContain("对话 · 1 条");

    // 点手柄恢复消息区，手柄消失
    await peek.trigger("click");
    expect(wrapper.get("#agent-log").classes()).toContain("max-h-[26rem]");
    expect(wrapper.find('[aria-label="展开对话记录"]').exists()).toBe(false);
  });

  it("renders assistant messages as markdown while user messages stay plain", async () => {
    const wrapper = await mountChat();
    state.items!.value = [
      { kind: "user", text: "**不要解析我**" },
      { kind: "assistant", text: "## 结论\n\n**重点**在这里" },
    ];
    await nextTick();

    // 只有助手气泡走 markdown 渲染
    const bodies = wrapper.findAll(".md-body");
    expect(bodies.length).toBe(1);
    expect(bodies[0].find("strong").text()).toBe("重点");

    // 用户消息保持字面文本
    expect(wrapper.text()).toContain("**不要解析我**");
  });

  it("collapses the whole widget to the bubble at stage two and restores it", async () => {
    const wrapper = await mountChat();
    state.items!.value = [
      { kind: "user", text: "你好" },
      { kind: "assistant", text: "你好呀" },
    ];
    await nextTick();

    // 阶段二：整窗收成小圆钮，角标提示条数
    await wrapper.get('[aria-label="收起 AI 助手"]').trigger("click");
    expect(wrapper.find("form").exists()).toBe(false);

    const bubble = wrapper.get('[aria-label="展开 AI 助手"]');
    expect(bubble.text()).toContain("2");

    // 恢复：有对话 → 直接回到完整展开
    await bubble.trigger("click");
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.get("#agent-log").classes()).toContain("max-h-[26rem]");
  });

  it("restores to input-only when there is no conversation yet", async () => {
    const wrapper = await mountChat();

    await wrapper.get('[aria-label="收起 AI 助手"]').trigger("click");
    expect(wrapper.find("form").exists()).toBe(false);

    await wrapper.get('[aria-label="展开 AI 助手"]').trigger("click");
    expect(wrapper.find("form").exists()).toBe(true);
    expect(wrapper.find("#agent-log").exists()).toBe(false);
    expect(wrapper.find('[aria-label="展开对话记录"]').exists()).toBe(false);
  });
});
