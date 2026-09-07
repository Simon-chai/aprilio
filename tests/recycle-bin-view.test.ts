import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DOMWrapper } from "@vue/test-utils";
import RecycleBinView from "../src/views/RecycleBinView.vue";
import { createStudent, deleteStudent, listRecycleItems, listStudents, restoreRecycleItem } from "../src/lib/db";
import type { RecycleItem, StudentInput } from "../src/types";
import type { VueWrapper } from "@vue/test-utils";

function buildInput(overrides: Partial<StudentInput> = {}): StudentInput {
  return {
    name: "视图测试生",
    gender: "女",
    birth_date: "2017-03-01",
    student_no: `RB_${Math.random().toString(36).slice(2, 10)}`,
    grade_class: "视图测试班",
    id_card: null,
    address: null,
    status: "active",
    note: null,
    guardians: [],
    ...overrides,
  };
}

/** 按名称定位回收站条目卡片（内存库跨用例共享，避免残留条目干扰断言） */
function findItemCard(wrapper: VueWrapper, label: string): DOMWrapper<Element> | undefined {
  return wrapper.findAll("[data-test='recycle-item']").find((n) => n.text().includes(label));
}

describe("RecycleBinView.vue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders deleted items with type badge, summary and remaining days", async () => {
    const id = await createStudent(buildInput({ name: "视图删除生", student_no: "RB_VIEW_001" }));
    await deleteStudent(id);

    const wrapper = mount(RecycleBinView);
    await flushPromises();

    const card = findItemCard(wrapper, "视图删除生");
    expect(card).toBeDefined();
    expect(card!.text()).toContain("学生");
    expect(card!.text()).toContain("视图测试班");
    expect(card!.get("[data-test='remaining-days']").text()).toMatch(/剩 \d+ 天/);
  });

  it("restore button returns the item out of the bin", async () => {
    const id = await createStudent(buildInput({ name: "视图恢复生", student_no: "RB_VIEW_002" }));
    await deleteStudent(id);

    const wrapper = mount(RecycleBinView);
    await flushPromises();
    const card = findItemCard(wrapper, "视图恢复生");
    expect(card).toBeDefined();

    await card!.get("[data-test='restore-btn']").trigger("click");
    await flushPromises();

    expect(findItemCard(wrapper, "视图恢复生")).toBeUndefined();
    // 学生确实回到了档案库
    expect((await listStudents("RB_VIEW_002")).length).toBe(1);
  });

  it("purge button permanently removes the item after confirm", async () => {
    vi.stubGlobal("confirm", () => true);
    const id = await createStudent(buildInput({ name: "视图清除生", student_no: "RB_VIEW_003" }));
    await deleteStudent(id);

    const wrapper = mount(RecycleBinView);
    await flushPromises();
    const card = findItemCard(wrapper, "视图清除生");
    expect(card).toBeDefined();

    await card!.get("[data-test='purge-btn']").trigger("click");
    await flushPromises();

    expect(findItemCard(wrapper, "视图清除生")).toBeUndefined();
    const items = await listRecycleItems();
    expect(items.find((i: RecycleItem) => i.label === "视图清除生")).toBeUndefined();
  });

  it("purge keeps the item when the user cancels the confirm dialog", async () => {
    vi.stubGlobal("confirm", () => false);
    const id = await createStudent(buildInput({ name: "视图取消生", student_no: "RB_VIEW_004" }));
    await deleteStudent(id);

    const wrapper = mount(RecycleBinView);
    await flushPromises();
    const card = findItemCard(wrapper, "视图取消生");
    expect(card).toBeDefined();

    await card!.get("[data-test='purge-btn']").trigger("click");
    await flushPromises();

    expect(findItemCard(wrapper, "视图取消生")).toBeDefined();
  });

  it("shows empty state when bin has no items", async () => {
    const items = await listRecycleItems();
    for (const item of items) await restoreRecycleItem(item.id);

    const wrapper = mount(RecycleBinView);
    await flushPromises();

    expect(wrapper.findAll("[data-test='recycle-item']").length).toBe(0);
    expect(wrapper.text()).toContain("回收站是空的");
  });
});
