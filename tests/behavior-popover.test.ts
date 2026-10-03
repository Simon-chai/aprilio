import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import QuickBehaviorPopover from "../src/components/QuickBehaviorPopover.vue";
import { addBehaviorRecord, listBehaviorDimensions, listBehaviorRecords } from "../src/lib/db";
import { localDateStr } from "../src/lib/format";
import type { StudentRow } from "../src/types";

const makeStudent = (over: Partial<StudentRow> = {}): StudentRow => ({
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
  photo_count: 0,
  ...over,
});

const mountCard = (props: Record<string, unknown> = {}) =>
  mount(QuickBehaviorPopover, {
    props: { open: true, student: makeStudent(), anchor: { x: 200, y: 200 }, ...props },
    global: { stubs: { teleport: true } },
  });

describe("QuickBehaviorPopover.vue", () => {
  it("renders seeded dimension chips with praise active by default", async () => {
    const w = mountCard();
    await flushPromises();

    const chips = w.findAll("[data-test='dimension-chip']");
    expect(chips.map((c) => c.text())).toEqual([
      "作业情况",
      "单元/期中期末成绩",
      "课堂表现",
      "劳动情况",
    ]);
    expect(w.get("[data-test='polarity-praise']").classes()).toContain("bg-praise-soft");
    w.unmount();
  });

  it("refreshes preset bubbles when polarity switches", async () => {
    const w = mountCard();
    await flushPromises();

    // 默认作业情况 + 表扬
    let texts = w.findAll("[data-test='preset-bubble']").map((b) => b.text()).join();
    expect(texts).toContain("书写工整规范");

    await w.get("[data-test='polarity-improve']").trigger("click");
    await flushPromises();
    texts = w.findAll("[data-test='preset-bubble']").map((b) => b.text()).join();
    expect(texts).toContain("作业未按时提交");
    expect(texts).not.toContain("书写工整规范");
    w.unmount();
  });

  it("supports the neutral polarity with its own seeded presets", async () => {
    const w = mountCard();
    await flushPromises();

    expect(w.findAll("[data-test='polarity-praise'], [data-test='polarity-neutral'], [data-test='polarity-improve']").length).toBe(3);

    await w.get("[data-test='polarity-neutral']").trigger("click");
    await flushPromises();
    expect(w.get("[data-test='polarity-neutral']").classes()).toContain("bg-neutral-soft");
    const texts = w.findAll("[data-test='preset-bubble']").map((b) => b.text()).join();
    expect(texts).toContain("作业按时完成，整体表现平稳");

    // 中立评语也能正常保存
    await w.get("[data-test='comment-input']").setValue("今日表现如常");
    await w.get("[data-test='save-btn']").trigger("click");
    await flushPromises();
    expect(w.emitted("saved")?.length).toBe(1);
    w.unmount();
  });

  it("fills the textarea when clicking a preset bubble", async () => {
    const w = mountCard();
    await flushPromises();

    await w.findAll("[data-test='preset-bubble']")[0].trigger("click");
    const value = (w.get("[data-test='comment-input']").element as HTMLTextAreaElement).value;
    expect(value).not.toBe("");
    w.unmount();
  });

  it("blocks empty submit with a shake hint, then saves on Enter", async () => {
    const w = mountCard();
    await flushPromises();

    await w.get("[data-test='save-btn']").trigger("click");
    expect(w.find("[data-test='empty-hint']").exists()).toBe(true);
    expect(w.emitted("saved")).toBeUndefined();

    const ta = w.get("[data-test='comment-input']");
    await ta.setValue("课堂听讲专注，主动帮同学讲解错题");
    await ta.trigger("keydown.enter");
    await flushPromises();

    expect(w.emitted("saved")?.length).toBe(1);
    expect(w.emitted("close")?.length).toBe(1);
    w.unmount();
  });

  it("keeps the card open and clears input for save-and-next", async () => {
    const w = mountCard();
    await flushPromises();

    const ta = w.get("[data-test='comment-input']");
    await ta.setValue("值日认真负责");
    await w.get("[data-test='save-next-btn']").trigger("click");
    await flushPromises();

    expect(w.emitted("saved")?.length).toBe(1);
    expect(w.emitted("close")).toBeUndefined();
    expect((w.get("[data-test='comment-input']").element as HTMLTextAreaElement).value).toBe("");
    w.unmount();
  });

  it("adds a custom dimension and selects it", async () => {
    const w = mountCard();
    await flushPromises();

    await w.get("[data-test='add-dimension-btn']").trigger("click");
    await w.get("[data-test='custom-dimension-input']").setValue("体育健康");
    await w.get("[data-test='custom-dimension-confirm']").trigger("click");
    await flushPromises();

    const chips = w.findAll("[data-test='dimension-chip']");
    const active = chips.find((c) => c.text() === "体育健康");
    expect(active).toBeTruthy();
    expect(active?.classes()).toContain("bg-tile");
    w.unmount();
  });

  it("switches the target student before saving when a class student list is provided", async () => {
    const first = makeStudent({ id: 3, name: "陈嘉树" });
    const second = makeStudent({ id: 4, name: "苏晚" });
    const w = mountCard({ student: first, students: [first, second] });
    await flushPromises();

    const studentSelect = w.find("select");
    expect(studentSelect.exists()).toBe(true);
    await studentSelect.setValue("4");
    await w.get("[data-test='comment-input']").setValue("切换学生后记录表现");
    await w.get("[data-test='save-btn']").trigger("click");
    await flushPromises();

    expect(w.emitted("saved")?.[0]?.[0]).toMatchObject({ studentName: "苏晚" });
    w.unmount();
  });

  it("locks the date picker to the last two weeks ending today", async () => {
    const w = mountCard();
    await flushPromises();

    const input = w.get("[data-test='record-date']").element as HTMLInputElement;
    expect(input.max).toBe(localDateStr());
    const min = new Date();
    min.setDate(min.getDate() - 14);
    expect(input.min).toBe(localDateStr(min));
    w.unmount();
  });

  it("rejects future dates at save time", async () => {
    const w = mountCard();
    await flushPromises();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await w.get("[data-test='record-date']").setValue(localDateStr(tomorrow));
    await w.get("[data-test='comment-input']").setValue("课后主动留下订正作业");
    await w.get("[data-test='save-btn']").trigger("click");
    await flushPromises();

    expect(w.find("[data-test='save-error']").text()).toContain("未来");
    expect(w.emitted("saved")).toBeUndefined();
    w.unmount();
  });
});

describe("QuickBehaviorPopover.vue edit mode (editing 传入即编辑)", () => {
  async function makeRecord(over: { code: string; type: "praise" | "improve" | "neutral"; comment: string; recorded_date: string }) {
    const dim = (await listBehaviorDimensions()).find((d) => d.code === over.code)!;
    const recordId = await addBehaviorRecord({
      student_id: 3,
      dimension_id: dim.id,
      dimension_name_snap: dim.name,
      category_snap: dim.category,
      type: over.type,
      comment: over.comment,
      recorded_date: over.recorded_date,
    });
    return (await listBehaviorRecords(3)).find((r) => r.id === recordId)!;
  }

  const mountEdit = (editing: unknown) =>
    mount(QuickBehaviorPopover, {
      props: { open: true, student: makeStudent(), editing, anchor: { x: 200, y: 200 } },
      global: { stubs: { teleport: true } },
    });

  it("prefills from the record, hides save-and-next, and saves via updateBehaviorRecord", async () => {
    const record = await makeRecord({
      code: "classroom",
      type: "improve",
      comment: "编辑前原始评语",
      recorded_date: localDateStr(),
    });
    const w = mountEdit(record);
    await flushPromises();

    // 编辑态标题 + 原值预填（维度 / 倾向 / 评语 / 日期）
    expect(w.find("[data-test='edit-mode-title']").exists()).toBe(true);
    expect((w.get("[data-test='comment-input']").element as HTMLTextAreaElement).value).toBe("编辑前原始评语");
    expect(w.get("[data-test='polarity-improve']").classes()).toContain("bg-danger-soft");
    expect(w.find("[data-test='save-next-btn']").exists()).toBe(false);

    // 只改评语保存 → 落库为更新
    await w.get("[data-test='comment-input']").setValue("编辑后修改评语");
    await w.get("[data-test='save-btn']").trigger("click");
    await flushPromises();

    expect(w.emitted("saved")?.[0]?.[0]).toMatchObject({ mode: "edit", dimensionName: "课堂表现" });
    const after = (await listBehaviorRecords(3)).find((r) => r.id === record.id);
    expect(after?.comment).toBe("编辑后修改评语");
    w.unmount();
  });

  it("allows saving with a date older than the two-week capture window", async () => {
    const old = new Date();
    old.setDate(old.getDate() - 20);
    const record = await makeRecord({
      code: "labor",
      type: "praise",
      comment: "二十天前的表现记录",
      recorded_date: localDateStr(old),
    });
    const w = mountEdit(record);
    await flushPromises();

    // 编辑模式放开「最近两周」下限：min 属性不渲染，老日期可直接保存
    expect((w.get("[data-test='record-date']").element as HTMLInputElement).min).toBe("");

    await w.get("[data-test='save-btn']").trigger("click");
    await flushPromises();

    expect(w.find("[data-test='save-error']").exists()).toBe(false);
    expect(w.emitted("saved")?.length).toBe(1);
    w.unmount();
  });
});
