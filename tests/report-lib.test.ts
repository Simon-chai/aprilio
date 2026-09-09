import { describe, expect, it } from "vitest";
import {
  buildDataReportMarkdown,
  buildReportTitle,
  resolveReportRange,
  semesterDateRange,
} from "../src/lib/report";

describe("报告聚合纯函数", () => {
  it("学期起止与自定义区间解析", () => {
    expect(semesterDateRange("2026-2027-1")).toEqual(["2026-09-01", "2027-02-28"]);
    expect(semesterDateRange("2025-2026-2")).toEqual(["2026-03-01", "2026-08-31"]);
    const r = resolveReportRange({ mode: "semester", semester: "2026-2027-1" });
    expect(r.start).toBe("2026-09-01");
    expect(() => resolveReportRange({ mode: "custom", start: "2026-09-10", end: "2026-09-01" })).toThrow(
      "不能晚于"
    );
  });

  it("标题与数据版报告含 4 节", () => {
    const range = resolveReportRange({ mode: "custom", start: "2026-09-01", end: "2026-09-30" });
    expect(buildReportTitle(range, "林知远")).toContain("林知远");
    const md = buildDataReportMarkdown("林知远", range, {
      scoreSummary: "期中：语文 92",
      behaviorSummary: "表扬：课堂积极",
      homeworkSummary: "共 5 次，按时率 80%",
      examCount: 1,
      praiseCount: 2,
      improveCount: 0,
    });
    expect(md).toContain("## 学业表现");
    expect(md).toContain("## 作业情况");
    expect(md).toContain("## 给家长的建议");
  });
});
