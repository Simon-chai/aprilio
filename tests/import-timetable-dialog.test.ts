import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ImportTimetableDialog from "../src/components/ImportTimetableDialog.vue";
import { currentSemester } from "../src/lib/timetable";
import { profile } from "../src/lib/profile";
import { DEFAULT_PROFILE } from "../src/types";
import {
  clearTimetableSlots,
  findOrCreateTimetable,
  getTimetableWithSlots,
  saveTimetableMySubjects,
  saveTimetableSlot,
} from "../src/lib/db";

const CSV = [
  "节次,周一,周二,周三,周四,周五",
  "第1节,数学,语文,,英语,",
  "第2节,语文,数学,数学（带教具）,语文,班会",
].join("\n");

/** 用演示种子没有的第 4 节，避免与内置示例课表的撞课断言互相干扰 */
const CSV_P4 = ["节次,周一,周二,周三,周四,周五", "第4节,语文,,,,"].join("\n");

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

async function presetClass(name: string): Promise<number> {
  const { timetable } = await findOrCreateTimetable(name, currentSemester());
  return timetable.id;
}

function importButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll("button").find((b) => b.text().includes("开始导入"));
  expect(btn, "导入按钮应存在").toBeDefined();
  return btn!;
}

describe("ImportTimetableDialog", () => {
  it("keeps import disabled before a file is loaded", () => {
    const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
    expect(wrapper.text()).toContain("导入课表");
    expect(importButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("detects the layout, previews the grid and imports into the selected class", async () => {
    const className = "导入测试班";
    const id = await presetClass(className);
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV, "课表.csv");
      await wrapper.get('[data-test="import-class-select"]').setValue(className);
      await flushPromises();

      expect(wrapper.text()).toContain("已识别星期表头与节次列");
      expect(wrapper.text()).toContain("数学 · 备注「带教具」");
      expect(importButton(wrapper).attributes("disabled")).toBeUndefined();

      await importButton(wrapper).trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("导入完成：成功 8 格");
      expect(wrapper.emitted("imported")).toHaveLength(1);
      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.find((s) => s.day_of_week === 3 && s.period === 2)).toMatchObject({
        subject: "数学",
        note: "带教具",
      });
      // 第1节只有周一/周二/周四有内容；空格不落库
      expect(slots.filter((s) => s.period === 1)).toHaveLength(3);
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("clears existing slots first when the option is checked", async () => {
    const className = "导入清空班";
    const id = await presetClass(className);
    await saveTimetableSlot(id, 5, 7, "旧课");
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV, "课表.csv");
      await wrapper.get('[data-test="import-class-select"]').setValue(className);
      await wrapper.find('input[type="checkbox"]').setValue(true);
      await importButton(wrapper).trigger("click");
      await flushPromises();

      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.some((s) => s.subject === "旧课")).toBe(false);
      expect(slots.length).toBeGreaterThan(0);
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("extends the timetable period configuration when the file contains a ninth period", async () => {
    const className = "导入第九节班";
    const id = await presetClass(className);
    const csv = ["节次,周一,周二,周三,周四,周五", "第9节,语文,,,,"].join("\n");
    try {
      const wrapper = mount(ImportTimetableDialog, {
        props: { open: true, presetClass: className },
      });
      await (wrapper.vm as unknown as Loader).loadText(csv, "课表.csv");
      await importButton(wrapper).trigger("click");
      await flushPromises();

      const loaded = await getTimetableWithSlots(className, currentSemester());
      expect(loaded?.periods?.some((period) => period.period === 9)).toBe(true);
      expect(loaded?.slots).toContainEqual(expect.objectContaining({ period: 9, subject: "语文" }));
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("falls back to manual header selection for ambiguous sheets", async () => {
    const className = "导入手工班";
    const id = await presetClass(className);
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText("A,B,C\n第1节,数学,语文");
      await wrapper.get('[data-test="import-class-select"]').setValue(className);
      await flushPromises();

      expect(wrapper.text()).toContain("手动指定");
      // 默认已预选：星期表头=第1行(0)、节次列=第1列(0)；映射按顺序假设周一/周二
      await importButton(wrapper).trigger("click");
      await flushPromises();

      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.find((s) => s.day_of_week === 1 && s.period === 1)).toMatchObject({ subject: "数学" });
      expect(wrapper.emitted("imported")).toHaveLength(1);
    } finally {
      await clearTimetableSlots(id);
    }
  });
});

describe("ImportTimetableDialog 预览撞课清单", () => {
  afterEach(() => {
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("lists conflicts against other classes' my-subject slots and still imports", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const className = "撞课目标班";
    const id = await presetClass(className);
    const otherId = await presetClass("撞课邻班A");
    await saveTimetableSlot(otherId, 1, 4, "语文"); // 邻班周一第 4 节语文（我的科目）
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true, presetClass: className } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV_P4, "课表.csv");

      const warning = wrapper.get('[data-test="import-conflict-warning"]');
      expect(warning.text()).toContain("周一 第4节 语文");
      expect(warning.text()).toContain("撞课邻班A（语文）");
      // 软警告：仍可导入
      await importButton(wrapper).trigger("click");
      await flushPromises();
      expect(wrapper.emitted("imported")).toHaveLength(1);
    } finally {
      await clearTimetableSlots(id);
      await clearTimetableSlots(otherId);
    }
  });

  it("skips non-my subjects (P.E.) even at the same slot", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const className = "撞课体育班";
    const id = await presetClass(className);
    const otherId = await presetClass("撞课体育邻班");
    await saveTimetableSlot(otherId, 1, 4, "体育");
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true, presetClass: className } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(
        ["节次,周一", "第4节,体育"].join("\n"),
        "课表.csv"
      );
      expect(wrapper.find('[data-test="import-conflict-warning"]').exists()).toBe(false);
    } finally {
      await clearTimetableSlots(id);
      await clearTimetableSlots(otherId);
    }
  });

  it("excludes the target class's own existing slots", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const className = "撞课自排班";
    const id = await presetClass(className);
    await saveTimetableSlot(id, 1, 4, "语文"); // 目标班自己已有的旧格子
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true, presetClass: className } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV_P4, "课表.csv");
      expect(wrapper.find('[data-test="import-conflict-warning"]').exists()).toBe(false);
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("skips when the target class is marked as having none of my subjects", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const className = "撞课标记班";
    const id = await presetClass(className);
    await saveTimetableMySubjects(id, []); // 明确标记「本班没有我的课」
    const otherId = await presetClass("撞课标记邻班");
    await saveTimetableSlot(otherId, 1, 4, "语文");
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true, presetClass: className } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV_P4, "课表.csv");
      expect(wrapper.find('[data-test="import-conflict-warning"]').exists()).toBe(false);
    } finally {
      await clearTimetableSlots(id);
      await clearTimetableSlots(otherId);
    }
  });

  it("skips when no teaching subjects are registered and no marks exist", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const className = "撞课未登记班";
    const id = await presetClass(className);
    const otherId = await presetClass("撞课未登记邻班");
    await saveTimetableSlot(otherId, 1, 4, "语文");
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true, presetClass: className } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV_P4, "课表.csv");
      expect(wrapper.find('[data-test="import-conflict-warning"]').exists()).toBe(false);
    } finally {
      await clearTimetableSlots(id);
      await clearTimetableSlots(otherId);
    }
  });
});
