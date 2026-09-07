import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ClassBehaviorTimeline from "../src/components/ClassBehaviorTimeline.vue";
import type { ClassBehaviorRecord, StudentRow } from "../src/types";

describe("ClassBehaviorTimeline.vue", () => {
  const mockRecords: ClassBehaviorRecord[] = [
    {
      id: 1,
      student_id: 101,
      student_name: "林知远",
      student_no: "202401",
      dimension_id: 1,
      dimension_name_snap: "作业情况",
      category_snap: "study",
      type: "praise",
      comment: "作业规范工整",
      recorded_date: "2026-09-05",
      created_at: "2026-09-05 10:00:00",
    },
    {
      id: 2,
      student_id: 102,
      student_name: "苏晚",
      student_no: "202402",
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "improve",
      comment: "课堂注意力需更集中",
      recorded_date: "2026-09-05",
      created_at: "2026-09-05 11:00:00",
    },
    {
      id: 3,
      student_id: 101,
      student_name: "林知远",
      student_no: "202401",
      dimension_id: 4,
      dimension_name_snap: "劳动情况",
      category_snap: "behavior",
      type: "neutral",
      comment: "按时完成值日",
      recorded_date: "2026-09-04",
      created_at: "2026-09-04 15:30:00",
    },
  ];

  it("renders category capsules with counts and switches category filter", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    expect(wrapper.text()).toContain("全部 (3)");
    expect(wrapper.text()).toContain("学习表现 (1)");
    expect(wrapper.text()).toContain("行为习惯 (2)");

    // 点击学习表现胶囊
    const studyPill = wrapper.findAll("button").find((b) => b.text().includes("学习表现"));
    expect(studyPill).toBeDefined();
    await studyPill!.trigger("click");

    const items = wrapper.findAll("[data-test='timeline-item']");
    expect(items.length).toBe(1);
    expect(items[0].text()).toContain("林知远");
    expect(items[0].text()).toContain("作业规范工整");
    expect(items[0].text()).not.toContain("苏晚");
    expect(items[0].text()).not.toContain("按时完成值日");
  });

  it("filters by polarity and dimension", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    // 过滤待改进
    const improveBtn = wrapper.find("[data-test='filter-improve']");
    expect(improveBtn.exists()).toBe(true);
    await improveBtn.trigger("click");

    const improveItems = wrapper.findAll("[data-test='timeline-item']");
    expect(improveItems.length).toBe(1);
    expect(improveItems[0].text()).toContain("苏晚");
    expect(improveItems[0].text()).not.toContain("作业规范工整");

    // 重置为全部
    const allBtn = wrapper.find("[data-test='filter-all-polarity']");
    await allBtn.trigger("click");
    const allItems = wrapper.findAll("[data-test='timeline-item']");
    expect(allItems.length).toBe(3);
  });

  it("filters by student dropdown", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    const studentSelect = wrapper.find("[data-test='student-select']");
    expect(studentSelect.exists()).toBe(true);

    // 切换选择 苏晚 (id 102)
    await studentSelect.setValue("102");
    const suwanItems = wrapper.findAll("[data-test='timeline-item']");
    expect(suwanItems.length).toBe(1);
    expect(suwanItems[0].text()).toContain("苏晚");
    expect(suwanItems[0].text()).not.toContain("作业规范工整");
    expect(suwanItems[0].text()).not.toContain("按时完成值日");
  });

  it("emits selectStudent when clicking student name badge", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    const studentBadge = wrapper.findAll("[data-test='student-badge']").find((el) => el.text().includes("林知远"));
    expect(studentBadge).toBeDefined();
    await studentBadge!.trigger("click");

    expect(wrapper.emitted("selectStudent")).toBeTruthy();
    expect(wrapper.emitted("selectStudent")?.[0]).toEqual([101]);
  });

  it("renders comment inside hover tooltip instead of inline text", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    const items = wrapper.findAll("[data-test='timeline-item']");
    expect(items.length).toBe(3);

    // 每个条目有评语语义图标，具体评语收进悬浮说明
    // （组内按 id 倒序，items[0] 为苏晚的课堂表现记录）
    const commentBtn = items[0].find("button[aria-label='查看评语']");
    expect(commentBtn.exists()).toBe(true);
    const tooltip = items[0].find("span[role='tooltip']");
    expect(tooltip.exists()).toBe(true);
    expect(tooltip.text()).toContain("课堂注意力需更集中");
    expect(items[1].find("span[role='tooltip']").text()).toContain("作业规范工整");
    // 默认隐藏，悬浮/聚焦时显示
    expect(tooltip.classes()).toContain("opacity-0");
  });

  it("emits remove after two-step confirm inside comment tooltip", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    // 组内按 id 倒序，items[0] 为 id 2
    const items = wrapper.findAll("[data-test='timeline-item']");
    const delBtn = () => items[0].find("[data-test='comment-delete-btn']");
    expect(delBtn().text()).toBe("删除");

    // 第一次点击：进入待确认态，不触发 remove
    await delBtn().trigger("click");
    expect(wrapper.emitted("remove")).toBeFalsy();
    expect(delBtn().text()).toBe("确认删除");

    // 第二次点击：触发 remove 并复位
    await delBtn().trigger("click");
    expect(wrapper.emitted("remove")?.[0]).toEqual([2]);
    expect(delBtn().text()).toBe("删除");
  });

  it("hides comment icon when comment is empty", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: [{ ...mockRecords[0], comment: "" }] },
    });

    const items = wrapper.findAll("[data-test='timeline-item']");
    expect(items.length).toBe(1);
    expect(items[0].find("button[aria-label='查看评语']").exists()).toBe(false);
    expect(items[0].find("span[role='tooltip']").exists()).toBe(false);
  });

  it("renders empty state and responds to add event", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: [] },
    });

    expect(wrapper.text()).toContain("本班暂无日常表现记录");
    const addBtn = wrapper.find("[data-test='empty-add-btn']");
    expect(addBtn.exists()).toBe(true);
    await addBtn.trigger("click");
    expect(wrapper.emitted("add")).toBeTruthy();
  });

  it("renders filter empty state when filtering produces no match", async () => {
    const wrapper = mount(ClassBehaviorTimeline, {
      props: { records: mockRecords },
    });

    const studyPill = wrapper.findAll("button").find((b) => b.text().includes("学习表现"));
    await studyPill!.trigger("click");

    // 学习分类下没有待改进
    const improveBtn = wrapper.find("[data-test='filter-improve']");
    await improveBtn.trigger("click");

    expect(wrapper.text()).toContain("没有符合筛选条件的表现记录");
  });
});
