import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PromptsView from "../src/views/PromptsView.vue";
import ToastHost from "../src/components/ui/ToastHost.vue";
import { confirmAction } from "../src/composables/useConfirm";
import { useToastState } from "../src/composables/useToast";
import { PROMPT_IDS } from "../src/prompts/ids";
import { loadPromptOverride, savePromptOverride } from "../src/prompts/store";

vi.mock("../src/composables/useConfirm", () => ({ confirmAction: vi.fn() }));

const mockConfirm = vi.mocked(confirmAction);

beforeEach(() => {
  localStorage.clear();
  mockConfirm.mockReset();
  useToastState().clearAll();
});

function toastTexts(host: ReturnType<typeof mount>): string {
  return host
    .findAll('[data-test="quick-toast"]')
    .map((t) => t.text())
    .join();
}

/** 左侧模块条目（按模块 id 定位，断言不依赖渲染顺序） */
function moduleItem(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.get(`[data-test="prompt-module"][data-prompt-id="${id}"]`);
}

async function mountView() {
  const wrapper = mount(PromptsView, {
    global: { stubs: { RouterLink: true } },
  });
  await flushPromises();
  return wrapper;
}

describe("PromptsView 模块列表", () => {
  it("renders every registered module grouped by its group", async () => {
    const wrapper = await mountView();

    const ids = wrapper.findAll('[data-test="prompt-module"]').map((n) => n.attributes("data-prompt-id"));
    expect(ids.sort()).toEqual(Object.values(PROMPT_IDS).sort());
    // 分组标题在列表里出现
    expect(wrapper.text()).toContain("智能助手");
    expect(wrapper.text()).toContain("内容生成");
    expect(wrapper.text()).toContain("信息识别");
  });

  it("selects the first module by default and shows its editor", async () => {
    const wrapper = await mountView();

    const editor = wrapper.get('[data-test="prompt-editor"]');
    expect((editor.get("textarea").element as HTMLTextAreaElement).value).toContain(
      "你是 aprilio（本机学生档案应用）的内置智能助手",
    );
  });

  it("switches the editor when another module is picked", async () => {
    const wrapper = await mountView();

    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");

    const value = (wrapper.get('[data-test="prompt-editor"] textarea').element as HTMLTextAreaElement).value;
    expect(value).toContain("快速浏览标题");
    // 该模块的变量说明与示例也一并展示
    expect(wrapper.text()).toContain("标题字数上限");
  });

  it("marks customized modules and counts them in the header", async () => {
    savePromptOverride(PROMPT_IDS.memoTitle, "我的标题提示词");
    const wrapper = await mountView();

    expect(moduleItem(wrapper, PROMPT_IDS.memoTitle).text()).toContain("已自定义");
    expect(wrapper.get('[data-test="prompt-custom-count"]').text()).toContain("1");
  });
});

describe("PromptsView 编辑与保存", () => {
  it("saves the edited text into the override store", async () => {
    const wrapper = await mountView();
    const host = mount(ToastHost);
    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");

    await wrapper.get('[data-test="prompt-editor"] textarea').setValue("新提示词正文");
    await wrapper.get('[data-test="prompt-save"]').trigger("click");
    await flushPromises();

    expect(loadPromptOverride(PROMPT_IDS.memoTitle)).toBe("新提示词正文");
    expect(toastTexts(host)).toContain("已保存");
    host.unmount();
  });

  it("warns about unsaved changes and clears the hint after saving", async () => {
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="prompt-dirty"]').exists()).toBe(false);
    await wrapper.get('[data-test="prompt-editor"] textarea').setValue("改了但没存");
    expect(wrapper.get('[data-test="prompt-dirty"]').exists()).toBe(true);

    await wrapper.get('[data-test="prompt-save"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="prompt-dirty"]').exists()).toBe(false);
  });

  it("reloads the module text when switching with unsaved edits (edits are dropped)", async () => {
    const wrapper = await mountView();
    await wrapper.get('[data-test="prompt-editor"] textarea').setValue("未保存的改动");

    await moduleItem(wrapper, PROMPT_IDS.evalReport).trigger("click");

    const value = (wrapper.get('[data-test="prompt-editor"] textarea').element as HTMLTextAreaElement).value;
    expect(value).toContain("阶段性评价报告");
    expect(value).not.toContain("未保存的改动");
  });

  it("inserts a variable placeholder at the caret", async () => {
    const wrapper = await mountView();
    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");
    const textarea = wrapper.get('[data-test="prompt-editor"] textarea');
    await textarea.setValue("前缀");

    await wrapper.get('[data-test="prompt-variable"]').trigger("click");

    const value = (textarea.element as HTMLTextAreaElement).value;
    expect(value).toContain("{标题字数上限}");
  });

  it("warns when a contract variable was removed but still saves (user's call)", async () => {
    const wrapper = await mountView();
    const host = mount(ToastHost);
    await moduleItem(wrapper, PROMPT_IDS.scoreSheet).trigger("click");

    // 删掉 {输出结构} 这个解析契约
    await wrapper.get('[data-test="prompt-editor"] textarea').setValue("随便判断一下");
    expect(wrapper.get('[data-test="prompt-contract-warning"]').text()).toContain("输出结构");

    await wrapper.get('[data-test="prompt-save"]').trigger("click");
    await flushPromises();
    expect(loadPromptOverride(PROMPT_IDS.scoreSheet)).toBe("随便判断一下");
    host.unmount();
  });

  it("previews the rendered prompt with variables substituted", async () => {
    const wrapper = await mountView();
    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");

    const preview = wrapper.get('[data-test="prompt-preview"]').text();
    // 契约变量的实际值已代入，不再显示花括号
    expect(preview).toContain("不超过 12 个字");
    expect(preview).not.toContain("{标题字数上限}");
  });
});

describe("PromptsView 恢复默认", () => {
  it("resets a single module after confirmation", async () => {
    mockConfirm.mockResolvedValue(true);
    savePromptOverride(PROMPT_IDS.memoTitle, "我的标题提示词");
    const wrapper = await mountView();
    const host = mount(ToastHost);
    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");

    await wrapper.get('[data-test="prompt-reset-one"]').trigger("click");
    await flushPromises();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(loadPromptOverride(PROMPT_IDS.memoTitle)).toBeUndefined();
    expect(toastTexts(host)).toContain("恢复");
    expect(moduleItem(wrapper, PROMPT_IDS.memoTitle).text()).not.toContain("已自定义");
    host.unmount();
  });

  it("keeps the override when the confirm is cancelled", async () => {
    mockConfirm.mockResolvedValue(false);
    savePromptOverride(PROMPT_IDS.memoTitle, "我的标题提示词");
    const wrapper = await mountView();
    await moduleItem(wrapper, PROMPT_IDS.memoTitle).trigger("click");

    await wrapper.get('[data-test="prompt-reset-one"]').trigger("click");
    await flushPromises();

    expect(loadPromptOverride(PROMPT_IDS.memoTitle)).toBe("我的标题提示词");
  });

  it("resets all modules at once and shows the empty state for the button", async () => {
    mockConfirm.mockResolvedValue(true);
    savePromptOverride(PROMPT_IDS.memoTitle, "A");
    savePromptOverride(PROMPT_IDS.termComment, "B");
    const wrapper = await mountView();
    const host = mount(ToastHost);

    await wrapper.get('[data-test="prompt-reset-all"]').trigger("click");
    await flushPromises();

    expect(loadPromptOverride(PROMPT_IDS.memoTitle)).toBeUndefined();
    expect(loadPromptOverride(PROMPT_IDS.termComment)).toBeUndefined();
    expect(wrapper.get('[data-test="prompt-custom-count"]').text()).toContain("0");
    host.unmount();
  });

  it("disables the reset-all button when nothing is customized", async () => {
    const wrapper = await mountView();

    expect(wrapper.get('[data-test="prompt-reset-all"]').attributes("disabled")).toBeDefined();
  });

  it("disables the per-module reset button when that module is not customized", async () => {
    const wrapper = await mountView();

    expect(wrapper.get('[data-test="prompt-reset-one"]').attributes("disabled")).toBeDefined();
  });
});
