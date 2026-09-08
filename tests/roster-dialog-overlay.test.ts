import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";

// 让 AI 识别挂起：模拟「分析要几秒」的真实体感，分析态得以停留。
// 放独立文件：vi.mock 是文件级的，不能影响识别流程的正常用例。
vi.mock("../src/lib/ai", () => ({
  isAiConfigured: () => true,
  loadAiConfig: () => ({ provider: "test" }),
}));
vi.mock("../src/agent/providers", () => ({ createLlm: () => ({}) }));
vi.mock("../src/lib/roster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/roster")>()),
  aiDetectNameColumn: () => new Promise(() => {}),
}));

const TEMPLATE_TEXT = "姓名,性别,学号\n张小三,男,9000091\n李小红,女,9000092";

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

describe("ImportRosterDialog 分析中舞台", () => {
  it("分析中动画独占舞台（min-h 舞台 + 表单内容隐藏），不与内容叠印/被裁切", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    (wrapper.vm as unknown as Loader).loadText(TEMPLATE_TEXT);
    await vi.dynamicImportSettled();
    await wrapper.vm.$nextTick();

    // 分析中：舞台存在且包含动效层
    const stage = wrapper.find('[data-test="analyzing-stage"]');
    expect(stage.exists()).toBe(true);
    const overlay = wrapper.find('[data-test="analyzing-overlay"]');
    expect(overlay.exists()).toBe(true);
    expect(stage.element.contains(overlay.element)).toBe(true);
    // 表单内容整体隐藏，不存在"文字被叠加层盖住一半"
    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("智能导入");

    // 回归占位：舞台类名带 min-h-[320px]，保证动画本体（约 220px 高）完整显示
    expect(stage.classes()).toContain("min-h-[320px]");
  });
});
