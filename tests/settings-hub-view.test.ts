import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SettingsHubView from "../src/views/SettingsHubView.vue";
import { router } from "../src/router";

async function mountHub() {
  await router.push({ name: "settings-center" });
  await router.isReady();
  const wrapper = mount(SettingsHubView, {
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
}

describe("SettingsHubView 设置中心枢纽", () => {
  it("呈现三个配置入口卡片", async () => {
    const wrapper = await mountHub();
    expect(wrapper.text()).toContain("设置中心");
    expect(wrapper.find('[data-test="hub-prompts"]').text()).toContain("提示词管理");
    expect(wrapper.find('[data-test="hub-recycle"]').text()).toContain("回收站");
    expect(wrapper.find('[data-test="hub-settings"]').text()).toContain("数据与设置");
  });

  it("点卡片进入对应配置页", async () => {
    const wrapper = await mountHub();

    await wrapper.find('[data-test="hub-prompts"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("prompts");

    await router.push({ name: "settings-center" });
    await flushPromises();
    await wrapper.find('[data-test="hub-settings"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("settings");
  });
});
