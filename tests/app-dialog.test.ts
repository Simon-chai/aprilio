import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import AppDialog from "../src/components/ui/AppDialog.vue";

// AppDialog 挂 document 级监听并维护模块级弹层栈：逐用例自动卸载，避免相互污染
enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AppDialog.vue", () => {
  it("open 时渲染 role=dialog + aria-modal，标题 id 与 aria-labelledby 关联", () => {
    const wrapper = mount(AppDialog, {
      props: { open: true, title: "弹窗标题" },
      slots: { default: "<p data-test='dialog-body'>内容</p>" },
    });

    const panel = wrapper.get('[role="dialog"]');
    expect(panel.attributes("aria-modal")).toBe("true");
    const labelledBy = panel.attributes("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    // aria-labelledby 指向的正是标题元素本身
    const title = wrapper.get(`#${labelledBy}`);
    expect(title.text()).toBe("弹窗标题");
    expect(wrapper.get('[data-test="dialog-body"]').exists()).toBe(true);
  });

  it("Esc 触发 close", async () => {
    const wrapper = mount(AppDialog, { props: { open: true, title: "标题" } });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("遮罩 mousedown 关闭", async () => {
    const wrapper = mount(AppDialog, { props: { open: true, title: "标题" } });

    await wrapper.get('[data-test="dialog-overlay"]').trigger("mousedown");

    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("closeOnOverlay=false 时遮罩点击不关闭", async () => {
    const wrapper = mount(AppDialog, {
      props: { open: true, title: "标题", closeOnOverlay: false },
    });

    await wrapper.get('[data-test="dialog-overlay"]').trigger("mousedown");

    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("双弹层打开时 Esc 只关栈顶", async () => {
    const bottom = mount(AppDialog, { props: { open: true, title: "下层弹层" } });
    const top = mount(AppDialog, { props: { open: true, title: "上层弹层" } });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(top.emitted("close")).toHaveLength(1);
    expect(bottom.emitted("close")).toBeUndefined();

    // 栈顶关闭后正确出栈，Esc 轮到下层
    await top.setProps({ open: false });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(bottom.emitted("close")).toHaveLength(1);
  });

  it("打开前聚焦的元素在关闭后焦点还原", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const wrapper = mount(AppDialog, {
      props: { open: false, title: "标题" },
      attachTo: document.body,
    });
    await wrapper.setProps({ open: true });
    await nextTick();
    // 打开后焦点圈进面板
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);

    await wrapper.setProps({ open: false });
    // 关闭后焦点还原到打开前的元素
    expect(document.activeElement).toBe(input);

    input.remove();
  });

  it("footer 插槽内容透传", () => {
    const wrapper = mount(AppDialog, {
      props: { open: true, title: "标题" },
      slots: { footer: "<button data-test='footer-action'>保存</button>" },
    });

    expect(wrapper.get('[data-test="footer-action"]').text()).toBe("保存");
  });

  it("drawer 变体贴右侧全高，类名区别于 center", () => {
    const center = mount(AppDialog, { props: { open: true, title: "居中弹层" } });
    const drawer = mount(AppDialog, {
      props: { open: true, title: "抽屉弹层", variant: "drawer" },
    });

    const drawerPanel = drawer.get('[role="dialog"]');
    expect(drawerPanel.classes()).toEqual(
      expect.arrayContaining(["fixed", "right-0", "top-0", "bottom-0"])
    );
    expect(center.get('[role="dialog"]').classes()).not.toContain("right-0");
  });
});
