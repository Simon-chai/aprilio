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
});
