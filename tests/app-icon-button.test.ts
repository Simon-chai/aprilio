import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import AppIconButton from "../src/components/ui/AppIconButton.vue";

// 悬浮说明 Teleport 到 body：放回按钮内会被 overflow-x-auto 紧凑工具栏
// （班级详情页学生条目区曾因此整排不可见）整颗裁掉，这里锁死「气泡挂在 body 下」
const bodyTooltip = () => document.body.querySelector("[role='tooltip']");

const mountBtn = (props: Record<string, unknown> = {}) =>
  mount(AppIconButton, {
    props: { label: "导入本班花名册", ...props },
    slots: { default: "<svg />" },
    attrs: { "data-test": "icon-btn" },
  });

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AppIconButton 悬浮说明", () => {
  it("hover 时气泡挂在 body 下并可显隐切换，按钮内不再有原位 tooltip", async () => {
    // 模拟真实页面的 overflow 工具栏：原位定位的气泡在这里会被整颗裁掉
    const toolbar = document.createElement("div");
    toolbar.className = "overflow-x-auto";
    document.body.appendChild(toolbar);

    const w = mountBtn();
    toolbar.appendChild(w.element);

    const btn = w.find("button");
    // 气泡不允许出现在按钮内部（原位定位 = 会随容器被裁剪的旧实现）
    expect(btn.find("[role='tooltip']").exists()).toBe(false);

    await btn.trigger("mouseenter");
    const tip = bodyTooltip();
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain("导入本班花名册");
    expect(tip!.className).toContain("opacity-100");

    await btn.trigger("mouseleave");
    expect(bodyTooltip()!.className).toContain("opacity-0");

    w.unmount();
    expect(bodyTooltip()).toBeNull();
  });

  it("show-label 胶囊形态不渲染悬浮说明（文字常显，不依赖悬浮）", async () => {
    const w = mountBtn({ showLabel: true });
    await w.find("button").trigger("mouseenter");
    expect(bodyTooltip()).toBeNull();
    w.unmount();
  });

  it("disabled 按钮不弹出悬浮说明", async () => {
    const w = mountBtn({ disabled: true });
    await w.find("button").trigger("mouseenter");
    expect(bodyTooltip()!.className).toContain("opacity-0");
    w.unmount();
  });

  it("Teleport 不产生副根：attrs（data-test 等）仍透传到按钮", () => {
    const w = mountBtn();
    expect(w.find("button[data-test='icon-btn']").exists()).toBe(true);
    w.unmount();
  });
});
