/**
 * 考试与成绩域（拆分自 db.ts）：批次（考试名 + 考试时间）→ 学生 × 科目成绩。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { getStudent } from "./students";
import {
  computeExamStats,
  computeStudentTotals,
  inferExamType,
  rankBySubject,
  rankByTotal,
  subjectAverages,
  trendOf,
} from "../score-analysis";
import { scoreLines } from "../score-config";
import type {
  ClassExamTrendPoint,
  ClassScoreOverviewRow,
  Exam,
  ExamInput,
  ExamScore,
  ExamScoreRow,
  ExamType,
  ExamWithStats,
  StudentExamReport,
  StudentExamScore,
  StudentExamSubject,
  StudentScoreReport,
} from "../../types";

/* ------------------------------------------------------------------ */
/* 考试与成绩：批次（考试名 + 考试时间）→ 学生 × 科目成绩                  */
/* ------------------------------------------------------------------ */

/** 考试时间校验：YYYY-MM-DD（导入管道已归一化，这里兜底防脏数据入库） */
function assertExamDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("考试时间格式应为 YYYY-MM-DD");
}

/**
 * 考试批次归属班级校验：成绩必须挂在具体班级下。
 *
 * 空班级 /「未分班」会让班级成绩页（按 exam.class_name 过滤）查不到数据——
 * 数据在库里但界面没有任何入口能看到（历史事故：导入时没有班级上下文，
 * 批次落在「未分班」，班级面板 0 条、助手却能从全局查到）。所有写入口一律
 * 拒绝，宁可报错让调用方去要班级，也不产生"看不见的成绩"。
 */
function assertExamClassName(className: string | null | undefined): string {
  const name = (className ?? "").trim();
  if (!name || name === "未分班") {
    throw new Error("考试批次必须归属一个班级（不能为空或「未分班」）：请先选择成绩所属班级");
  }
  return name;
}

/** 新建考试批次。返回新考试 id。 */
export async function createExam(input: ExamInput): Promise<number> {
  const name = input.name.trim();
  if (!name) throw new Error("考试名称不能为空");
  const className = assertExamClassName(input.class_name);
  assertExamDate(input.exam_date);
  const examType = input.exam_type ?? inferExamType(name);

  if (!isTauri()) {
    const store = mem();
    const id = store.nextExamId++;
    const ts = now();
    store.exams.push({
      id,
      class_name: className,
      name,
      exam_date: input.exam_date,
      exam_type: examType,
      note: input.note ?? null,
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO exams (class_name, name, exam_date, exam_type, note) VALUES (?, ?, ?, ?, ?)",
    [className, name, input.exam_date, examType, input.note ?? null]
  );
  return Number(result.lastInsertId ?? 0);
}

/** 按「班级 + 考试名 + 考试时间」查考试（重复导入不产生重复批次） */
export async function findExam(className: string, name: string, examDate: string): Promise<Exam | null> {
  if (!isTauri()) {
    return (
      mem().exams.find(
        (e) => e.class_name === className && e.name === name && e.exam_date === examDate
      ) ?? null
    );
  }
  const db = await getDb();
  const rows = await db.select<Exam[]>(
    "SELECT * FROM exams WHERE class_name = ? AND name = ? AND exam_date = ? LIMIT 1",
    [className, name, examDate]
  );
  return rows[0] ?? null;
}

/** 查或建考试批次（幂等）：同班同名同时间复用既有批次 */
export async function findOrCreateExam(input: ExamInput): Promise<{ exam: Exam; created: boolean }> {
  const name = input.name.trim();
  if (!name) throw new Error("考试名称不能为空");
  const className = assertExamClassName(input.class_name);
  assertExamDate(input.exam_date);

  const existing = await findExam(className, name, input.exam_date);
  if (existing) return { exam: existing, created: false };
  const id = await createExam({ ...input, class_name: className });
  return {
    exam: {
      id,
      class_name: className,
      name,
      exam_date: input.exam_date,
      exam_type: input.exam_type ?? inferExamType(name),
      note: input.note ?? null,
      created_at: "",
      updated_at: "",
    },
    created: true,
  };
}

/** 班级考试列表（带成绩统计，按考试时间倒序） */
export async function listExamsByClass(className: string): Promise<ExamWithStats[]> {
  if (!isTauri()) {
    const store = mem();
    return store.exams
      .filter((e) => e.class_name === className)
      .map((e) => {
        const scores = store.examScores.filter((s) => s.exam_id === e.id);
        return {
          ...e,
          subject_count: new Set(scores.map((s) => s.subject)).size,
          score_count: scores.length,
          student_count: new Set(scores.map((s) => s.student_id)).size,
        };
      })
      .sort((a, b) => (a.exam_date === b.exam_date ? b.id - a.id : a.exam_date < b.exam_date ? 1 : -1));
  }
  const db = await getDb();
  return db.select<ExamWithStats[]>(
    `SELECT e.*,
            (SELECT COUNT(DISTINCT subject)    FROM exam_scores sc WHERE sc.exam_id = e.id) AS subject_count,
            (SELECT COUNT(*)                   FROM exam_scores sc WHERE sc.exam_id = e.id) AS score_count,
            (SELECT COUNT(DISTINCT student_id) FROM exam_scores sc WHERE sc.exam_id = e.id) AS student_count
       FROM exams e
      WHERE e.class_name = ?
      ORDER BY e.exam_date DESC, e.id DESC`,
    [className]
  );
}

export async function getExam(examId: number): Promise<Exam | null> {
  if (!isTauri()) {
    return mem().exams.find((e) => e.id === examId) ?? null;
  }
  const db = await getDb();
  const rows = await db.select<Exam[]>("SELECT * FROM exams WHERE id = ?", [examId]);
  return rows[0] ?? null;
}

/** 更新考试批次信息（考试名 / 时间 / 种类 / 备注） */
export async function updateExam(
  examId: number,
  patch: { name?: string; exam_date?: string; exam_type?: ExamType; note?: string | null }
): Promise<void> {
  if (patch.name !== undefined && !patch.name.trim()) throw new Error("考试名称不能为空");
  if (patch.exam_date !== undefined) assertExamDate(patch.exam_date);

  if (!isTauri()) {
    const store = mem();
    const exam = store.exams.find((e) => e.id === examId);
    if (!exam) return;
    if (patch.name !== undefined) exam.name = patch.name.trim();
    if (patch.exam_date !== undefined) exam.exam_date = patch.exam_date;
    if (patch.exam_type !== undefined) exam.exam_type = patch.exam_type;
    if (patch.note !== undefined) exam.note = patch.note;
    exam.updated_at = now();
    return;
  }

  const db = await getDb();
  const exam = await getExam(examId);
  if (!exam) return;
  const name = patch.name !== undefined ? patch.name.trim() : exam.name;
  const date = patch.exam_date !== undefined ? patch.exam_date : exam.exam_date;
  const type = patch.exam_type !== undefined ? patch.exam_type : exam.exam_type;
  const note = patch.note !== undefined ? patch.note : exam.note;
  await db.execute(
    "UPDATE exams SET name = ?, exam_date = ?, exam_type = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [name, date, type, note, examId]
  );
}

/** 删除考试批次（成绩随之清除；不影响学生档案） */
export async function deleteExam(examId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.examScores = store.examScores.filter((s) => s.exam_id !== examId);
    store.exams = store.exams.filter((e) => e.id !== examId);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM exam_scores WHERE exam_id = ?", [examId]);
  await db.execute("DELETE FROM exams WHERE id = ?", [examId]);
}

/** 写入/覆盖一条成绩（考试 × 学生 × 科目 唯一，重复导入天然幂等） */
export async function upsertExamScore(
  examId: number,
  studentId: number,
  subject: string,
  score: number | null,
  grade: string | null
): Promise<void> {
  const subj = subject.trim();
  if (!subj) throw new Error("科目名不能为空");
  if (score === null && (grade === null || !grade.trim())) {
    throw new Error("成绩内容为空（分数与等级至少填一项）");
  }

  if (!isTauri()) {
    const store = mem();
    const existing = store.examScores.find(
      (s) => s.exam_id === examId && s.student_id === studentId && s.subject === subj
    );
    if (existing) {
      existing.score = score;
      existing.grade = grade === null ? null : grade.trim();
      existing.updated_at = now();
      return;
    }
    store.examScores.push({
      id: store.nextExamScoreId++,
      exam_id: examId,
      student_id: studentId,
      subject: subj,
      score,
      grade: grade === null ? null : grade.trim(),
      created_at: now(),
      updated_at: now(),
    });
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO exam_scores (exam_id, student_id, subject, score, grade)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(exam_id, student_id, subject) DO UPDATE SET
       score = excluded.score,
       grade = excluded.grade,
       updated_at = datetime('now','localtime')`,
    [examId, studentId, subj, score, grade === null ? null : grade.trim()]
  );
}

/** 删除一条成绩（改分纠错时清空某科；不存在则静默返回） */
export async function deleteExamScore(
  examId: number,
  studentId: number,
  subject: string
): Promise<void> {
  const subj = subject.trim();
  if (!subj) return;
  if (!isTauri()) {
    const store = mem();
    store.examScores = store.examScores.filter(
      (s) => !(s.exam_id === examId && s.student_id === studentId && s.subject === subj)
    );
    return;
  }
  const db = await getDb();
  await db.execute(
    "DELETE FROM exam_scores WHERE exam_id = ? AND student_id = ? AND subject = ?",
    [examId, studentId, subj]
  );
}

/** 一次考试的全部成绩（联学生姓名/学号，考试明细表用） */
export async function getExamScores(examId: number): Promise<ExamScoreRow[]> {
  if (!isTauri()) {
    const store = mem();
    return store.examScores
      .filter((s) => s.exam_id === examId)
      .map((s) => {
        const student = store.students.find((st) => st.id === s.student_id);
        return {
          ...s,
          student_name: student?.name ?? "",
          student_no: student?.student_no ?? null,
        };
      })
      .sort((a, b) => a.student_name.localeCompare(b.student_name, "zh") || a.id - b.id);
  }
  const db = await getDb();
  const rows = await db.select<ExamScoreRow[]>(
    `SELECT sc.*, s.name AS student_name, s.student_no
       FROM exam_scores sc
       INNER JOIN students s ON sc.student_id = s.id
      WHERE sc.exam_id = ?
      ORDER BY sc.id ASC`,
    [examId]
  );
  return rows.sort((a, b) => a.student_name.localeCompare(b.student_name, "zh") || a.id - b.id);
}

/** 某个学生的全部成绩（联考试信息，学生档案成绩区用，按考试时间倒序） */
export async function listStudentExamScores(studentId: number): Promise<StudentExamScore[]> {
  if (!isTauri()) {
    const store = mem();
    const examById = new Map(store.exams.map((e) => [e.id, e]));
    return store.examScores
      .filter((s) => s.student_id === studentId)
      .flatMap((s) => {
        const exam = examById.get(s.exam_id);
        if (!exam) return [];
        return [
          { ...s, exam_name: exam.name, exam_date: exam.exam_date, exam_type: exam.exam_type },
        ];
      })
      .sort(
        (a, b) =>
          (a.exam_date === b.exam_date ? b.exam_id - a.exam_id : a.exam_date < b.exam_date ? 1 : -1) ||
          a.id - b.id
      );
  }
  const db = await getDb();
  return db.select<StudentExamScore[]>(
    `SELECT sc.*, e.name AS exam_name, e.exam_date, e.exam_type
       FROM exam_scores sc
       INNER JOIN exams e ON sc.exam_id = e.id
      WHERE sc.student_id = ?
      ORDER BY e.exam_date DESC, e.id DESC, sc.id ASC`,
    [studentId]
  );
}

/** 班级内全部成绩行（联学生与考试字段，总览矩阵的原始素材） */
interface ClassScoreRawRow extends ExamScore {
  student_name: string;
  student_no: string | null;
}

/** 班级成绩总览：学生 × 各次考试总分矩阵（多次重考的学生分数相加为总分口径） */
export async function getClassScoreOverview(
  className: string
): Promise<{ exams: ExamWithStats[]; rows: ClassScoreOverviewRow[] }> {
  const exams = await listExamsByClass(className);
  let raw: ClassScoreRawRow[];

  if (!isTauri()) {
    const store = mem();
    const examIds = new Set(exams.map((e) => e.id));
    raw = store.examScores
      .filter((s) => examIds.has(s.exam_id))
      .map((s) => {
        const student = store.students.find((st) => st.id === s.student_id);
        return {
          ...s,
          student_name: student?.name ?? "",
          student_no: student?.student_no ?? null,
        };
      });
  } else {
    const db = await getDb();
    raw = await db.select<ClassScoreRawRow[]>(
      `SELECT sc.*, s.name AS student_name, s.student_no
         FROM exam_scores sc
         INNER JOIN students s ON sc.student_id = s.id
         INNER JOIN exams e ON sc.exam_id = e.id
        WHERE e.class_name = ?`,
      [className]
    );
  }

  interface CellAcc {
    score: number;
    hasNumeric: boolean;
    grades: string[];
  }

  const byStudent = new Map<number, ClassScoreOverviewRow>();
  const accByStudent = new Map<number, Map<number, CellAcc>>();
  for (const r of raw) {
    let row = byStudent.get(r.student_id);
    if (!row) {
      row = { student_id: r.student_id, student_name: r.student_name, student_no: r.student_no, cells: {} };
      byStudent.set(r.student_id, row);
      accByStudent.set(r.student_id, new Map());
    }
    const acc = accByStudent.get(r.student_id)!;
    const cell = acc.get(r.exam_id) ?? { score: 0, hasNumeric: false, grades: [] };
    if (r.score !== null && !Number.isNaN(r.score)) {
      cell.score += r.score;
      cell.hasNumeric = true;
    } else if (r.grade) {
      cell.grades.push(r.grade);
    }
    acc.set(r.exam_id, cell);
    // 数字分聚合为总分；纯等级（如「优」）原样保留
    row.cells[r.exam_id] = {
      score: cell.hasNumeric ? cell.score : null,
      grade: cell.grades.length ? cell.grades.join("、") : null,
    };
  }

  const rows = [...byStudent.values()].sort((a, b) => a.student_name.localeCompare(b.student_name, "zh"));
  return { exams: exams.map(({ ...e }) => e), rows };
}

/**
 * 班级多次考试趋势：按考试时间**正序**逐场给出统计（含各科平均分）。
 * 供班级面板「成绩趋势」视图与 AI 分析器使用；口径同 computeExamStats。
 */
export async function getClassScoreTrend(className: string): Promise<ClassExamTrendPoint[]> {
  const exams = await listExamsByClass(className);
  const ordered = [...exams].reverse();
  const out: ClassExamTrendPoint[] = [];
  const lines = scoreLines();
  for (const exam of ordered) {
    const rows = await getExamScores(exam.id);
    out.push({ exam, stats: computeExamStats(rows, lines) });
  }
  return out;
}

/** 全部考试批次（可按班级过滤，带成绩统计，按考试时间倒序）——query_data / AI 分析器用 */
export async function listExams(className?: string): Promise<ExamWithStats[]> {
  const target = className?.trim();
  if (!isTauri()) {
    const store = mem();
    return store.exams
      .filter((e) => !target || e.class_name === target)
      .map((e) => {
        const scores = store.examScores.filter((s) => s.exam_id === e.id);
        return {
          ...e,
          subject_count: new Set(scores.map((s) => s.subject)).size,
          score_count: scores.length,
          student_count: new Set(scores.map((s) => s.student_id)).size,
        };
      })
      .sort((a, b) => (a.exam_date === b.exam_date ? b.id - a.id : a.exam_date < b.exam_date ? 1 : -1));
  }
  if (target) return listExamsByClass(target);
  const db = await getDb();
  return db.select<ExamWithStats[]>(
    `SELECT e.*,
            (SELECT COUNT(DISTINCT subject)    FROM exam_scores sc WHERE sc.exam_id = e.id) AS subject_count,
            (SELECT COUNT(*)                   FROM exam_scores sc WHERE sc.exam_id = e.id) AS score_count,
            (SELECT COUNT(DISTINCT student_id) FROM exam_scores sc WHERE sc.exam_id = e.id) AS student_count
       FROM exams e
      ORDER BY e.exam_date DESC, e.id DESC`
  );
}

/** 成绩明细过滤条件（query_data / AI 分析器用） */
export interface ExamScoreFilter {
  examId?: number;
  studentId?: number;
  subject?: string;
  className?: string;
  limit?: number;
}

/** 成绩明细查询（联学生与考试，按条件取数，默认最多 200 条） */
export async function listExamScores(filter: ExamScoreFilter = {}): Promise<ExamScoreRow[]> {
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : 200;
  const subject = filter.subject?.trim();
  if (!isTauri()) {
    const store = mem();
    const examById = new Map(store.exams.map((e) => [e.id, e]));
    return store.examScores
      .filter((s) => {
        if (filter.examId !== undefined && s.exam_id !== filter.examId) return false;
        if (filter.studentId !== undefined && s.student_id !== filter.studentId) return false;
        if (subject && s.subject !== subject) return false;
        if (filter.className) {
          const exam = examById.get(s.exam_id);
          if (!exam || exam.class_name !== filter.className) return false;
        }
        return true;
      })
      .map((s) => {
        const student = store.students.find((st) => st.id === s.student_id);
        return { ...s, student_name: student?.name ?? "", student_no: student?.student_no ?? null };
      })
      .sort(
        (a, b) =>
          b.exam_id - a.exam_id ||
          a.student_name.localeCompare(b.student_name, "zh") ||
          a.id - b.id
      )
      .slice(0, limit);
  }
  const db = await getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.examId !== undefined) {
    where.push("sc.exam_id = ?");
    params.push(filter.examId);
  }
  if (filter.studentId !== undefined) {
    where.push("sc.student_id = ?");
    params.push(filter.studentId);
  }
  if (subject) {
    where.push("sc.subject = ?");
    params.push(subject);
  }
  if (filter.className) {
    where.push("e.class_name = ?");
    params.push(filter.className);
  }
  params.push(limit);
  return db.select<ExamScoreRow[]>(
    `SELECT sc.*, s.name AS student_name, s.student_no
       FROM exam_scores sc
       INNER JOIN students s ON sc.student_id = s.id
       INNER JOIN exams e ON sc.exam_id = e.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY sc.exam_id DESC, s.name ASC, sc.id ASC
      LIMIT ?`,
    params
  );
}

/**
 * 学生成绩报告：按考试倒序，逐场给出单科分数（含班级平均分 / 单科排名）、
 * 总分（含班级平均 / 总分排名）与相较上一次考试的进退步。
 * 口径与班级面板一致（lib/score-analysis.ts），学生档案「成绩」页与 AI 分析器共用。
 */
export async function getStudentScoreReport(studentId: number): Promise<StudentScoreReport | null> {
  const student = await getStudent(studentId);
  if (!student) return null;

  const flat = await listStudentExamScores(studentId);
  const groups: {
    exam_id: number;
    exam_name: string;
    exam_date: string;
    exam_type: ExamType;
    rows: StudentExamScore[];
  }[] = [];
  for (const row of flat) {
    let g = groups.find((x) => x.exam_id === row.exam_id);
    if (!g) {
      g = {
        exam_id: row.exam_id,
        exam_name: row.exam_name,
        exam_date: row.exam_date,
        exam_type: row.exam_type,
        rows: [],
      };
      groups.push(g);
    }
    g.rows.push(row);
  }

  const exams: StudentExamReport[] = [];
  for (const g of groups) {
    const classRows = await getExamScores(g.exam_id);
    const averages = subjectAverages(classRows);
    const ranks = rankBySubject(classRows);
    const totals = computeStudentTotals(classRows);
    const totalRanks = rankByTotal(totals);
    const mine = computeStudentTotals(g.rows).get(studentId) ?? {
      score: null,
      grade: null,
      subjectCount: 0,
    };

    const subjects: StudentExamSubject[] = g.rows.map((r) => ({
      subject: r.subject,
      score: r.score,
      grade: r.grade,
      class_average: r.score !== null ? (averages.get(r.subject) ?? null) : null,
      class_rank: r.score !== null ? (ranks.get(r.subject)?.get(studentId) ?? null) : null,
    }));

    const classTotals = [...totals.values()]
      .map((v) => v.score)
      .filter((v): v is number => v !== null);

    exams.push({
      exam_id: g.exam_id,
      exam_name: g.exam_name,
      exam_date: g.exam_date,
      exam_type: g.exam_type,
      subjects,
      total: mine.score,
      total_grade: mine.grade,
      class_total_average: classTotals.length
        ? Math.round((classTotals.reduce((a, b) => a + b, 0) / classTotals.length) * 10) / 10
        : null,
      class_total_rank: totalRanks.get(studentId) ?? null,
      class_student_count: new Set(classRows.map((r) => r.student_id)).size,
      total_delta: null,
    });
  }

  // exams 与 groups 同序（考试时间倒序）：前一场（时间更早）是 i+1，据此回填进退步
  for (let i = exams.length - 1; i >= 0; i--) {
    const earlier = exams[i + 1];
    exams[i].total_delta = earlier ? trendOf(exams[i].total, earlier.total) : null;
  }

  return {
    student_id: student.id,
    student_name: student.name,
    student_no: student.student_no,
    grade_class: student.grade_class,
    exams,
  };
}

