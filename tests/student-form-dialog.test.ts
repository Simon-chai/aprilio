import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";

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

    // 标签 chip 使用 bg-primary-soft 样式，可按 class 计数
    expect(row.findAll(".bg-primary-soft").length).toBe(2);
    expect(row.text()).toContain("温和");
    expect(row.text()).toContain("善于沟通");

    // 点击 chip 上的 × 可移除
    await row.get(".bg-primary-soft button").trigger("click");
    expect(row.findAll(".bg-primary-soft").length).toBe(1);
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
