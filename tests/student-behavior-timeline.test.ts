import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StudentBehaviorTimeline from "../src/components/StudentBehaviorTimeline.vue";
import type { StudentBehaviorRecord } from "../src/types";

const mockRecords: StudentBehaviorRecord[] = [
  {
    id: 1,
    student_id: 1,
    dimension_id: 3,
    dimension_name_snap: "课堂表现",
    category_snap: "behavior",
    type: "praise",
    comment: "积极举手发言，解答疑难问题思路清晰",
    recorded_date: "2026-09-05",
    created_at: "2026-09-05 10:30:00",
  },
  {
    id: 2,
    student_id: 1,
    dimension_id: 1,
    dimension_name_snap: "作业情况",
    category_snap: "study",
    type: "improve",
    comment: "缺少一次课后错题订正",
    recorded_date: "2026-09-05",
    created_at: "2026-09-05 14:00:00",
  },
  {
    id: 3,
    student_id: 1,
    dimension_id: 4,
    dimension_name_snap: "劳动情况",
    category_snap: "behavior",
    type: "praise",
    comment: "主动协助打扫卫生角",
    recorded_date: "2026-09-02",
    created_at: "2026-09-02 16:20:00",
  },
];

describe("StudentBehaviorTimeline.vue", () => {
  it("renders empty state when there are no records", () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: [] },
    });
    expect(wrapper.text()).toContain("暂无日常表现记录");
    const addBtn = wrapper.find("[data-test='empty-add-btn']");
    expect(addBtn.exists()).toBe(true);
  });

  it("groups records by recorded_date in descending order", () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    const dateHeaders = wrapper.findAll("[data-test='timeline-date']");
    expect(dateHeaders.length).toBe(2);
    expect(dateHeaders[0].text()).toContain("2026-09-05");
    expect(dateHeaders[1].text()).toContain("2026-09-02");
  });

  it("filters records by polarity (all / praise / improve)", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(3);

    // 切换到仅看待改进
    const improveFilter = wrapper.get("[data-test='filter-improve']");
    await improveFilter.trigger("click");
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(1);
    expect(wrapper.text()).toContain("缺少一次课后错题订正");

    // 切换到表扬
    const praiseFilter = wrapper.get("[data-test='filter-praise']");
    await praiseFilter.trigger("click");
    expect(wrapper.findAll("[data-test='timeline-item']").length).toBe(2);
    expect(wrapper.text()).toContain("积极举手发言");
  });

  it("filters records by dimension", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: mockRecords },
    });
    const select = wrapper.get("[data-test='dimension-select']");
    await select.setValue("劳动情况");
    const items = wrapper.findAll("[data-test='timeline-item']");
    expect(items.length).toBe(1);
    expect(wrapper.text()).toContain("主动协助打扫卫生角");
  });

  it("emits add event when clicking empty add button", async () => {
    const wrapper = mount(StudentBehaviorTimeline, {
      props: { records: [] },
    });
    await wrapper.get("[data-test='empty-add-btn']").trigger("click");
    expect(wrapper.emitted("add")).toBeTruthy();
  });
});
