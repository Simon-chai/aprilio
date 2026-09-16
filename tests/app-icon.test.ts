import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppIcon from "../src/components/ui/AppIcon.vue";
import { ICONS } from "../src/components/ui/icons";

/**
 * AppIcon 轻量图标注册表（规格 §3.5）：
 * - 颜色永远继承文字色（stroke=currentColor），组件本身不含任何色值
 * - 未知 name 渲染空 svg + dev 环境告警，不崩溃（对齐 Agent 未知工具兜底原则）
 */

/* 规格首批 20 个图标名 */
const FIRST_BATCH = [
  "trash",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "close",
  "arrow-left",
  "plus",
  "gear",
  "podium",
  "photo",
  "person",
  "home",
  "calendar",
  "clock",
  "more-horiz",
  "edit",
  "archive",
  "restore",
  "warn",
  "check",
];

describe("AppIcon", () => {
  // console.warn 的监听逐用例还原，避免污染其它用例的输出
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("已知 name 渲染 svg：stroke 为 currentColor、尺寸默认 16、内部元素非空", () => {
    const wrapper = mount(AppIcon, { props: { name: "trash" } });
    const svg = wrapper.find("svg");
    expect(svg.exists()).toBe(true);
    // 颜色只继承文字色，组件本身不含色值
    expect(svg.attributes("stroke")).toBe("currentColor");
    expect(svg.attributes("fill")).toBe("none");
    // size 默认 16，映射 width/height
    expect(svg.attributes("width")).toBe("16");
    expect(svg.attributes("height")).toBe("16");
    // 注册表内容经 v-html 注入到 svg 内部
    expect(svg.element.innerHTML).toContain("path");
  });

  it("size 透传：传 20 时 width/height 为 20", () => {
    const wrapper = mount(AppIcon, { props: { name: "check", size: 20 } });
    const svg = wrapper.find("svg");
    expect(svg.attributes("width")).toBe("20");
    expect(svg.attributes("height")).toBe("20");
  });

  it("未知 name：渲染空 svg（无内部元素）且 console.warn 被调用，但不崩溃", () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(AppIcon, { props: { name: "no-such-icon" } });
    const svg = wrapper.find("svg");
    expect(svg.exists()).toBe(true);
    // 渲染为空：没有任何内部元素
    expect(svg.element.children.length).toBe(0);
    expect(svg.element.innerHTML).toBe("");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("关键图标（trash / chevron-down / close / arrow-left）在注册表中非空", () => {
    for (const name of ["trash", "chevron-down", "close", "arrow-left"]) {
      expect(ICONS[name], `图标 ${name} 应已注册`).toBeTruthy();
      expect((ICONS[name] ?? "").length, `图标 ${name} 内容应非空`).toBeGreaterThan(0);
    }
  });

  it("注册表恰好收录规格首批 20 个图标", () => {
    expect(Object.keys(ICONS).sort()).toEqual([...FIRST_BATCH].sort());
  });
});
