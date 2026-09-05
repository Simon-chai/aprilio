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
    expect(result.summary).toContain("命中 10 条");
  });

  it("queries photos and stats", async () => {
    const photos = await tool.execute({ entity: "photos" }, ctx);
    expect(photos.ok).toBe(true);
    expect((photos.data as unknown[]).length).toBeGreaterThan(0);

    const stats = await tool.execute({ entity: "stats" }, ctx);
    expect(stats.ok).toBe(true);
    expect(stats.summary).toContain('"students":10');
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
});
