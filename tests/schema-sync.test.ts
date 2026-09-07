import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 从 DDL 文本里提取所有 CREATE TABLE IF NOT EXISTS 的表名 */
function tableNames(source: string): string[] {
  return [...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
}

/**
 * 历史迁移里建过、后来被新版本迁移删除的表（lib.rs 侧文本保留是历史记录，
 * ensureSchema 侧不应再建）。对账时从两边剔除。
 * - calendar_memos：v4 起升级为 calendar_events（旧备忘数据已迁入并删表）
 */
const LEGACY_TABLES = new Set(["calendar_memos"]);

/**
 * lib.rs 的迁移与 db.ts 的 ensureSchema 是同一份表结构的两份落地（迁移管新库，ensureSchema
 * 兜底迁移历史混乱的调试库）。两边必须覆盖完全相同的表，否则一边建了一边查询就会炸。
 */
describe("schema DDL parity (lib.rs migrations ↔ db.ts ensureSchema)", () => {
  const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
  const ts = readFileSync("src/lib/db.ts", "utf8");

  it("covers exactly the same tables on both sides", () => {
    const rustTables = [...new Set(tableNames(rust))].filter((t) => !LEGACY_TABLES.has(t)).sort();
    const tsTables = [...new Set(tableNames(ts))].filter((t) => !LEGACY_TABLES.has(t)).sort();

    expect(rustTables).toContain("students");
    expect(tsTables).toContain("timetables");
    expect(tsTables).toContain("timetable_exceptions");
    expect(tsTables).toContain("calendar_events");
    expect(rustTables).toEqual(tsTables);
  });

  it("declares every table with IF NOT EXISTS on both sides (幂等前提)", () => {
    expect(rust).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
    expect(ts).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });
});
