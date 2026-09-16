/**
 * 活动组合解析（classroom_activity_sets → 一节课实际生效的活动列表）。
 *
 * 解析顺序：科目专属集 → 通用集 → 代码默认集（设计规范 §4.4）。
 * - 科目匹配：trim 后精确相等（同 isMySubject 口径）；通用集 = subject 为空串的记录
 * - 同优先级多条：取 sort_order 最小，其次 id 最小（listClassroomActivitySets 已按此排序）
 * - 表里没有 → 代码内置默认集（表建好但仅在教师自定义时才有数据）
 * 解析结果会被 startLesson 快照进 lesson_sessions.activity_set_json：下课前改组合不影响本次课。
 */
import { listClassroomActivitySets } from "../lib/db";
import type { ActivitySetEntry } from "./types";

/** P0 代码内置默认集（表建好但仅教师自定义时写入；解析顺序 = 科目专属 → 通用 → 代码默认） */
export const DEFAULT_ACTIVITY_SET: ActivitySetEntry[] = [
  { type: "picker" },
  { type: "seating" },
  { type: "group-race" },
  { type: "digest" },
];

export interface ResolvedActivitySet {
  activities: ActivitySetEntry[];
  source: "subject" | "common" | "default";
}

/** 深拷一份（config 是活动自解释对象，避免调用方改动污染配置源） */
function cloneEntries(entries: ActivitySetEntry[]): ActivitySetEntry[] {
  return entries.map((e) => (e.config ? { type: e.type, config: { ...e.config } } : { type: e.type }));
}

/** 解析一节课的活动组合：科目专属集 → 通用集 → 代码默认集 */
export async function resolveActivitySet(subject: string): Promise<ResolvedActivitySet> {
  const key = (subject ?? "").trim();
  const sets = await listClassroomActivitySets(); // 已按 sort_order ASC, id ASC
  const find = (wanted: string) => sets.find((s) => s.subject.trim() === wanted);

  if (key) {
    const own = find(key);
    if (own) return { activities: cloneEntries(own.activities), source: "subject" };
  }
  const common = find("");
  if (common) return { activities: cloneEntries(common.activities), source: "common" };
  return { activities: cloneEntries(DEFAULT_ACTIVITY_SET), source: "default" };
}