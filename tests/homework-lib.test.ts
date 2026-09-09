import { describe, expect, it } from "vitest";
import {
  buildHomeworkSummary,
  filterHomeworksByRange,
  summarizeHomeworks,
  validateHomeworkInput,
} from "../src/lib/homework";
import type { HomeworkInput, StudentHomeworkRecord } from "../src/types";

function row(partial: Partial<StudentHomeworkRecord> = {}): StudentHomeworkRecord {
  return {
    id: 1,
    student_id: 1,
    homework_date: "2026-09-05",
    subject: "语文",
    status: "done",
    score: null,
    comment: null,
    created_at: "2026-09-05 10:00:00",
    updated_at: "2026-09-05 10:00:00",
    ...partial,
  };
}

describe("作业台账纯函数", () => {
  it("拒绝未来日期与空科目", () => {
    const base: HomeworkInput = { student_id: 1, homework_date: "2026-09-05", subject: "数学", status: "done" };
    expect(() => validateHomeworkInput(base)).not.toThrow();
    expect(() => validateHomeworkInput({ ...base, homework_date: "2099-01-01" })).toThrow("未来");
    expect(() => validateHomeworkInput({ ...base, subject: "  " })).toThrow("科目");
    expect(() => validateHomeworkInput({ ...base, status: "great" as never })).toThrow("状态");
    expect(() => validateHomeworkInput({ ...base, score: 120 })).toThrow("0~100");
  });

  it("按区间过滤含两端", () => {
    const rows = [
      row({ id: 1, homework_date: "2026-09-01" }),
      row({ id: 2, homework_date: "2026-09-05" }),
      row({ id: 3, homework_date: "2026-09-10" }),
    ];
    expect(filterHomeworksByRange(rows, "2026-09-01", "2026-09-05").map((r) => r.id)).toEqual([1, 2]);
  });

  it("汇总按时率剔除免做", () => {
    const rows = [
      row({ status: "excellent" }),
      row({ status: "done" }),
      row({ status: "late" }),
      row({ status: "missing" }),
      row({ status: "exempt" }),
    ];
    const s = summarizeHomeworks(rows);
    expect(s.total).toBe(5);
    // (1+1)/(5-1)=0.5
    expect(s.onTimeRate).toBeCloseTo(0.5);
    expect(buildHomeworkSummary(rows)).toContain("按时率 50%");
  });

  it("空数据汇总为空串，按时率 null", () => {
    expect(summarizeHomeworks([]).onTimeRate).toBeNull();
    expect(buildHomeworkSummary([])).toBe("");
  });
});
