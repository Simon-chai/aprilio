/**
 * 评价报告存档域（拆分自 db.ts）：一次生成一条历史。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import type { StudentEvalReport } from "../../types";

/* ------------------------------------------------------------------ */
/* 评价报告存档：一次生成一条历史（P1）                                   */
/* ------------------------------------------------------------------ */

/** 保存一次生成的报告，返回新 id */
export async function createEvalReport(input: {
  student_id: number;
  range_start: string;
  range_end: string;
  semester?: string | null;
  title: string;
  content_md: string;
  short_comment?: string;
  source?: "ai" | "manual";
}): Promise<number> {
  if (!input.student_id) throw new Error("缺少学生");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.range_start)) throw new Error("起始日期格式应为 YYYY-MM-DD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.range_end)) throw new Error("结束日期格式应为 YYYY-MM-DD");
  if (input.range_start > input.range_end) throw new Error("起始日期不能晚于结束日期");
  const title = (input.title ?? "").trim() || "评价报告";
  const content = (input.content_md ?? "").trim();
  if (!content) throw new Error("报告内容不能为空");
  const shortComment = (input.short_comment ?? "").trim();
  const source = input.source === "ai" ? "ai" : "manual";
  const semester = input.semester?.trim() ? input.semester.trim() : null;
  if (!isTauri()) {
    const store = mem();
    const id = store.nextEvalReportId++;
    store.evalReports.push({
      id,
      student_id: input.student_id,
      range_start: input.range_start,
      range_end: input.range_end,
      semester,
      title,
      content_md: content,
      short_comment: shortComment,
      source,
      created_at: now(),
    });
    return id;
  }
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO student_eval_reports (student_id, range_start, range_end, semester, title, content_md, short_comment, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.student_id, input.range_start, input.range_end, semester, title, content, shortComment, source]
  );
  return Number(result.lastInsertId ?? 0);
}

/** 按学生查报告历史（创建时间倒序） */
export async function listEvalReports(studentId: number, limit = 50): Promise<StudentEvalReport[]> {
  const n = limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
  if (!isTauri()) {
    return mem()
      .evalReports.filter((r) => r.student_id === studentId)
      .sort((a, b) => b.id - a.id)
      .slice(0, n);
  }
  const db = await getDb();
  return db.select<StudentEvalReport[]>(
    "SELECT * FROM student_eval_reports WHERE student_id = ? ORDER BY id DESC LIMIT ?",
    [studentId, n]
  );
}

/** 删除一条报告 */
export async function deleteEvalReport(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.evalReports = store.evalReports.filter((r) => r.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM student_eval_reports WHERE id = ?", [id]);
}

