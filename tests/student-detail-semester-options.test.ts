import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import StudentDetailView from "../src/views/StudentDetailView.vue";
import { currentSemester } from "../src/lib/timetable";
import { recentSemesters } from "../src/lib/semester";

/**
 * 回归：学期下拉不能只列「有数据的学期」，否则无法切到空白的历史学期看空态。
 */
describe("StudentDetailView 学期下拉", () => {
  function createTestRouter() {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/students", name: "students", component: { template: "<div>Students</div>" } },
        { path: "/students/:id", name: "student-detail", component: StudentDetailView },
      ],
    });
  }

  it("列出当前学期与最近若干历史学期（即使该学期没有成绩/表现）", async () => {
    const router = createTestRouter();
    await router.push("/students/1");
    await router.isReady();

    const wrapper = mount(StudentDetailView, { global: { plugins: [router] } });
    await flushPromises();
    await flushPromises();

    const values = wrapper
      .findAll("[data-test='semester-select'] option")
      .map((option) => option.attributes("value"));

    expect(values).toContain(currentSemester());
    for (const semester of recentSemesters(4)) {
      expect(values).toContain(semester);
    }
    // 至少要有「当前 + 上一学期」，保证空态可达
    expect(values.length).toBeGreaterThan(1);
  });
});
