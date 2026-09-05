import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";
import AppSidebar from "../src/components/AppSidebar.vue";
import { router } from "../src/router";

describe("AppSidebar navigation", () => {
  it("contains 班级管理 nav item", async () => {
    await router.push("/students");
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
});
