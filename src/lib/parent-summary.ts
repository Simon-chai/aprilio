/**
 * 家校沟通总结：时段聚合纯函数。
 * 只做计算不碰 LLM，AI 层见 parent-summary-ai.ts；设计见 docs/PARENT_SUMMARY.md。
 */
import { semesterOfDate } from "./semester";
import type { ReportRange } from "../types";

/** 一条评价的最小素材（与 comment-ai 的 TermBehaviorRow 同形） */
export interface SummaryBehaviorRow {
  type: string;
  dimension_name_snap: string;
  comment: string;
}

/** 聊天式重写的一轮展示记录（用户要求 / 助手总结），面板与批量对话框共用 */
export interface SummaryTurn {
  role: "user" | "assistant";
  text: string;
}

/** 按 [start, end] 闭区间过滤表现记录（日期均为 YYYY-MM-DD，字符串比较即时间序） */
export function filterBehaviorsByRange<T extends { recorded_date: string }>(
  rows: T[],
  start: string,
  end: string
): T[] {
  return rows.filter((r) => r.recorded_date >= start && r.recorded_date <= end);
}

export interface SummaryMaterial {
  /** 拼给模型的评价素材文本（空串 = 本时段无评价） */
  text: string;
  praiseCount: number;
  improveCount: number;
  neutralCount: number;
  total: number;
}

/**
 * 把时段内的评价按倾向分组拼成素材文本：每组带条数，正文条目按记录原序截取前几条。
 * 比 comment-ai.buildBehaviorSummary（每倾向 3 条、界面参考用）给模型更多信息，
 * 因为总结质量直接取决于素材完整度。
 */
export function buildParentSummaryMaterial(
  rows: SummaryBehaviorRow[],
  perGroupLimit = 8
): SummaryMaterial {
  const groups: Record<"praise" | "improve" | "neutral", string[]> = {
    praise: [],
    improve: [],
    neutral: [],
  };
  for (const r of rows) {
    const key = (r.type in groups ? r.type : "neutral") as keyof typeof groups;
    const comment = r.comment.trim();
    groups[key].push(comment ? `${r.dimension_name_snap}：${comment}` : r.dimension_name_snap);
  }
  const label: Record<keyof typeof groups, string> = {
    praise: "表扬",
    improve: "待改进",
    neutral: "其他",
  };
  const parts = (["praise", "improve", "neutral"] as const)
    .filter((k) => groups[k].length)
    .map((k) => `${label[k]}（${groups[k].length} 条）：${groups[k].slice(0, perGroupLimit).join("；")}`);
  return {
    text: parts.join("。"),
    praiseCount: groups.praise.length,
    improveCount: groups.improve.length,
    neutralCount: groups.neutral.length,
    total: rows.length,
  };
}

/** 时间范围展示文本：学期模式带学期号，自定义只给日期区间 */
export function rangeLabel(range: ReportRange): string {
  return range.mode === "semester" && range.semester
    ? `${range.semester} 学期（${range.start}~${range.end}）`
    : `${range.start} ~ ${range.end}`;
}

/**
 * 应用到档案的目标学期：学期模式写该学期；自定义模式按起始日期推导
 * （与评价报告「短评语回写按结束日期推导」不同——这里总结覆盖的是时段开头所属学期的评语）。
 */
export function targetSemesterOfRange(range: ReportRange): string {
  if (range.mode === "semester" && range.semester) return range.semester;
  return semesterOfDate(range.start);
}
