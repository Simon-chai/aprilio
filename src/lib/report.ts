/**
 * 评价报告聚合纯函数：区间解析 / 标题 / 数据版报告。
 * 只做计算不调 LLM；AI 版见 report-ai.ts。
 */
import type { ReportRange } from "../types";

/** 学期大致起止（与 currentSemester 口径对齐：9~2月秋季，3~8月春季） */
export function semesterDateRange(semester: string): [string, string] {
  const match = /^(\d{4})-(\d{4})-([12])$/.exec(semester.trim());
  if (!match) throw new Error("学期号格式应为 YYYY-YYYY-1/2");
  const startYear = Number(match[1]);
  const term = match[3];
  if (term === "1") {
    return [`${startYear}-09-01`, `${startYear + 1}-02-28`];
  }
  return [`${startYear + 1}-03-01`, `${startYear + 1}-08-31`];
}

export function resolveReportRange(input: {
  mode: "semester" | "custom";
  semester?: string;
  start?: string;
  end?: string;
}): ReportRange {
  if (input.mode === "semester") {
    const semester = (input.semester ?? "").trim();
    if (!/^\d{4}-\d{4}-[12]$/.test(semester)) throw new Error("请选择学期");
    const [start, end] = semesterDateRange(semester);
    return { mode: "semester", semester, start, end };
  }
  const start = (input.start ?? "").trim();
  const end = (input.end ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("起始日期格式应为 YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("结束日期格式应为 YYYY-MM-DD");
  if (start > end) throw new Error("起始日期不能晚于结束日期");
  return { mode: "custom", semester: null, start, end };
}

/** 报告标题：学期模式用学期标签，自定义用日期区间 */
export function buildReportTitle(range: ReportRange, studentName: string): string {
  if (range.mode === "semester" && range.semester) {
    return `${studentName} ${range.semester} 评价报告`;
  }
  return `${studentName} ${range.start}~${range.end} 评价报告`;
}

export interface ReportSummaries {
  scoreSummary: string;
  behaviorSummary: string;
  homeworkSummary: string;
  examCount: number;
  praiseCount: number;
  improveCount: number;
}

/** 数据版报告 markdown（无 AI 时直接用它存档打印） */
export function buildDataReportMarkdown(
  studentName: string,
  range: ReportRange,
  summaries: ReportSummaries
): string {
  const rangeText =
    range.mode === "semester" && range.semester
      ? `学期 ${range.semester}（${range.start}~${range.end}）`
      : `${range.start}~${range.end}`;
  const lines = [
    `# ${studentName} 评价报告`,
    ``,
    `时间范围：${rangeText}`,
    ``,
    `## 学业表现`,
    summaries.scoreSummary ? summaries.scoreSummary : "本区间暂无成绩数据。",
    summaries.examCount ? `（共 ${summaries.examCount} 次考试）` : "",
    ``,
    `## 行为习惯`,
    summaries.behaviorSummary
      ? `${summaries.behaviorSummary}（表扬 ${summaries.praiseCount} · 待改进 ${summaries.improveCount}）`
      : "本区间暂无表现记录。",
    ``,
    `## 作业情况`,
    summaries.homeworkSummary ? summaries.homeworkSummary : "本区间暂无作业记录。",
    ``,
    `## 给家长的建议`,
    `建议结合以上学业与习惯表现，和孩子一起定一个小目标，保持家校沟通。`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** 短评语兜底：有摘要拼一句，无数据返回空串 */
export function buildFallbackShortComment(summaries: ReportSummaries): string {
  const parts: string[] = [];
  if (summaries.scoreSummary) parts.push(summaries.scoreSummary.slice(0, 60));
  if (summaries.homeworkSummary) parts.push(summaries.homeworkSummary.slice(0, 40));
  const text = parts.join("；");
  return text.length > 120 ? text.slice(0, 120) : text;
}
