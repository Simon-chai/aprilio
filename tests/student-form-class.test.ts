import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import StudentFormDialog from "../src/components/StudentFormDialog.vue";
import {
  archiveClass,
  createClass,
  createStudent,
  deleteStudent,
  listClasses,
  restoreClass,
  updateStudent,
} from "../src/lib/db";
import type { StudentInput } from "../src/types";

beforeEach(() => {
  localStorage.clear();
});

function inputOf(overrides: Partial<StudentInput> = {}): StudentInput {
  return {
    name: "班级栏测试生",
    gender: "男",
    birth_date: "2017-01-01",
    student_no: "CLS_FORM_001",
    grade_class: "",
    id_card: null,
    address: null,
    status: "active",
    note: null,
    guardians: [],
    ...overrides,
  };
}

async function mountDialog(initial: Partial<StudentInput> | null = null) {
  const wrapper = mount(StudentFormDialog, { props: { open: true, initial } });
  await flushPromises();
  return wrapper;
}

describe("StudentFormDialog 班级栏：关联已有班级 or 手动输入新建", () => {
  it("聚焦时列出已有班级，点选即关联且不再提示新建", async () => {
    await createClass("三年级二班");
    const wrapper = await mountDialog();

    await wrapper.get("[data-test='class-input']").trigger("focus");
    const options = wrapper.findAll("[data-test='class-option']");
    const labels = options.map((o) => o.text());
    expect(labels).toContain("三年级二班");
    expect(labels).not.toContain("未分班");

    await options.find((o) => o.text() === "三年级二班")!.trigger("click");

    expect((wrapper.get("[data-test='class-input']").element as HTMLInputElement).value).toBe("三年级二班");
    expect(wrapper.find("[data-test='class-options']").exists()).toBe(false);
    expect(wrapper.find("[data-test='class-new-hint']").exists()).toBe(false);
  });

  it("按输入片段过滤候选，只保留命中的班级", async () => {
    await createClass("四年级一班");
    await createClass("四年级二班");
    await createClass("五年级一班");
    const wrapper = await mountDialog();

    await wrapper.get("[data-test='class-input']").setValue("四");
    const labels = wrapper.findAll("[data-test='class-option']").map((o) => o.text());
    expect(labels).toContain("四年级一班");
    expect(labels).toContain("四年级二班");
    expect(labels.every((l) => l.includes("四"))).toBe(true);
  });

  it("手动输入不存在的班级名 → 提示将新建班级；输入已有班级则不提示", async () => {
    await createClass("三年级二班");
    const wrapper = await mountDialog();

    const input = wrapper.get("[data-test='class-input']");
    await input.setValue("五年级九班");
    expect(wrapper.get("[data-test='class-new-hint']").text()).toContain("五年级九班");

    await input.setValue("三年级二班");
    expect(wrapper.find("[data-test='class-new-hint']").exists()).toBe(false);
  });

  it("Esc 收起候选，提交时仍带出手动输入的班级名", async () => {
    await createClass("三年级二班");
    const wrapper = await mountDialog();

    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("新班级学生");
    await inputs[1].setValue("CLS_FORM_002");
    const input = wrapper.get("[data-test='class-input']");
    await input.setValue("五年级九班");
    await input.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[data-test='class-options']").exists()).toBe(false);

    await wrapper.findAll("button").find((b) => b.text() === "保存")!.trigger("click");
    const payload = wrapper.emitted("submit")![0][0] as StudentInput;
    expect(payload.grade_class).toBe("五年级九班");
  });

  it("已归档班级与虚拟「未分班」不进候选", async () => {
    await createClass("归档中的班");
    await archiveClass("归档中的班");
    // 制造一个无班级学生，让 listClasses 产出「未分班」虚拟分组
    const unassignedId = await createStudent(inputOf({ student_no: "CLS_FORM_UNASSIGNED" }));

    try {
      const wrapper = await mountDialog();
      await wrapper.get("[data-test='class-input']").trigger("focus");
      const labels = wrapper.findAll("[data-test='class-option']").map((o) => o.text());
      expect(labels).not.toContain("归档中的班");
      expect(labels).not.toContain("未分班");
    } finally {
      await deleteStudent(unassignedId);
      await restoreClass("归档中的班");
    }
  });
});

describe("学生落库：手动输入的新班级默认建档", () => {
  it("createStudent 带新班级名 → classes 中自动出现该班级", async () => {
    const className = "自动建档班A";
    const id = await createStudent(inputOf({ grade_class: className, student_no: "CLS_DB_001" }));

    try {
      const summaries = await listClasses();
      expect(summaries.some((c) => c.name === className)).toBe(true);
    } finally {
      await deleteStudent(id);
    }
  });

  it("updateStudent 换到新班级 → 新班级自动建档；清空班级不产生空班级", async () => {
    const id = await createStudent(inputOf({ grade_class: "原有班级X", student_no: "CLS_DB_002" }));

    try {
      await updateStudent(id, inputOf({ grade_class: "自动建档班B", student_no: "CLS_DB_002" }));
      let summaries = await listClasses();
      expect(summaries.some((c) => c.name === "自动建档班B")).toBe(true);

      await updateStudent(id, inputOf({ grade_class: "", student_no: "CLS_DB_002" }));
      summaries = await listClasses();
      expect(summaries.filter((c) => !c.name.trim()).length).toBe(0);
    } finally {
      await deleteStudent(id);
    }
  });
});
