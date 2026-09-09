/**
 * 内置分析器：学期汇总（AnalysisProvider 实现）。
 *
 * 把「某班某学期 / 某生某学期」的成绩与表现汇总能力登记进分析引擎，
 * 供 Agent 的 analyze 工具按 kind 路由。学期归属由日期实时推导（`semesterOfDate`），
 * 与界面学期切换口径一致；成绩统计复用 `lib/score-analysis.ts`。
 *
 * 支持的 kind：
 * - `semester_overview`：某班某学期——各次考试单科均分/及格率/优秀率、班级人数
 * - `student_term_report`：某生某学期——历次考试（总分/排名/进退步）+ 表现记录汇总
 */
import {
  getClassScoreTrend,
  getStudentScoreReport,
  listBehaviorRecords,
  listStudents,
} from "../../../lib/db";
import { semesterOfDate } from "../../../lib/semester";
import { currentSemester, semesterLabel } from "../../../lib/timetable";
import {
  averageOfSubjectAverages,
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

export const SEMESTER_ANALYSIS_KINDS = ["semester_overview", "student_term_report"] as const;

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

/** 学期参数：缺省当前学期 */
function semesterArg(payload: Record<string, unknown>): string {
  const raw = str(payload.semester);
  return /^\d{4}-\d{4}-[12]$/.test(raw) ? raw : currentSemester();
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

/** 班级某学期汇总 */
async function analyzeSemesterOverview(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const className = str(payload.class_name);
  if (!className) {
    return {
      ok: false,
      summary: "",
      error: "缺少 class_name：请说明要汇总哪个班级的哪个学期（可先用 query_data 的 classes 实体查看班级）。",
    };
  }
  const semester = semesterArg(payload);

  const trend = await getClassScoreTrend(className);
  const exams = trend.filter((point) => semesterOfDate(point.exam.exam_date) === semester);
  const students = (await listStudents("", className)).filter((s) => s.grade_class === className);

  if (!exams.length) {
    return {
      ok: false,
      summary: "",
      error: `班级「${className}」在${semesterLabel(semester)}没有成绩数据。`,
    };
  }

  const lines = exams.map((point) => {
    const avg = averageOfSubjectAverages(point.stats);
    return `- ${point.exam.name}（${point.exam.exam_date}）：平均单科分 ${formatNumber(avg)}，及格率 ${formatRate(
      point.stats.total_pass_rate,
    )}，优秀率 ${formatRate(point.stats.total_excellent_rate)}，参考 ${point.stats.student_count} 人`;
  });

  const firstAvg = averageOfSubjectAverages(exams[0].stats);
  const lastAvg = averageOfSubjectAverages(exams[exams.length - 1].stats);
  const delta = round1(lastAvg - firstAvg);
  const deltaText =
    exams.length > 1
      ? `\n学期内平均单科分${
          delta > 0 ? `上升 ${formatNumber(delta)}` : delta < 0 ? `下降 ${formatNumber(Math.abs(delta))}` : "基本持平"
        }。`
      : "";

  return {
    ok: true,
    summary: `${className} ${semesterLabel(semester)} 汇总（共 ${exams.length} 次考试，班级 ${students.length} 人）：\n${lines.join(
      "\n",
    )}${deltaText}`,
    data: {
      class_name: className,
      semester,
      student_count: students.length,
      exams: exams.map((point) => ({ exam: point.exam, stats: point.stats })),
    },
  };
}

/** 学生某学期轨迹 */
async function analyzeStudentTerm(payload: Record<string, unknown>): Promise<AnalysisResult> {
  const studentId = await resolveStudentId(payload);
  if (!studentId) {
    return {
      ok: false,
      summary: "",
      error: "缺少学生定位：请提供 student_id，或提供唯一的学生姓名（重名时请带 class_name）。",
    };
  }
  const semester = semesterArg(payload);

  const report = await getStudentScoreReport(studentId);
  if (!report) {
    return { ok: false, summary: "", error: "找不到该学生。" };
  }
  const exams = report.exams.filter((e) => semesterOfDate(e.exam_date) === semester);
  const behaviors = (await listBehaviorRecords(studentId, 200)).filter(
    (b) => semesterOfDate(b.recorded_date) === semester,
  );

  if (!exams.length && !behaviors.length) {
    return {
      ok: false,
      summary: "",
      error: `「${report.student_name}」在${semesterLabel(semester)}没有成绩或表现记录。`,
    };
  }

  const lines: string[] = [
    `${report.student_name}（${report.student_no}，${report.grade_class || "未分班"}）${semesterLabel(semester)}：`,
  ];
  for (const exam of exams) {
    const totalText = exam.total !== null ? formatNumber(exam.total) : (exam.total_grade ?? "—");
    const rankText =
      exam.class_total_rank !== null
        ? `，班级第 ${exam.class_total_rank}/${exam.class_student_count} 名`
        : "";
    const subjectText = exam.subjects
      .map((s) => `${s.subject} ${s.score !== null ? s.score : (s.grade ?? "—")}`)
      .join("、");
    lines.push(`- ${exam.exam_name}（${exam.exam_date}）：${subjectText}；总分 ${totalText}${rankText}`);
  }
  const praise = behaviors.filter((b) => b.type === "praise").length;
  const improve = behaviors.filter((b) => b.type === "improve").length;
  if (behaviors.length) {
    lines.push(`表现记录 ${behaviors.length} 条（表扬 ${praise} · 待改进 ${improve}）`);
    for (const b of behaviors.slice(0, 5)) {
      lines.push(`  · [${b.recorded_date}] ${b.dimension_name_snap}：${b.comment}`);
    }
  }

  return {
    ok: true,
    summary: lines.join("\n"),
    data: { student: report.student_name, semester, exams, behaviors },
  };
}

export function createSemesterAnalysisProvider(): AnalysisProvider {
  return {
    id: "semester-analysis",
    name: "学期汇总",
    description: "按学期汇总班级成绩与表现、学生学期轨迹。",
    priority: 45,
    supports: (query: AnalysisQuery) =>
      (SEMESTER_ANALYSIS_KINDS as readonly string[]).includes(query.kind),
    analyze: async (query: AnalysisQuery): Promise<AnalysisResult> => {
      const payload = asRecord(query.payload);
      switch (query.kind) {
        case "semester_overview":
          return analyzeSemesterOverview(payload);
        case "student_term_report":
          return analyzeStudentTerm(payload);
        default:
          return { ok: false, summary: "", error: `不支持的学期分析类型：${query.kind}` };
      }
    },
  };
}

/** 把学期分析器注册进分析引擎（幂等：重复调用只是覆盖同 id 分析器） */
export function registerSemesterAnalysisProvider(
  engine: AnalysisEngine = defaultAnalysisEngine,
): () => void {
  return engine.register(createSemesterAnalysisProvider());
}
