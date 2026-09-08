import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import queryDataTool from "../src/agent/tools/query";

/** jsdom 无 Tauri 外壳 → db.ts 自动走内存示例数据（10 名学生、若干照片） */
const tool = queryDataTool;
const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

function rowsFrom(summary: string): unknown[] {
  const idx = summary.indexOf("\n");
  return JSON.parse(summary.slice(idx + 1)) as unknown[];
}

describe("query_data tool", () => {
  it("filters students by keyword", async () => {
    const result = await tool.execute({ entity: "students", keyword: "林" }, ctx);
    expect(result.ok).toBe(true);
    const rows = rowsFrom(result.summary) as { name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.name === "林知远")).toBe(true);
  });

  it("filters students by grade class", async () => {
    const result = await tool.execute({ entity: "students", grade_class: "三年级二班" }, ctx);
    const rows = rowsFrom(result.summary) as { grade_class: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.grade_class === "三年级二班")).toBe(true);
  });

  it("caps the returned rows by limit", async () => {
    const result = await tool.execute({ entity: "students", limit: 3 }, ctx);
    expect((result.data as unknown[]).length).toBe(3);
    // 演示种子：10 名原有学生 + 四年级一班补足 8 名（成绩样例）
    expect(result.summary).toContain("命中 18 条");
  });

  it("queries photos and stats", async () => {
    const photos = await tool.execute({ entity: "photos" }, ctx);
    expect(photos.ok).toBe(true);
    expect((photos.data as unknown[]).length).toBeGreaterThan(0);

    const stats = await tool.execute({ entity: "stats" }, ctx);
    expect(stats.ok).toBe(true);
    expect(stats.summary).toContain('"students":18');
  });

  it("filters photos by student id", async () => {
    const all = await tool.execute({ entity: "photos" }, ctx);
    const one = await tool.execute({ entity: "photos", student_id: 1 }, ctx);
    expect((one.data as unknown[]).length).toBeLessThan((all.data as unknown[]).length);
    expect((one.data as { student_id: number }[]).every((p) => p.student_id === 1)).toBe(true);
  });

  it("rejects unknown entities", async () => {
    const result = await tool.execute({ entity: "orders" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知查询实体");
  });

  it("queries student behavior records with polarity and keyword filters", async () => {
    // 预置表现记录
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "智能助手表现查询测试：数学课主动发言",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        polarity: "praise",
        keyword: "主动发言",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("数学课主动发言");
    const data = res.data as { comment: string }[];
    expect(data.some((d) => d.comment.includes("主动发言"))).toBe(true);
  });

  it("filters behavior records by dimension_name and polarity", async () => {
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 1,
      dimension_name_snap: "作业情况",
      category_snap: "study",
      type: "improve",
      comment: "未按时交作业",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        dimension_name: "作业情况",
        polarity: "improve",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    const data = res.data as { comment: string; dimension_name_snap: string; type: string }[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.every((d) => d.dimension_name_snap === "作业情况" && d.type === "improve")).toBe(true);
  });

  it("queries and filters behavior records with neutral polarity", async () => {
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 2,
      dimension_id: 2,
      dimension_name_snap: "日常纪律",
      category_snap: "behavior",
      type: "neutral",
      comment: "智能助手表现查询测试：常规午休考勤记录",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 2,
        polarity: "neutral",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("➖");
    expect(res.summary).toContain("常规午休考勤记录");
    const data = res.data as { comment: string; type: string }[];
    expect(data.some((d) => d.type === "neutral" && d.comment.includes("常规午休考勤记录"))).toBe(true);
  });

  it("appends student id to summary line when student_id is omitted", async () => {
    const res = await tool.execute(
      {
        entity: "behaviors",
        limit: 5,
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/\(学生ID: \d+\)/);
  });
});
