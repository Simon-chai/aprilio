import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import StudentTable from "../src/components/StudentTable.vue";
import type { StudentRow } from "../src/types";

const makeRow = (over: Partial<StudentRow> = {}): StudentRow => ({
  id: 3,
  name: "陈嘉树",
  gender: "男",
  birth_date: null,
  student_no: "20230003",
  grade_class: "四年级一班",
  id_card: null,
  address: null,
  status: "active",
  note: null,
  guardians: [],
  created_at: "2026-09-01 08:00:00",
  updated_at: "2026-09-01 08:00:00",
  photo_count: 2,
  ...over,
});

beforeEach(() => {
  // 快捷卡片 Teleport 到 body，测试间清理残留
  document.body.innerHTML = "";
});

describe("StudentTable.vue quick record integration", () => {
  it("renders the + 记表现 trigger in the action column", () => {
    const w = mount(StudentTable, { props: { rows: [makeRow()] } });
    expect(w.get("[data-test='quick-record-btn']").text()).toBe("+ 记表现");
    expect(w.get("[data-test='view-btn']").text()).toBe("查看");
    w.unmount();
  });

  it("opens the quick card without emitting open (no row navigation)", async () => {
    const w = mount(StudentTable, { props: { rows: [makeRow()] } });

    await w.get("[data-test='quick-record-btn']").trigger("click");
    await flushPromises();

    expect(w.emitted("open")).toBeUndefined();
    const card = document.body.querySelector("[data-test='quick-card']");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("陈嘉树");
    w.unmount();
  });

  it("emits open when clicking 查看", async () => {
    const w = mount(StudentTable, { props: { rows: [makeRow()] } });
    await w.get("[data-test='view-btn']").trigger("click");
    expect(w.emitted("open")?.length).toBe(1);
    w.unmount();
  });

  it("shows a toast after saving a quick record", async () => {
    const w = mount(StudentTable, { props: { rows: [makeRow()] } });

    await w.get("[data-test='quick-record-btn']").trigger("click");
    await flushPromises();

    const ta = document.body.querySelector<HTMLTextAreaElement>("[data-test='comment-input']");
    expect(ta).not.toBeNull();
    ta!.value = "作业书写工整，按时提交";
    ta!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();

    document.body.querySelector<HTMLElement>("[data-test='save-btn']")!.click();
    await flushPromises();

    // Toast 在 StudentTable 自身模板里（非 Teleport），从 wrapper 内查
    const toast = w.find("[data-test='quick-toast']");
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("已记录 陈嘉树 作业情况");
    w.unmount();
  });
});
