import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import analyzeTool from "../src/agent/tools/analyze";
import queryDataTool from "../src/agent/tools/query";
import { listStudents } from "../src/lib/db";

/**
 * jsdom 无 Tauri 外壳 → db.ts 走内存演示数据：
 * 四年级一班 10 名学生 × 3 次考试（期中 / 期末 / 等级制月考）。
 */
const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

describe("query_data：成绩实体", () => {
  it("查询考试批次（exams），带成绩统计", async () => {
    const res = await queryDataTool.execute({ entity: "exams", grade_class: "四年级一班" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("期中考试");
    expect(res.summary).toContain("期末考试");
    const rows = res.data as { name: string; student_count: number; score_count: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((e) => e.student_count === 10)).toBe(true);
  });

  it("查询成绩明细（scores），可按班级/学生/科目过滤", async () => {
    const all = await queryDataTool.execute({ entity: "scores", grade_class: "四年级一班" }, ctx);
    expect(all.ok).toBe(true);
    const rows = all.data as { student_name: string; subject: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.student_name === "陈嘉树")).toBe(true);

    const zhao = (await listStudents("赵晨曦")).find((s) => s.grade_class === "四年级一班")!;
    const mine = await queryDataTool.execute(
      { entity: "scores", student_id: zhao.id, subject: "语文" },
      ctx
    );
    const mineRows = mine.data as { subject: string; student_id: number }[];
    expect(mineRows.length).toBeGreaterThan(0);
    expect(mineRows.every((r) => r.subject === "语文" && r.student_id === zhao.id)).toBe(true);
  });
});

describe("analyze：成绩分析器", () => {
  it("score_overview 给出班级统计与总分排名", async () => {
    const res = await analyzeTool.execute(
      { kind: "score_overview", payload: { class_name: "四年级一班" } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("平均总分");
    expect(res.summary).toContain("总分排名");
    const data = res.data as { stats: { student_count: number }; ranking: unknown[] };
    expect(data.stats.student_count).toBe(10);
    expect(data.ranking.length).toBe(10);
  });

  it("score_rank 返回降序排行榜", async () => {
    const res = await analyzeTool.execute(
      { kind: "score_rank", payload: { class_name: "四年级一班" } },
      ctx
    );
    expect(res.ok).toBe(true);
    const data = res.data as { ranking: { name: string; total: number }[] };
    for (let i = 1; i < data.ranking.length; i++) {
      expect(data.ranking[i - 1].total).toBeGreaterThanOrEqual(data.ranking[i].total);
    }
    expect(data.ranking[0].name).toBe("赵晨曦");
  });

  it("score_student 给出学生成绩报告、排名与偏科诊断", async () => {
    const zhao = (await listStudents("赵晨曦")).find((s) => s.grade_class === "四年级一班")!;
    const res = await analyzeTool.execute(
      { kind: "score_student", payload: { student_id: zhao.id } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("赵晨曦");
    expect(res.summary).toContain("班级第");
    const report = res.data as { exams: unknown[] };
    expect(report.exams.length).toBeGreaterThanOrEqual(3);
  });

  it("score_trend 传 class_name 时给出班级多次考试趋势", async () => {
    const res = await analyzeTool.execute(
      { kind: "score_trend", payload: { class_name: "四年级一班" } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("成绩趋势");
    expect(res.summary).toContain("平均单科分");
    expect(res.summary).toContain("第一次月考");
    expect(res.summary).toContain("期末考试");
  });

  it("score_trend 给出总分走势", async () => {
    const zhao = (await listStudents("赵晨曦")).find((s) => s.grade_class === "四年级一班")!;
    const res = await analyzeTool.execute(
      { kind: "score_trend", payload: { student_id: zhao.id } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("总分走势");
  });

  it("缺少 class_name 时返回可读错误而不是崩溃", async () => {
    const res = await analyzeTool.execute({ kind: "score_overview", payload: {} }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("class_name");
  });
});
