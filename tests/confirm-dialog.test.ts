import { enableAutoUnmount, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import ConfirmDialog from "../src/components/ui/ConfirmDialog.vue";
import ConfirmHost from "../src/components/ui/ConfirmHost.vue";
import { confirmAction, useConfirm } from "../src/composables/useConfirm";

enableAutoUnmount(afterEach);

// confirmAction 是模块级单例：用例结束兜底取消未决确认，避免状态跨用例泄漏
afterEach(() => {
  useConfirm().cancel();
});

describe("ConfirmDialog.vue（组件形态）", () => {
  it("danger tone 时确认按钮为 danger variant，默认文案「删除」", () => {
    const wrapper = mount(ConfirmDialog, {
      props: {
        open: true,
        title: "删除学生",
        message: "删除后将移入回收站，保留 7 天。",
        tone: "danger",
      },
    });

    const confirmBtn = wrapper.get('[data-test="confirm-submit-btn"]');
    expect(confirmBtn.classes()).toContain("grad-border-danger");
    expect(confirmBtn.text()).toBe("删除");
    // 图标强调（规格 §3.2）：danger 确认按钮内渲染 warn 图标，颜色继承按钮文字色
    const icon = confirmBtn.find("svg");
    expect(icon.exists()).toBe(true);
    expect(icon.attributes("stroke")).toBe("currentColor");
  });

  it("默认 tone 确认按钮为 primary variant，默认文案「确认」", () => {
    const wrapper = mount(ConfirmDialog, { props: { open: true, title: "归档班级" } });

    const confirmBtn = wrapper.get('[data-test="confirm-submit-btn"]');
    expect(confirmBtn.classes()).toContain("btn-grad");
    expect(confirmBtn.text()).toBe("确认");
    // 图标强调仅 danger tone 有，默认确认按钮不带图标
    expect(confirmBtn.find("svg").exists()).toBe(false);
    expect(wrapper.get('[data-test="confirm-cancel-btn"]').text()).toBe("取消");
  });

  it("自定义按钮文案渲染", () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: "归档班级", confirmText: "归档", cancelText: "先等等" },
    });

    expect(wrapper.get('[data-test="confirm-submit-btn"]').text()).toBe("归档");
    expect(wrapper.get('[data-test="confirm-cancel-btn"]').text()).toBe("先等等");
  });

  it("footer 插槽支持三按钮场景（ClassesView 删除并重建）", () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: "删除班级", message: "学生档案将一并移入回收站。" },
      slots: {
        footer: `
          <button data-test="cancel-btn">取消</button>
          <button data-test="delete-btn">删除</button>
          <button data-test="delete-recreate-btn">删除并重建</button>
        `,
      },
    });

    expect(wrapper.get('[data-test="cancel-btn"]').text()).toBe("取消");
    expect(wrapper.get('[data-test="delete-btn"]').text()).toBe("删除");
    expect(wrapper.get('[data-test="delete-recreate-btn"]').text()).toBe("删除并重建");
    // 自定义 footer 完全替换默认双按钮
    expect(wrapper.find('[data-test="confirm-submit-btn"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="confirm-cancel-btn"]').exists()).toBe(false);
  });
});

describe("confirmAction + ConfirmHost（命令式）", () => {
  it("点确认 resolve true，resolve 后清空 state", async () => {
    const host = mount(ConfirmHost);
    const promise = confirmAction({ title: "归档班级", message: "归档后随时可恢复。" });
    await nextTick();

    await host.get('[data-test="confirm-submit-btn"]').trigger("click");
    await expect(promise).resolves.toBe(true);
    expect(useConfirm().state.open).toBe(false);
  });

  it("点取消 resolve false", async () => {
    const host = mount(ConfirmHost);
    const promise = confirmAction({ title: "删除学生", tone: "danger" });
    await nextTick();

    await host.get('[data-test="confirm-cancel-btn"]').trigger("click");
    await expect(promise).resolves.toBe(false);
  });

  it("Esc 走取消路径 resolve false", async () => {
    const host = mount(ConfirmHost);
    const promise = confirmAction({ title: "删除学生" });
    await nextTick();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    await expect(promise).resolves.toBe(false);
  });

  it("回车走确认路径 resolve true", async () => {
    const host = mount(ConfirmHost);
    const promise = confirmAction({ title: "清空数据", tone: "danger" });
    await nextTick();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();
    await expect(promise).resolves.toBe(true);
  });

  it("进行中重复调用返回同一个 Promise，只弹一次", async () => {
    const host = mount(ConfirmHost);
    const first = confirmAction({ title: "删除学生", tone: "danger" });
    const second = confirmAction({ title: "另一个确认" });

    expect(second).toBe(first);
    await nextTick();
    // 未决期间只弹一次，且内容保留第一次的
    expect(host.findAll('[role="dialog"]')).toHaveLength(1);
    expect(useConfirm().state.title).toBe("删除学生");

    await host.get('[data-test="confirm-cancel-btn"]').trigger("click");
    await expect(first).resolves.toBe(false);
  });
});
