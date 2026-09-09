import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import SettingsView from "../src/views/SettingsView.vue";
import { DEFAULT_AI_CONFIG, maskApiKey, saveAiConfig } from "../src/lib/ai";

const TEST_KEY = "sk-test-secret-1234";

beforeEach(() => {
  localStorage.clear();
});

function keyInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find("#ai-key input");
}

describe("SettingsView API 密钥脱敏显示", () => {
  it("defaults to masked display with a one-click reveal toggle", async () => {
    saveAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: TEST_KEY });
    const wrapper = mount(SettingsView);
    await flushPromises();

    // 默认 password 遮住，另有脱敏提示行，不直接展示完整密钥
    expect((keyInput(wrapper).element as HTMLInputElement).type).toBe("password");
    expect(wrapper.text()).toContain(maskApiKey(TEST_KEY));
    expect(wrapper.text()).not.toContain(TEST_KEY);

    // 一键查看：明文展示
    await wrapper.get('[data-test="ai-key-toggle"]').trigger("click");
    expect((keyInput(wrapper).element as HTMLInputElement).type).toBe("text");
    expect((keyInput(wrapper).element as HTMLInputElement).value).toBe(TEST_KEY);

    // 再点收起
    await wrapper.get('[data-test="ai-key-toggle"]').trigger("click");
    expect((keyInput(wrapper).element as HTMLInputElement).type).toBe("password");
  });

  it("saving persists the key obfuscated and hides plaintext again", async () => {
    saveAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: TEST_KEY });
    const wrapper = mount(SettingsView);
    await flushPromises();

    await wrapper.get('[data-test="ai-key-toggle"]').trigger("click");
    expect((keyInput(wrapper).element as HTMLInputElement).type).toBe("text");

    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "保存设置");
    expect(saveBtn, "保存按钮应存在").toBeDefined();
    await saveBtn!.trigger("click");

    // 存完收起明文
    expect((keyInput(wrapper).element as HTMLInputElement).type).toBe("password");
    // 落盘非明文，读回仍可用
    const raw = localStorage.getItem("aprilio.ai.config") ?? "";
    expect(raw).not.toContain(TEST_KEY);
    expect(raw).toContain("enc1:");
  });
});
