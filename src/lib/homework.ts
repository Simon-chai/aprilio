/**
 * 作业台账纯函数：状态标签 / 校验 / 区间过滤 / 汇总。
 * 只做计算不碰数据库，界面与 AI 报告共用同一口径。
 */
import type { HomeworkInput, HomeworkStatus, HomeworkSummary, StudentHomeworkRecord } from "../types";
import { localDateStr } from "./format";

/** 作业状态展示标签 */
export const HOMEWORK_STATUS_LABEL: Record<HomeworkStatus, string> = {
  excellent: "优秀",
  done: "按时完成",
  late: "迟交",
  missing: "缺交",
  exempt: "免做",
};

/** 合法状态集合（防脏数据入库） */
const VALID_STATUS: ReadonlySet<string> = new Set(["done", "excellent", "late", "missing", "exempt"]);

export function isHomeworkStatus(value: unknown): value is HomeworkStatus {
  return typeof value === "string" && VALID_STATUS.has(value);
}

/**
 * 作业录入校验：抛错即不合法（调用方 catch 转用户提示）。
 * 日期必须 YYYY-MM-DD 且不晚于今天；科目非空；评语 ≤200 字；分数 0~100。
 */
export function validateHomeworkInput(input: HomeworkInput): void {
  if (!input.student_id) throw new Error("缺少学生");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.homework_date)) throw new Error("日期格式应为 YYYY-MM-DD");
  if (input.homework_date > localDateStr()) throw new Error("不能录入未来日期");
  const subject = (input.subject ?? "").trim();
  if (!subject) throw new Error("科目不能为空");
  if (!isHomeworkStatus(input.status)) throw new Error("作业状态不合法");
  const comment = (input.comment ?? "").trim();
  if (comment.length > 200) throw new Error("备注请控制在 200 字以内");
  if (input.score !== undefined && input.score !== null) {
    if (typeof input.score !== "number" || Number.isNaN(input.score)) throw new Error("分数应为数字");
    if (input.score < 0 || input.score > 100) throw new Error("分数应在 0~100 之间");
  }
}

/** 归一化入库载荷：去首尾空格，空串转默认值 */
export function normalizeHomeworkInput(input: HomeworkInput): Required<Pick<HomeworkInput, "subject">> & HomeworkInput {
  return {
    ...input,
    subject: input.subject.trim(),
    comment: (input.comment ?? "").trim() ? (input.comment ?? "").trim() : null,
    score: input.score ?? null,
  };
}

/** 按日期区间过滤（含两端）；起止为空视为不过滤该端 */
export function filterHomeworksByRange(
  rows: StudentHomeworkRecord[],
  start: string,
  end: string
): StudentHomeworkRecord[] {
  return rows.filter((r) => {
    if (start && r.homework_date < start) return false;
    if (end && r.homework_date > end) return false;
    return true;
  });
}

/** 区间汇总：计数 + 按时率 + 按科目分布 */
export function summarizeHomeworks(rows: StudentHomeworkRecord[]): HomeworkSummary {
  const summary: HomeworkSummary = {
    total: rows.length,
    excellent: 0,
    done: 0,
    late: 0,
    missing: 0,
    exempt: 0,
    onTimeRate: null,
    bySubject: {},
  };
  for (const r of rows) {
    if (r.status === "excellent") summary.excellent += 1;
    else if (r.status === "done") summary.done += 1;
    else if (r.status === "late") summary.late += 1;
    else if (r.status === "missing") summary.missing += 1;
    else if (r.status === "exempt") summary.exempt += 1;
    const key = (r.subject || "未分科").trim() || "未分科";
    summary.bySubject[key] = (summary.bySubject[key] ?? 0) + 1;
  }
  const denom = summary.total - summary.exempt;
  if (denom > 0) {
    summary.onTimeRate = (summary.excellent + summary.done) / denom;
  }
  return summary;
}

/** 汇总一句话（报告与界面共用）：无数据返回空串 */
export function buildHomeworkSummary(rows: StudentHomeworkRecord[]): string {
  if (!rows.length) return "";
  const s = summarizeHomeworks(rows);
  const rate = s.onTimeRate === null ? "—" : `${Math.round(s.onTimeRate * 100)}%`;
  const parts = [`共 ${s.total} 次`, `按时率 ${rate}`];
  if (s.excellent) parts.push(`优秀 ${s.excellent}`);
  if (s.late) parts.push(`迟交 ${s.late}`);
  if (s.missing) parts.push(`缺交 ${s.missing}`);
  const subjects = Object.entries(s.bySubject)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}${v}次`)
    .join("、");
  if (subjects) parts.push(subjects);
  return parts.join("，");
}
