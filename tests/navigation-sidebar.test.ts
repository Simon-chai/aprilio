import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";
import AppSidebar from "../src/components/AppSidebar.vue";
import { router } from "../src/router";

describe("AppSidebar navigation", () => {
  it("contains 班级管理 nav item", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.text()).toContain("班级管理");
  });

  it("activates classes item when navigating to /classes", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    const classesLink = wrapper
      .findAll("a")
      .find((a) => a.text().includes("班级管理"));
    expect(classesLink).toBeDefined();
    expect(classesLink?.classes()).toContain("bg-canvas");
    expect(classesLink?.classes()).toContain("font-semibold");
  });

  it("activates classes item when navigating to /classes/三年级二班", async () => {
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    const classesLink = wrapper
      .findAll("a")
      .find((a) => a.text().includes("班级管理"));
    expect(classesLink).toBeDefined();
    expect(classesLink?.classes()).toContain("bg-canvas");
    expect(classesLink?.classes()).toContain("font-semibold");
  });

  it("renders fullscreen toggle button with F11 hint", () => {
    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    const button = wrapper.find("button");
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("进入全屏");
    expect(button.text()).toContain("F11");
  });

  it("renders AppSidebar on /classes and hides it on /home", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(App, {
      global: {
        plugins: [router],
        stubs: {
          RouterView: true,
          AgentChat: true,
        },
      },
    });

    expect(wrapper.findComponent(AppSidebar).exists()).toBe(true);

    await router.push("/home");
    await router.isReady();
    expect(wrapper.findComponent(AppSidebar).exists()).toBe(false);
  });

  it("教学世界：侧栏不含配置项，并提供设置中心入口", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.text()).toContain("设置中心");
    expect(wrapper.text()).not.toContain("提示词管理");
    expect(wrapper.text()).not.toContain("回收站");
    expect(wrapper.text()).not.toContain("数据与设置");
    // 设置中心是侧栏上唯一的配置入口，点它进枢纽页
    const entry = wrapper.find('[data-test="settings-center-entry"]');
    expect(entry.exists()).toBe(true);
    expect(entry.text()).toContain("Ctrl+,");
  });

  it("配置世界：/prompts 下侧栏整体切换，配置项高亮", async () => {
    await router.push("/prompts");
    await router.isReady();

    const wrapper = mount(AppSidebar, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.text()).toContain("返回教学");
    expect(wrapper.text()).toContain("设置中心");
    expect(wrapper.text()).toContain("提示词管理");
    expect(wrapper.text()).not.toContain("班级管理");
    const promptsLink = wrapper
      .findAll("a")
      .find((a) => a.text().includes("提示词管理"));
    expect(promptsLink?.classes()).toContain("bg-canvas");
    expect(promptsLink?.classes()).toContain("font-semibold");
  });

  it("配置世界覆盖全部配置类路由（枢纽 / 回收站 / 数据与设置）", async () => {
    for (const name of ["settings-center", "recycle-bin", "settings"]) {
      await router.push({ name });
      await router.isReady();

      const wrapper = mount(AppSidebar, {
        global: {
          plugins: [router],
        },
      });

      expect(wrapper.text()).toContain("返回教学");
      expect(wrapper.text()).not.toContain("班级管理");
    }
  });

  it("Ctrl+, 从业务页面直达设置中心", async () => {
    await router.push("/classes");
    await router.isReady();

    mount(App, {
      global: {
        plugins: [router],
        stubs: {
          RouterView: true,
          AgentChat: true,
        },
      },
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "," }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("settings-center");
  });
});
