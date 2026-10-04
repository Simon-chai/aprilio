/**
 * SQLite 真通道测试适配器：把 @tauri-apps/plugin-sql 的 Database 语义
 * 落到 Node 自带的 node:sqlite（内存库）上，让 db/ 层的 SQL 分支能在 vitest
 * 里端到端执行——真实建表、真实 SQL、真实事务批，而不是内存兜底的复制品。
 *
 * 与 Rust 侧行为对齐的关键点：
 * - execute 支持多语句批（BEGIN IMMEDIATE…COMMIT）：按占位符数量切分参数逐条执行
 *   （本项目的 SQL 不在字符串字面量里放分号与问号，顶层切分是安全的）；
 * - execute 返回 { rowsAffected, lastInsertId }，lastInsertId 取批内最后一次插入；
 * - select 返回行数组；INTEGER 列为 number、NULL 为 null。
 */
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

function splitStatements(query: string): string[] {
  return query
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function placeholdersOf(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

export function createSqliteAdapter() {
  const db = new DatabaseSync(":memory:");

  return {
    async execute(
      query: string,
      bindValues: unknown[] = []
    ): Promise<{ rowsAffected: number; lastInsertId: number }> {
      let rowsAffected = 0;
      let lastInsertId = 0;
      let cursor = 0;
      for (const sql of splitStatements(query)) {
        const count = placeholdersOf(sql);
        const slice = bindValues.slice(cursor, cursor + count);
        cursor += count;
        if (count === 0) {
          // BEGIN / COMMIT / 无参 DDL / PRAGMA：exec 更贴近真实批量语义
          db.exec(sql);
          continue;
        }
        const info = db.prepare(sql).run(...slice);
        rowsAffected += Number(info.changes);
        const rid = Number(info.lastInsertRowid ?? 0);
        if (rid > 0) lastInsertId = rid;
      }
      return { rowsAffected, lastInsertId };
    },

    async select<T = Row>(query: string, bindValues: unknown[] = []): Promise<T[]> {
      return db.prepare(query).all(...bindValues) as T[];
    },
  };
}
