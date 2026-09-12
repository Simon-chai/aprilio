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
  summarizeSubjectTrend,
  trendOf,
} from "../src/lib/score-analysis";
import type { ExamScoreRow, StudentExamReport } from "../src/types";

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

/** 构造单科趋势测试用的考试报告（科目明细只保留测试关心的字段） */
function examReport(
  exam_id: number,
  exam_date: string,
  subjects: {
    subject: string;
    score?: number | null;
    grade?: string | null;
    class_average?: number | null;
    class_rank?: number | null;
  }[]
): StudentExamReport {
  return {
    exam_id,
    exam_name: `考试${exam_id}`,
    exam_date,
    exam_type: "major",
    subjects: subjects.map((s) => ({
      subject: s.subject,
      score: s.score ?? null,
      grade: s.grade ?? null,
      class_average: s.class_average ?? null,
      class_rank: s.class_rank ?? null,
    })),
    total: null,
    total_grade: null,
    class_total_average: null,
    class_total_rank: null,
    class_student_count: 3,
    total_delta: null,
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

  it("summarizeSubjectTrend 汇总单科趋势：统计、较上次差值与名次变化", () => {
    const exams = [
      examReport(1, "2026-03-01", [
        { subject: "语文", score: 80, class_average: 85, class_rank: 3 },
        { subject: "数学", score: 90, class_average: 88, class_rank: 2 },
      ]),
      examReport(2, "2026-04-01", [
        { subject: "语文", score: 90, class_average: 80, class_rank: 1 },
        { subject: "数学", score: 85, class_average: 86, class_rank: 2 },
      ]),
      examReport(3, "2026-05-01", [{ subject: "语文", score: 85, class_average: 82.5, class_rank: 2 }]),
    ];
    const trend = summarizeSubjectTrend(exams, "语文");
    // 数据点覆盖每场考试（第三场没有数学也不影响语文），按时间正序
    expect(trend.points).toHaveLength(3);
    expect(trend.points.map((p) => p.exam_id)).toEqual([1, 2, 3]);
    expect(trend.count).toBe(3);
    expect(trend.average).toBe(85); // (80+90+85)/3
    expect(trend.max).toBe(90);
    expect(trend.min).toBe(80);
    expect(trend.range).toBe(10);
    expect(trend.latestScore).toBe(85);
    expect(trend.latestDelta).toBe(-5); // 90 → 85
    expect(trend.latestGapToClassAvg).toBe(2.5); // 85 − 82.5
    expect(trend.bestRank).toBe(1);
    expect(trend.latestRank).toBe(2);
    expect(trend.rankDelta).toBe(1); // 第 1 → 第 2，正数 = 名次下滑
  });

  it("summarizeSubjectTrend 容错：缺考不参与统计、缺该科为断点、名次跳过空值", () => {
    const exams = [
      examReport(1, "2026-03-01", [{ subject: "语文", score: null, grade: "缺考" }]),
      examReport(2, "2026-04-01", [{ subject: "语文", score: 88, class_average: 84, class_rank: 2 }]),
      examReport(3, "2026-05-01", [{ subject: "数学", score: 70 }]),
    ];
    const trend = summarizeSubjectTrend(exams, "语文");
    expect(trend.points).toHaveLength(3);
    expect(trend.points[0].grade).toBe("缺考");
    expect(trend.points[2].score).toBeNull(); // 该场没有语文 → 断点
    expect(trend.count).toBe(1);
    expect(trend.average).toBe(88);
    expect(trend.range).toBeNull();
    expect(trend.latestDelta).toBeNull();
    expect(trend.latestGapToClassAvg).toBe(4); // 88 − 84
    expect(trend.bestRank).toBe(2);
    expect(trend.latestRank).toBe(2);
    expect(trend.rankDelta).toBeNull(); // 只有一次名次无从比较
  });

  it("summarizeSubjectTrend 无数字分时统计为空", () => {
    const trend = summarizeSubjectTrend(
      [examReport(1, "2026-03-01", [{ subject: "语文", score: null, grade: "优" }])],
      "语文"
    );
    expect(trend.count).toBe(0);
    expect(trend.average).toBeNull();
    expect(trend.latestScore).toBeNull();
    expect(trend.bestRank).toBeNull();
    expect(trend.latestRank).toBeNull();
  });
});
