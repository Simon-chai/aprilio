/**
 * db 域间共享的小工具（拆分自 db.ts）：本地时间戳 / 标签解析 / 照片快照 / 回收站期限。
 * 只服务 db/ 内部与 db 门面的 recycleRemainingDays，不属于公共数据 API。
 */
import { RECYCLE_RETENTION_DAYS } from "../../types";
import type { Photo, RecycleItem } from "../../types";

/* ------------------------------------------------------------------ */
/* 回收站：快照存取辅助                                                  */
/* ------------------------------------------------------------------ */

export const RETENTION_MS = RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** "2026-09-06 10:00:00" 格式化 */
export function fmtLocalTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** deleted_at + 保留天数 → 过期时间戳 */
export function expireAtOf(deletedAt: string): string {
  const t = new Date(deletedAt.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return deletedAt;
  return fmtLocalTs(new Date(t + RETENTION_MS));
}

/** 距彻底删除还剩几天（向上取整，最小 0） */

/** 校验 YYYY-MM-DD 字面日期（调课例外与日程事件共用） */
export function assertCalendarDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式应为 YYYY-MM-DD");
}

export function recycleRemainingDays(item: Pick<RecycleItem, "expire_at">, now = new Date()): number {
  const expire = new Date(item.expire_at.replace(" ", "T")).getTime();
  if (Number.isNaN(expire)) return 0;
  return Math.max(0, Math.ceil((expire - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/** 监护人标签解析：JSON 数组字符串 / 已是数组 / 脏数据 → string[] */
export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** 快照里抽出的照片元数据 */
export interface PhotoSnapshot {
  grade_class?: string | null;
  file_name: string;
  caption: string | null;
  taken_at: string | null;
}

export function photoSnap(p: Pick<Photo, "grade_class" | "file_name" | "caption" | "taken_at">): PhotoSnapshot {
  return {
    grade_class: p.grade_class ?? null,
    file_name: p.file_name,
    caption: p.caption ?? null,
    taken_at: p.taken_at ?? null,
  };
}

