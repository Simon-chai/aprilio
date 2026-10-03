import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import App from "../src/App.vue";
import { router } from "../src/router";

/**
 * 「返回教学」的足迹回归：进入配置世界前正在哪个业务页，返回就回哪。
 * 首个用例依赖「模块级足迹为空」的初始态——vitest 按文件隔离模块，恰好成立。
 */
function mountApp() {
  return mount(App, {
    global: {
      plugins: [router],
      stubs: { RouterView: true, AgentChat: true },
    },
  });
}

async function backToBiz(wrapper: ReturnType<typeof mountApp>) {
  const back = wrapper.findAll("a").find((a) => a.text().includes("返回教学"));
  expect(back, "配置世界应显示「返回教学」").toBeDefined();
  await back!.trigger("click");
  await flushPromises();
}

describe("返回教学的教学足迹", () => {
  it("应用直进配置世界（无足迹）时回落首页", async () => {
    // 先进配置世界再挂 App：足迹记录尚未开始，等同重启后深链接直进的场景
    await router.push("/prompts");
    await router.isReady();

    const wrapper = mountApp();
    await flushPromises();

    await backToBiz(wrapper);
    expect(router.currentRoute.value.name).toBe("home");
  });

  it("从业务页进设置中心，返回教学回到原页面", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mountApp();
    await flushPromises();

    await wrapper.find('[data-test="settings-center-entry"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("settings-center");

    await backToBiz(wrapper);
    expect(router.currentRoute.value.path).toBe("/classes");
  });

  it("深层业务页带参数还原（班级详情）", async () => {
    await router.push("/classes/三年级二班");
    await router.isReady();

    const wrapper = mountApp();
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "," }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("settings-center");

    await backToBiz(wrapper);
    expect(router.currentRoute.value.name).toBe("class-detail");
    expect(router.currentRoute.value.params.name).toBe("三年级二班");
  });

  it("课堂模式（无侧栏页面）也记入足迹", async () => {
    await router.push("/classes");
    await router.isReady();

    const wrapper = mountApp();
    await flushPromises();

    await router.push("/classroom");
    await flushPromises();
    // 课堂模式全屏无侧栏，Ctrl+, 是唯一入口
    window.dispatchEvent(new KeyboardEvent("keydown", { ctrlKey: true, key: "," }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe("settings-center");

    await backToBiz(wrapper);
    expect(router.currentRoute.value.name).toBe("classroom");
  });
});
