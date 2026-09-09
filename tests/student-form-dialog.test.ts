import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import { GUARDIAN_TAG_POLARITY_KEY, GUARDIAN_TAG_PRESETS_KEY } from "../src/lib/guardian-tags";

beforeEach(() => {
  localStorage.clear();
});

describe("StudentFormDialog.vue", () => {
  it("renders gender segmented control with 男 and 女 options, defaulting to 男", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const genderBtns = wrapper.findAll("[data-test='gender-option']");
    expect(genderBtns.length).toBe(2);
    expect(genderBtns[0].text()).toBe("男");
    expect(genderBtns[1].text()).toBe("女");
    expect(genderBtns[0].classes()).toContain("bg-ink"); // selected
  });

  it("switches gender when clicking 女", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const genderBtns = wrapper.findAll("[data-test='gender-option']");
    await genderBtns[1].trigger("click");
    expect(genderBtns[1].classes()).toContain("bg-ink");
  });

  it("allows adding and removing guardians dynamically", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    // Initial has 1 guardian row
    let rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // Click add guardian
    const addBtn = wrapper.get("[data-test='add-guardian-btn']");
    await addBtn.trigger("click");

    rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBe(2);

    // Click remove on second guardian
    const removeBtns = wrapper.findAll("[data-test='remove-guardian-btn']");
    await removeBtns[1].trigger("click");

    rows = wrapper.findAll("[data-test='guardian-row']");
    expect(rows.length).toBe(1);
  });

  it("renders 身份证号 field instead of 入学日期", () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });
    expect(wrapper.text()).not.toContain("入学日期");
    expect(wrapper.text()).toContain("身份证号");
    expect(wrapper.find("[data-test='id-card-input']").exists()).toBe(true);
  });

  it("rejects invalid id card number on submit", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const inputs = wrapper.findAll("input");
    // 表单前两个字段依次为姓名、学号
    await inputs[0].setValue("身份证测试生");
    await inputs[1].setValue("IDCARD_001");
    await wrapper.get("[data-test='id-card-input'] input").setValue("12345");

    await wrapper.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    expect(wrapper.text()).toContain("身份证号格式不正确");
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it("adds guardian occupation and style tags via presets and custom input", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const row = wrapper.get("[data-test='guardian-row']");
    await row.get("[data-test='guardian-occupation'] input").setValue("工程师");

    // 点击候选标签「温和」
    await row.findAll("button").find((b) => b.text() === "+ 温和")!.trigger("click");
    // 自定义输入标签后回车
    const tagInput = row.get("[data-test='guardian-tag-input']");
    await tagInput.setValue("善于沟通");
    await tagInput.trigger("keydown", { key: "Enter" });

    // 已选标签胶囊可按 data-test 计数
    expect(row.findAll("[data-test='guardian-tag-chip']").length).toBe(2);
    expect(row.text()).toContain("温和");
    expect(row.text()).toContain("善于沟通");

    // 点击 chip 上的 × 可移除
    await row.get("[data-test='guardian-tag-chip'] button").trigger("click");
    expect(row.findAll("[data-test='guardian-tag-chip']").length).toBe(1);
  });

  it("keeps tag chips blank (no polarity fill) when AI is not configured", async () => {
    // jsdom 无 Tauri 外壳 → AI 未就绪，胶囊不上倾向色
    const wrapper = mount(StudentFormDialog, { props: { open: true } });
    const row = wrapper.get("[data-test='guardian-row']");

    await row.findAll("button").find((b) => b.text() === "+ 温和")!.trigger("click");

    const chip = row.get("[data-test='guardian-tag-chip']");
    expect(chip.classes()).toContain("bg-parchment"); // 留白中性底
    expect(chip.classes()).not.toContain("bg-tag-positive-soft");

    // 未判倾向的预设候选保持描边样式
    const preset = row.findAll("[data-test='guardian-tag-preset']")[0];
    expect(preset.classes()).toContain("border-hairline");
  });

  it("applies polarity fill colors from cached AI results", async () => {
    localStorage.setItem(
      GUARDIAN_TAG_POLARITY_KEY,
      JSON.stringify({ 温和: "positive", 严格: "negative", 积极配合: "neutral" })
    );
    const wrapper = mount(StudentFormDialog, { props: { open: true } });
    const row = wrapper.get("[data-test='guardian-row']");

    await row.findAll("button").find((b) => b.text() === "+ 温和")!.trigger("click");
    await row.findAll("button").find((b) => b.text() === "+ 严格")!.trigger("click");

    const chips = row.findAll("[data-test='guardian-tag-chip']");
    expect(chips[0].classes()).toContain("bg-tag-positive-soft");
    expect(chips[0].classes()).toContain("text-tag-positive");
    expect(chips[1].classes()).toContain("bg-tag-negative-soft");
    expect(chips[1].classes()).toContain("text-tag-negative");

    // 候选预设胶囊同样按倾向上色
    const candidate = row
      .findAll("[data-test='guardian-tag-preset']")
      .find((p) => p.text().includes("积极配合"))!;
    expect(candidate.classes()).toContain("bg-parchment"); // neutral → 中性底
  });

  it("saves a custom preset from the draft input and persists it across remounts", async () => {
    const wrapper = mount(StudentFormDialog, { props: { open: true } });
    const row = wrapper.get("[data-test='guardian-row']");

    const tagInput = row.get("[data-test='guardian-tag-input']");
    await tagInput.setValue("暴脾气");
    await row.get("[data-test='save-preset-btn']").trigger("click");

    // 候选区出现新预设，草稿清空；未自动加到已选
    expect(row.text()).toContain("+ 暴脾气");
    expect(row.findAll("[data-test='guardian-tag-chip']").length).toBe(0);
    expect(tagInput.element.value).toBe("");

    // 重挂载后预设仍在（localStorage 持久化）
    wrapper.unmount();
    const again = mount(StudentFormDialog, { props: { open: true } });
    expect(again.get("[data-test='guardian-row']").text()).toContain("+ 暴脾气");
  });

  it("deletes a preset candidate and persists the removal across remounts", async () => {
    const wrapper = mount(StudentFormDialog, { props: { open: true } });
    const row = wrapper.get("[data-test='guardian-row']");
    expect(row.text()).toContain("+ 温和");

    // 删除预设「温和」
    await row
      .findAll("[data-test='guardian-tag-preset']")
      .find((p) => p.text().includes("温和"))!
      .get("[data-test='remove-preset-btn']")
      .trigger("click");
    expect(row.text()).not.toContain("+ 温和");

    wrapper.unmount();
    const again = mount(StudentFormDialog, { props: { open: true } });
    const againRow = again.get("[data-test='guardian-row']");
    expect(againRow.text()).not.toContain("+ 温和");
    // 其余预设不受影响
    expect(againRow.text()).toContain("+ 严格");
  });

  it("keeps a selected tag when its preset candidate is deleted", async () => {
    const wrapper = mount(StudentFormDialog, { props: { open: true } });
    // 先选中「温和」（候选随之隐藏），再加第二行监护人让候选重新可见
    const row = wrapper.get("[data-test='guardian-row']");
    await row.findAll("button").find((b) => b.text() === "+ 温和")!.trigger("click");
    await wrapper.get("[data-test='add-guardian-btn']").trigger("click");

    const rows = wrapper.findAll("[data-test='guardian-row']");
    await rows[1]
      .findAll("[data-test='guardian-tag-preset']")
      .find((p) => p.text().includes("温和"))!
      .get("[data-test='remove-preset-btn']")
      .trigger("click");

    // 候选没了，但第一行已选标签保留
    expect(wrapper.text()).not.toContain("+ 温和");
    expect(rows[0].findAll("[data-test='guardian-tag-chip']").length).toBe(1);
    expect(rows[0].text()).toContain("温和");
  });

  it("emits guardian occupation and tags in submit payload", async () => {
    const wrapper = mount(StudentFormDialog, {
      props: { open: true },
    });

    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("标签测试生");
    await inputs[1].setValue("TAG_001");

    const row = wrapper.get("[data-test='guardian-row']");
    await row.get("[data-test='guardian-name'] input").setValue("测试监护人");
    await row.get("[data-test='guardian-phone'] input").setValue("13800000888");
    await row.get("[data-test='guardian-occupation'] input").setValue("医生");
    await row.findAll("button").find((b) => b.text() === "+ 严格")!.trigger("click");

    await wrapper.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    const payload = wrapper.emitted("submit")![0][0] as { guardians: { name: string; occupation: string; tags: string[] }[] };
    expect(payload.guardians[0].name).toBe("测试监护人");
    expect(payload.guardians[0].occupation).toBe("医生");
    expect(payload.guardians[0].tags).toEqual(["严格"]);
  });
});
