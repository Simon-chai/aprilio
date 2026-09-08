import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ImportScoreDialog from "../src/components/ImportScoreDialog.vue";

// 让 AI 识别挂起：模拟「分析要几秒」的真实体感，分析态得以停留。
// 放独立文件：vi.mock 是文件级的，不能影响识别流程的正常用例。
vi.mock("../src/lib/ai", () => ({
  isAiConfigured: () => true,
  loadAiConfig: () => ({ provider: "test" }),
}));
vi.mock("../src/agent/providers", () => ({ createLlm: () => ({}) }));
vi.mock("../src/lib/scores", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/scores")>()),
  aiDetectScoreSheet: () => new Promise(() => {}),
}));

const SCORE_TEXT =
  "春晖小学2024级三年级（2）班2026年秋季期中考试成绩单\n" +
  "姓名,学号,语文,数学,总分\n" +
  "张小三,96001,90,85,175\n" +
  "李小红,96002,88,92,180";

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

describe("ImportScoreDialog 分析中舞台", () => {
  it("分析中动画独占舞台（min-h 舞台 + 表单内容隐藏），不与内容叠印/被裁切", async () => {
    const wrapper = mount(ImportScoreDialog, { props: { open: true } });
    (wrapper.vm as unknown as Loader).loadText(SCORE_TEXT, "期中成绩单.csv");
    await vi.dynamicImportSettled();
    await wrapper.vm.$nextTick();

    // 分析中：舞台存在且包含动效层
    const stage = wrapper.find('[data-test="analyzing-stage"]');
    expect(stage.exists()).toBe(true);
    const overlay = wrapper.find('[data-test="analyzing-overlay"]');
    expect(overlay.exists()).toBe(true);
    expect(stage.element.contains(overlay.element)).toBe(true);
    // 表单内容整体隐藏，不存在"文字被叠加层盖住一半"
    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("选择文件");

    // 回归占位：舞台类名带 min-h-[320px]，保证动画本体（约 220px 高）完整显示
    expect(stage.classes()).toContain("min-h-[320px]");
  });
});
