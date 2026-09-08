import { describe, expect, it } from "vitest";
import {
  computeExamStats,
  computeStudentTotals,
  formatRate,
  rankBySubject,
  rankByTotal,
  scoreLevel,
  scoreRatio,
  subjectAverages,
  trendOf,
} from "../src/lib/score-analysis";
import type { ExamScoreRow } from "../src/types";

function row(
  student_id: number,
  subject: string,
  score: number | null,
  grade: string | null = null
): ExamScoreRow {
  return {
    id: student_id * 100 + subject.length,
    exam_id: 1,
    student_id,
    subject,
    score,
    grade,
    student_name: `学生${student_id}`,
    student_no: `S${student_id}`,
    created_at: "",
    updated_at: "",
  };
}

describe("score-analysis 纯函数", () => {
  it("scoreLevel / scoreRatio / formatRate 口径正确", () => {
    expect(scoreLevel(95)).toBe("excellent");
    expect(scoreLevel(85)).toBe("good");
    expect(scoreLevel(60)).toBe("pass");
    expect(scoreLevel(59)).toBe("fail");
    expect(scoreLevel(null)).toBeNull();
    expect(scoreRatio(90)).toBe(0.9);
    expect(scoreRatio(120)).toBe(1);
    expect(formatRate(0.8)).toBe("80%");
    expect(formatRate(null)).toBe("—");
  });

  it("computeStudentTotals 数字分求和、纯等级汇总文本", () => {
    const rows = [
      row(1, "语文", 90),
      row(1, "数学", 80),
      row(2, "语文", null, "优"),
      row(2, "数学", null, "良"),
    ];
    const totals = computeStudentTotals(rows);
    expect(totals.get(1)?.score).toBe(170);
    expect(totals.get(1)?.subjectCount).toBe(2);
    expect(totals.get(2)?.score).toBeNull();
    expect(totals.get(2)?.grade).toBe("优、良");
  });

  it("rankByTotal 降序并列同名次，无总分者不参与", () => {
    const ranks = rankByTotal(
      new Map([
        [1, { score: 300 }],
        [2, { score: 300 }],
        [3, { score: 250 }],
        [4, { score: null }],
      ])
    );
    expect(ranks.get(1)).toBe(1);
    expect(ranks.get(2)).toBe(1);
    expect(ranks.get(3)).toBe(3);
    expect(ranks.has(4)).toBe(false);
  });

  it("computeExamStats 给出总分与各科统计", () => {
    const rows = [
      row(1, "语文", 90),
      row(1, "数学", 100),
      row(2, "语文", 50),
      row(2, "数学", 60),
    ];
    const stats = computeExamStats(rows);
    expect(stats.student_count).toBe(2);
    expect(stats.total_count).toBe(2);
    expect(stats.total_average).toBe(150); // (190 + 110) / 2
    expect(stats.total_max).toBe(190);
    expect(stats.total_min).toBe(110);
    // 总分满分 2×100=200，及格线 120：仅 190 一人及格
    expect(stats.total_pass_rate).toBe(0.5);
    // 优秀线 180：仅 190 一人
    expect(stats.total_excellent_rate).toBe(0.5);

    const chinese = stats.subjects.find((s) => s.subject === "语文")!;
    expect(chinese.average).toBe(70);
    expect(chinese.passRate).toBe(0.5);
    expect(chinese.excellentRate).toBe(0.5);
  });

  it("rankBySubject / subjectAverages 单科排名与均值", () => {
    const rows = [row(1, "语文", 90), row(2, "语文", 95), row(3, "语文", 90)];
    const ranks = rankBySubject(rows).get("语文")!;
    expect(ranks.get(2)).toBe(1);
    expect(ranks.get(1)).toBe(2);
    expect(ranks.get(3)).toBe(2);
    expect(subjectAverages(rows).get("语文")).toBe(91.7);
  });

  it("trendOf 返回进退步差值", () => {
    expect(trendOf(200, 180)).toBe(20);
    expect(trendOf(180, 200)).toBe(-20);
    expect(trendOf(200, 200)).toBe(0);
    expect(trendOf(null, 200)).toBeNull();
    expect(trendOf(200, null)).toBeNull();
  });
});
