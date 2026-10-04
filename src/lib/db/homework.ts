/**
 * 作业台账域（拆分自 db.ts）：个人完成度记录（评价报告的输入之一）。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { localDateStr } from "../format";
import type { HomeworkInput, HomeworkStatus, StudentHomeworkRecord } from "../../types";

/* ------------------------------------------------------------------ */
/* 作业台账：个人完成度（P2 先行，评价报告的输入之一）                    */
/* ------------------------------------------------------------------ */

const HOMEWORK_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "excellent",
  "late",
  "missing",
  "exempt",
]);

function assertHomeworkInput(input: HomeworkInput): { subject: string; comment: string | null } {
  if (!input.student_id) throw new Error("缺少学生");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.homework_date)) throw new Error("日期格式应为 YYYY-MM-DD");
  if (input.homework_date > localDateStr()) throw new Error("不能录入未来日期");
  const subject = (input.subject ?? "").trim();
  if (!subject) throw new Error("科目不能为空");
  if (!HOMEWORK_STATUSES.has(input.status)) throw new Error("作业状态不合法");
  const comment = (input.comment ?? "").trim();
  if (comment.length > 200) throw new Error("备注请控制在 200 字以内");
  if (input.score !== undefined && input.score !== null) {
    if (typeof input.score !== "number" || Number.isNaN(input.score)) throw new Error("分数应为数字");
    if (input.score < 0 || input.score > 100) throw new Error("分数应在 0~100 之间");
  }
  return { subject, comment: comment ? comment : null };
}

/** 新增一条作业记录，返回新 id */
export async function addHomeworkRecord(input: HomeworkInput): Promise<number> {
  const { subject, comment } = assertHomeworkInput(input);
  const score = input.score ?? null;
  if (!isTauri()) {
    const store = mem();
    const id = store.nextHomeworkId++;
    const ts = now();
    store.homeworks.push({
      id,
      student_id: input.student_id,
      homework_date: input.homework_date,
      subject,
      status: input.status,
      score,
      comment,
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }
  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO student_homework_records (student_id, homework_date, subject, status, score, comment)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.student_id, input.homework_date, subject, input.status, score, comment]
  );
  return Number(result.lastInsertId ?? 0);
}

export interface HomeworkQuery {
  start?: string;
  end?: string;
  subject?: string;
  limit?: number;
}

/** 按学生查作业记录（日期倒序，默认 200 条） */
export async function listHomeworkRecords(
  studentId: number,
  query: HomeworkQuery = {}
): Promise<StudentHomeworkRecord[]> {
  const limit = query.limit && query.limit > 0 ? Math.min(Math.floor(query.limit), 500) : 200;
  const subject = (query.subject ?? "").trim();
  if (!isTauri()) {
    return mem()
      .homeworks.filter((r) => r.student_id === studentId)
      .filter((r) => (!query.start || r.homework_date >= query.start) && (!query.end || r.homework_date <= query.end))
      .filter((r) => (!subject || r.subject === subject))
      .sort((a, b) => (a.homework_date < b.homework_date ? 1 : -1) || b.id - a.id)
      .slice(0, limit);
  }
  const db = await getDb();
  const conditions = ["student_id = ?"];
  const params: unknown[] = [studentId];
  if (query.start) {
    conditions.push("homework_date >= ?");
    params.push(query.start);
  }
  if (query.end) {
    conditions.push("homework_date <= ?");
    params.push(query.end);
  }
  if (subject) {
    conditions.push("subject = ?");
    params.push(subject);
  }
  params.push(limit);
  return db.select<StudentHomeworkRecord[]>(
    `SELECT * FROM student_homework_records WHERE ${conditions.join(" AND ")} ORDER BY homework_date DESC, id DESC LIMIT ?`,
    params
  );
}

/** 更新一条作业记录（部分字段） */
export async function updateHomeworkRecord(
  id: number,
  patch: Partial<Pick<HomeworkInput, "homework_date" | "subject" | "status" | "score" | "comment">>
): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const rec = store.homeworks.find((r) => r.id === id);
    if (!rec) return;
    const merged: HomeworkInput = {
      student_id: rec.student_id,
      homework_date: patch.homework_date ?? rec.homework_date,
      subject: patch.subject ?? rec.subject,
      status: patch.status ?? rec.status,
      score: patch.score !== undefined ? patch.score : rec.score,
      comment: patch.comment !== undefined ? patch.comment : rec.comment,
    };
    const { subject, comment } = assertHomeworkInput(merged);
    rec.homework_date = merged.homework_date;
    rec.subject = subject;
    rec.status = merged.status;
    rec.score = merged.score ?? null;
    rec.comment = comment;
    rec.updated_at = now();
    return;
  }
  const db = await getDb();
  const rows = await db.select<StudentHomeworkRecord[]>(
    "SELECT * FROM student_homework_records WHERE id = ? LIMIT 1",
    [id]
  );
  const rec = rows[0];
  if (!rec) return;
  const merged: HomeworkInput = {
    student_id: rec.student_id,
    homework_date: patch.homework_date ?? rec.homework_date,
    subject: patch.subject ?? rec.subject,
    status: (patch.status as HomeworkStatus | undefined) ?? rec.status,
    score: patch.score !== undefined ? patch.score : rec.score,
    comment: patch.comment !== undefined ? patch.comment : rec.comment,
  };
  const { subject, comment } = assertHomeworkInput(merged);
  await db.execute(
    `UPDATE student_homework_records SET homework_date = ?, subject = ?, status = ?, score = ?, comment = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [merged.homework_date, subject, merged.status, merged.score ?? null, comment, id]
  );
}

/** 删除一条作业记录 */
export async function deleteHomeworkRecord(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.homeworks = store.homeworks.filter((r) => r.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM student_homework_records WHERE id = ?", [id]);
}

