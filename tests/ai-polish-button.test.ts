import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

const mocks = vi.hoisted(() => ({
  polishText: vi.fn(),
  isAiPolishReady: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../src/lib/polish-ai", () => ({
  polishText: mocks.polishText,
  isAiPolishReady: mocks.isAiPolishReady,
}));

vi.mock("../src/composables/useToast", () => ({
  useToast: () => mocks.toast,
}));

import AiPolishButton from "../src/components/ui/AiPolishButton.vue";

const baseProps = {
  text: "今天作业整体不错有俩错题",
  scene: "作业备注",
  hint: "记在学生作业记录里的简短备注",
  context: "科目：语文",
  maxLen: 200,
};

const mountBtn = (props: Record<string, unknown> = {}) =>
  mount(AiPolishButton, { props: { ...baseProps, ...props } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAiPolishReady.mockReturnValue(true);
});

describe("AiPolishButton", () => {
  it("AI 未就绪时置灰、不发起润色，并给出悬浮说明", async () => {
    mocks.isAiPolishReady.mockReturnValue(false);
    const w = mountBtn();
    const btn = w.find('[data-test="ai-polish-btn"]');
    expect(btn.attributes("disabled")).toBeDefined();
    expect(w.find('[role="tooltip"]').text()).toContain("未配置 AI");
    await btn.trigger("click");
    expect(mocks.polishText).not.toHaveBeenCalled();
    w.unmount();
  });

  it("输入为空时置灰（没有内容就没有润色对象）", async () => {
    const w = mountBtn({ text: "   " });
    expect(w.find('[data-test="ai-polish-btn"]').attributes("disabled")).toBeDefined();
    await w.find('[data-test="ai-polish-btn"]').trigger("click");
    expect(mocks.polishText).not.toHaveBeenCalled();
    w.unmount();
  });

  it("点击润色：场景上下文透传给 polishText，apply 抛回结果并轻提示", async () => {
    mocks.polishText.mockResolvedValue("作业整体完成较好，有两处错题需订正");
    const w = mountBtn();
    await w.find('[data-test="ai-polish-btn"]').trigger("click");
    await flushPromises();

    expect(mocks.polishText).toHaveBeenCalledTimes(1);
    expect(mocks.polishText).toHaveBeenCalledWith(
      {
        scene: "作业备注",
        hint: "记在学生作业记录里的简短备注",
        context: "科目：语文",
        text: "今天作业整体不错有俩错题",
      },
      { maxLen: 200 },
    );
    expect(w.emitted("apply")?.[0]).toEqual(["作业整体完成较好，有两处错题需订正"]);
    expect(mocks.toast).toHaveBeenCalledWith("已润色，可继续编辑");
    w.unmount();
  });

  it("等待期间按钮进入「润色中」并保持置灰", async () => {
    let resolveFn: (v: string) => void = () => {};
    mocks.polishText.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveFn = resolve;
      }),
    );
    const w = mountBtn();
    await w.find('[data-test="ai-polish-btn"]').trigger("click");
    expect(w.text()).toContain("润色中");
    expect(w.find('[data-test="ai-polish-btn"]').attributes("disabled")).toBeDefined();

    resolveFn("结果");
    await flushPromises();
    expect(w.emitted("apply")?.[0]).toEqual(["结果"]);
    w.unmount();
  });

  it("润色失败：toast 报错、不抛 apply，按钮恢复可点", async () => {
    mocks.polishText.mockRejectedValue(new Error("模型请求失败"));
    const w = mountBtn();
    await w.find('[data-test="ai-polish-btn"]').trigger("click");
    await flushPromises();

    expect(w.emitted("apply")).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith("模型请求失败", { tone: "error" });
    expect(w.find('[data-test="ai-polish-btn"]').attributes("disabled")).toBeUndefined();
    w.unmount();
  });
});
