/**
 * 内置分析器：评价报告只读汇总（Agent 用）。
 * 不调 LLM，只做区间统计，数字与界面同口径。
 */
import {
  getStudentScoreReport,
  listBehaviorRecords,
  listHomeworkRecords,
  listStudents,
} from "../../../lib/db";
import { buildBehaviorSummary } from "../../../lib/comment-ai";
import { buildHomeworkSummary } from "../../../lib/homework";
import { buildScoreSummary } from "../../../lib/comment-ai";
import { resolveReportRange } from "../../../lib/report";
import { currentSemester } from "../../../lib/timetable";
import { defaultAnalysisEngine } from "../engine";
import type { AnalysisEngine, AnalysisProvider, AnalysisQuery, AnalysisResult } from "../types";

export const REPORT_ANALYSIS_KINDS = ["student_eval_report"] as const;

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function resolveStudentId(payload: Record<string, unknown>): Promise<number | null> {
  const byId = num(payload.student_id);
  if (byId) return byId;
  const name = str(payload.name);
  if (!name) return null;
  const className = str(payload.class_name);
  const all = await listStudents(name);
  const exact = all.filter((s) => s.name === name);
  const inClass = className ? exact.filter((s) => s.grade_class === className) : exact;
  if (inClass.length === 1) return inClass[0].id;
  return exact.length === 1 ? exact[0].id : null;
}

async function analyzeEvalReport(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const studentId = await resolveStudentId(payload);
  if (!studentId) {
    return { ok: false, summary: "", error: "缺少学生定位：请提供 student_id，或唯一姓名（重名带 class_name）。" };
  }
  let range;
  try {
    const semester = str(payload.semester);
    if (semester) {
      range = resolveReportRange({ mode: "semester", semester });
    } else if (str(payload.start) && str(payload.end)) {
      range = resolveReportRange({ mode: "custom", start: str(payload.start), end: str(payload.end) });
    } else {
      range = resolveReportRange({ mode: "semester", semester: currentSemester() });
    }
  } catch (e) {
    return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
  }

  const [scoreReport, behaviors, homeworks] = await Promise.all([
    getStudentScoreReport(studentId),
    listBehaviorRecords(studentId, 500),
    listHomeworkRecords(studentId, { start: range.start, end: range.end, limit: 500 }),
  ]);
  if (!scoreReport) return { ok: false, summary: "", error: "找不到该学生。" };

  const inRange = (d: string) => d >= range.start && d <= range.end;
  const rangeExams = scoreReport.exams.filter((e) => inRange(e.exam_date));
  const rangeBehaviors = behaviors.filter((b) => inRange(b.recorded_date));

  const examMap = new Map<
    number,
    { exam_name: string; subjects: { subject: string; score: number | null; grade: string | null }[] }
  >();
  for (const s of await import("../../../lib/db").then((m) => m.listStudentExamScores(studentId))) {
    if (!inRange(s.exam_date)) continue;
    const row = examMap.get(s.exam_id) ?? { exam_name: s.exam_name, subjects: [] };
    row.subjects.push({ subject: s.subject, score: s.score, grade: s.grade });
    examMap.set(s.exam_id, row);
  }
  const scoreSummary = buildScoreSummary([...examMap.values()]);
  const behaviorSummary = buildBehaviorSummary(
    rangeBehaviors.map((b) => ({ type: b.type, dimension_name_snap: b.dimension_name_snap, comment: b.comment }))
  );
  const homeworkSummary = buildHomeworkSummary(homeworks);

  const lines = [
    `${scoreReport.student_name} ${range.semester ?? `${range.start}~${range.end}`} 评价汇总：`,
    `成绩：${scoreSummary || "暂无" }（${rangeExams.length} 次考试）`,
    `表现：${behaviorSummary || "暂无"}（共 ${rangeBehaviors.length} 条）`,
    `作业：${homeworkSummary || "暂无"}（共 ${homeworks.length} 条）`,
  ];
  return {
    ok: true,
    summary: lines.join("\n"),
    data: { student_id: studentId, range, scoreSummary, behaviorSummary, homeworkSummary },
  };
}

export function createReportAnalysisProvider(): AnalysisProvider {
  return {
    id: "report-analysis",
    name: "评价报告汇总",
    description: "按区间汇总学生成绩/表现/作业，供评价报告生成取数。",
    priority: 46,
    supports: (query: AnalysisQuery) => (REPORT_ANALYSIS_KINDS as readonly string[]).includes(query.kind),
    analyze: async (query: AnalysisQuery): Promise<AnalysisResult> => {
      const payload = asRecord(query.payload);
      if (query.kind === "student_eval_report") return analyzeEvalReport(payload);
      return { ok: false, summary: "", error: `不支持的报告分析类型：${query.kind}` };
    },
  };
}

export function registerReportAnalysisProvider(engine: AnalysisEngine = defaultAnalysisEngine): () => void {
  return engine.register(createReportAnalysisProvider());
}
