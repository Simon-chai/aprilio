import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import QuickBehaviorPopover from "../src/components/QuickBehaviorPopover.vue";
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
    expect(w.get("[data-test='polarity-praise']").classes()).toContain("bg-[#e8f5e9]");
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
    expect(w.get("[data-test='polarity-neutral']").classes()).toContain("bg-[#e8e8ed]");
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
