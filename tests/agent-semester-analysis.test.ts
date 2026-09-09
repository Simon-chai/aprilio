import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import analyzeTool from "../src/agent/tools/analyze";
import { listStudents } from "../src/lib/db";
import { semesterOfDate } from "../src/lib/semester";

const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

/** 内存演示数据里四年级一班的期末考试日期 */
const TERM = semesterOfDate("2026-11-05");

describe("analyze：学期汇总分析器", () => {
  it("semester_overview 汇总某班某学期成绩与表现", async () => {
    const res = await analyzeTool.execute(
      { kind: "semester_overview", payload: { class_name: "四年级一班", semester: TERM } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("四年级一班");
    expect(res.summary).toContain("学期");
    expect(res.summary).toContain("期中考试");
    const data = res.data as { exams: unknown[]; student_count: number };
    expect(data.exams.length).toBeGreaterThanOrEqual(2);
    expect(data.student_count).toBe(10);
  });

  it("semester_overview 缺少 class_name 时返回可读错误", async () => {
    const res = await analyzeTool.execute({ kind: "semester_overview", payload: {} }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("class_name");
  });

  it("student_term_report 给出某生某学期轨迹", async () => {
    const zhao = (await listStudents("赵晨曦")).find((s) => s.grade_class === "四年级一班")!;
    const res = await analyzeTool.execute(
      { kind: "student_term_report", payload: { student_id: zhao.id, semester: TERM } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("赵晨曦");
    expect(res.summary).toContain("期中考试");
    const data = res.data as { exams: unknown[]; behaviors: unknown[] };
    expect(data.exams.length).toBeGreaterThanOrEqual(1);
  });

  it("student_term_report 缺学生定位时返回可读错误", async () => {
    const res = await analyzeTool.execute(
      { kind: "student_term_report", payload: { semester: TERM } },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("student_id");
  });
});
