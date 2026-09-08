/**
 * 内置分析器：成绩分析（AnalysisProvider 实现）。
 *
 * 把「班级成绩 / 个人成绩」的结构化统计能力登记进分析引擎，Agent 的 analyze 工具
 * 按 kind 路由到这里，即可随时对成绩数据做汇总、排名、趋势与偏科诊断。
 * 口径与界面共用 lib/score-analysis.ts，保证「助手说的数字」=「界面看到的数字」。
 *
 * 支持的 kind：
 * - `score_overview` / `score_class`：某班最近一次（或指定）考试的班级统计 + 总分排名
 * - `score_student`：某学生的历次成绩、单科强弱、总分排名与进退步
 * - `score_rank`：某班某次考试的总分排行榜
 * - `score_trend`：成绩走势——传 student_id/姓名 → 个人总分走势；传 class_name → 班级多次考试趋势
 */
import {
  getClassScoreOverview,
  getClassScoreTrend,
  getExamScores,
  getStudentScoreReport,
  listStudents,
} from "../../../lib/db";
import {
  averageOfSubjectAverages,
  computeExamStats,
  formatNumber,
  formatRate,
  round1,
} from "../../../lib/score-analysis";
import { defaultAnalysisEngine } from "../engine";
import type {
  AnalysisEngine,
  AnalysisProvider,
  AnalysisQuery,
  AnalysisResult,
} from "../types";

/** 本分析器支持的查询类型 */
export const SCORE_ANALYSIS_KINDS = [
  "score_overview",
  "score_class",
  "score_student",
  "score_rank",
  "score_trend",
] as const;

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

/** 按 ID 或「姓名（可带班级）」定位学生 */
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

/** 班级成绩总览 / 排名 */
async function analyzeClass(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const className = str(payload.class_name);
  if (!className) {
    return {
      ok: false,
      summary: "",
      error: "缺少 class_name：请先说明要分析哪个班级（可先用 query_data 的 exams 实体查看有哪些班级/考试）。",
    };
  }

  const { exams, rows } = await getClassScoreOverview(className);
  if (!exams.length) {
    return { ok: false, summary: "", error: `班级「${className}」还没有成绩数据。` };
  }

  const examId = num(payload.exam_id);
  const exam = examId ? (exams.find((e) => e.id === examId) ?? exams[0]) : exams[0];
  const examRows = await getExamScores(exam.id);
  const stats = computeExamStats(examRows);

  const ranked = rows
    .map((r) => ({ name: r.student_name, total: r.cells[exam.id]?.score ?? null }))
    .filter((r): r is { name: string; total: number } => r.total !== null)
    .sort((a, b) => b.total - a.total);

  const top = ranked.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} ${formatNumber(r.total)}`);
  const bottom = ranked.length > 5 ? ranked[ranked.length - 1] : null;
  const subjectLine = stats.subjects
    .map((s) => `${s.subject} ${formatNumber(s.average)}`)
    .join("、");

  const summary = [
    `${className}「${exam.name}」（${exam.exam_date}）`,
    `参考 ${stats.student_count} 人，平均总分 ${formatNumber(stats.total_average)}，最高 ${formatNumber(stats.total_max)}，最低 ${formatNumber(stats.total_min)}`,
    `及格率 ${formatRate(stats.total_pass_rate)}，优秀率 ${formatRate(stats.total_excellent_rate)}`,
    subjectLine ? `各科平均：${subjectLine}` : "",
    top.length ? `总分排名（前 ${top.length}）：${top.join("；")}` : "",
    bottom ? `末位：${bottom.name} ${formatNumber(bottom.total)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok: true,
    summary,
    data: { class_name: className, exam, stats, ranking: ranked },
  };
}

/** 学生成绩报告 */
async function analyzeStudent(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const studentId = await resolveStudentId(payload);
  if (!studentId) {
    return {
      ok: false,
      summary: "",
      error: "缺少学生定位：请提供 student_id，或提供唯一的学生姓名（重名时请带 class_name）。",
    };
  }
  const report = await getStudentScoreReport(studentId);
  if (!report || !report.exams.length) {
    return { ok: false, summary: "", error: "该学生还没有成绩记录。" };
  }

  const latest = report.exams[0];
  const lines: string[] = [
    `${report.student_name}（${report.student_no}，${report.grade_class || "未分班"}）共 ${report.exams.length} 次考试：`,
  ];
  for (const exam of report.exams) {
    const totalText = exam.total !== null ? formatNumber(exam.total) : (exam.total_grade ?? "—");
    const rankText =
      exam.class_total_rank !== null
        ? `，班级第 ${exam.class_total_rank}/${exam.class_student_count} 名`
        : "";
    const deltaText =
      exam.total_delta !== null
        ? `，较上次${exam.total_delta > 0 ? "进步" : exam.total_delta < 0 ? "退步" : "持平"} ${formatNumber(Math.abs(exam.total_delta))}`
        : "";
    const subjectText = exam.subjects
      .map((s) => `${s.subject} ${s.score !== null ? s.score : (s.grade ?? "—")}`)
      .join("、");
    lines.push(`- ${exam.exam_name}（${exam.exam_date}）：${subjectText}；总分 ${totalText}${rankText}${deltaText}`);
  }

  // 偏科诊断：最近一次考试中低于班均最多的科目 / 高于班均最多的科目
  const compared = latest.subjects.filter((s) => s.score !== null && s.class_average !== null);
  if (compared.length) {
    const withDiff = compared.map((s) => ({ s, diff: round1((s.score as number) - (s.class_average as number)) }));
    const weakest = [...withDiff].sort((a, b) => a.diff - b.diff)[0];
    const strongest = [...withDiff].sort((a, b) => b.diff - a.diff)[0];
    lines.push(
      `最近一次：相对班均最强的科目是「${strongest.s.subject}」（${strongest.diff >= 0 ? "+" : ""}${formatNumber(strongest.diff)}），` +
        `最需要关注的是「${weakest.s.subject}」（${weakest.diff >= 0 ? "+" : ""}${formatNumber(weakest.diff)}）。`,
    );
  }

  return { ok: true, summary: lines.join("\n"), data: report };
}

/** 总分排行榜 */
async function analyzeRank(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const className = str(payload.class_name);
  if (!className) {
    return { ok: false, summary: "", error: "缺少 class_name：请说明要排名的班级。" };
  }
  const { exams, rows } = await getClassScoreOverview(className);
  if (!exams.length) {
    return { ok: false, summary: "", error: `班级「${className}」还没有成绩数据。` };
  }
  const examId = num(payload.exam_id);
  const exam = examId ? (exams.find((e) => e.id === examId) ?? exams[0]) : exams[0];
  const ranked = rows
    .map((r) => ({ student_id: r.student_id, name: r.student_name, total: r.cells[exam.id]?.score ?? null }))
    .filter((r): r is { student_id: number; name: string; total: number } => r.total !== null)
    .sort((a, b) => b.total - a.total);

  const lines = ranked.map((r, i) => `${i + 1}. ${r.name} ${formatNumber(r.total)}`);
  return {
    ok: true,
    summary: `${className}「${exam.name}」（${exam.exam_date}）总分排名（共 ${ranked.length} 人）：\n${lines.join("\n")}`,
    data: { class_name: className, exam, ranking: ranked },
  };
}

/** 班级多次考试趋势（平均单科分 / 及格率 / 优秀率逐次变化） */
async function analyzeClassTrend(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const className = str(payload.class_name);
  if (!className) {
    return {
      ok: false,
      summary: "",
      error: "缺少定位：班级趋势请提供 class_name，个人趋势请提供 student_id 或姓名。",
    };
  }
  const trend = await getClassScoreTrend(className);
  if (!trend.length) {
    return { ok: false, summary: "", error: `班级「${className}」还没有成绩数据。` };
  }

  const lines = trend.map((point) => {
    const avg = averageOfSubjectAverages(point.stats);
    return `${point.exam.exam_date} ${point.exam.name}：平均单科分 ${formatNumber(avg)}，及格率 ${formatRate(
      point.stats.total_pass_rate,
    )}，优秀率 ${formatRate(point.stats.total_excellent_rate)}`;
  });

  const first = averageOfSubjectAverages(trend[0].stats);
  const last = averageOfSubjectAverages(trend[trend.length - 1].stats);
  const delta = round1(last - first);
  const deltaText =
    trend.length > 1
      ? `\n从「${trend[0].exam.name}」到「${trend[trend.length - 1].exam.name}」，平均单科分${
          delta > 0 ? `上升 ${formatNumber(delta)}` : delta < 0 ? `下降 ${formatNumber(Math.abs(delta))}` : "持平"
        }。`
      : "";

  return {
    ok: true,
    summary: `${className} 成绩趋势（共 ${trend.length} 次考试）：\n${lines.join("\n")}${deltaText}`,
    data: trend,
  };
}

/** 学生总分走势 */
async function analyzeTrend(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const studentId = await resolveStudentId(payload);
  if (!studentId) {
    return { ok: false, summary: "", error: "缺少学生定位：请提供 student_id 或唯一姓名。" };
  }
  const report = await getStudentScoreReport(studentId);
  if (!report || !report.exams.length) {
    return { ok: false, summary: "", error: "该学生还没有成绩记录。" };
  }
  // 由近及远 → 由远及近展示走势
  const ordered = [...report.exams].reverse();
  const lines = ordered.map((e) => {
    const totalText = e.total !== null ? formatNumber(e.total) : (e.total_grade ?? "—");
    const rankText = e.class_total_rank !== null ? `（班级第 ${e.class_total_rank}）` : "";
    return `${e.exam_date} ${e.exam_name}：${totalText}${rankText}`;
  });
  return {
    ok: true,
    summary: `${report.student_name} 总分走势：\n${lines.join("\n")}`,
    data: { student: report.student_name, exams: ordered },
  };
}

export function createScoreAnalysisProvider(): AnalysisProvider {
  return {
    id: "score-analysis",
    name: "成绩分析",
    description: "班级成绩统计、总分排名、学生成绩报告与走势分析。",
    priority: 50,
    supports: (query: AnalysisQuery) =>
      (SCORE_ANALYSIS_KINDS as readonly string[]).includes(query.kind),
    analyze: async (query: AnalysisQuery): Promise<AnalysisResult> => {
      const payload = asRecord(query.payload);
      switch (query.kind) {
        case "score_overview":
        case "score_class":
          return analyzeClass(payload);
        case "score_student":
          return analyzeStudent(payload);
        case "score_rank":
          return analyzeRank(payload);
        case "score_trend": {
          // 有学生定位 → 个人总分走势；否则按班级多次考试趋势
          const hasStudent = num(payload.student_id) !== undefined || str(payload.name) !== "";
          return hasStudent ? analyzeTrend(payload) : analyzeClassTrend(payload);
        }
        default:
          return { ok: false, summary: "", error: `不支持的成绩分析类型：${query.kind}` };
      }
    },
  };
}

/** 把成绩分析器注册进分析引擎（幂等：重复调用只是覆盖同 id 分析器） */
export function registerScoreAnalysisProvider(
  engine: AnalysisEngine = defaultAnalysisEngine,
): () => void {
  return engine.register(createScoreAnalysisProvider());
}
