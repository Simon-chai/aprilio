/**
 * 学期评语域（拆分自 db.ts）：一个学生一个学期一条，upsert 幂等。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import type { StudentTermComment } from "../../types";

/* ------------------------------------------------------------------ */
/* 学期评语：一个学生一个学期一条（upsert 幂等）                          */
/* ------------------------------------------------------------------ */

/** 学生的全部学期评语（按学期倒序） */
export async function listTermComments(studentId: number): Promise<StudentTermComment[]> {
  if (!isTauri()) {
    return mem()
      .termComments.filter((c) => c.student_id === studentId)
      .sort((a, b) => (a.semester < b.semester ? 1 : -1));
  }
  const db = await getDb();
  return db.select<StudentTermComment[]>(
    "SELECT * FROM student_term_comments WHERE student_id = ? ORDER BY semester DESC",
    [studentId]
  );
}

/** 取某学生某学期的评语；没有返回 null */
export async function getTermComment(
  studentId: number,
  semester: string
): Promise<StudentTermComment | null> {
  if (!isTauri()) {
    return (
      mem().termComments.find((c) => c.student_id === studentId && c.semester === semester) ?? null
    );
  }
  const db = await getDb();
  const rows = await db.select<StudentTermComment[]>(
    "SELECT * FROM student_term_comments WHERE student_id = ? AND semester = ? LIMIT 1",
    [studentId, semester]
  );
  return rows[0] ?? null;
}

/** 写入/覆盖某学生某学期的评语（upsert 幂等） */
export async function upsertTermComment(
  studentId: number,
  semester: string,
  content: string,
  source: "manual" | "ai" = "manual"
): Promise<void> {
  const sem = semester.trim();
  if (!sem) throw new Error("学期不能为空");
  const text = content.trim();
  if (!text) throw new Error("评语内容不能为空");

  if (!isTauri()) {
    const store = mem();
    const idx = store.termComments.findIndex(
      (c) => c.student_id === studentId && c.semester === sem
    );
    const ts = now();
    if (idx >= 0) {
      store.termComments[idx] = { ...store.termComments[idx], content: text, source, updated_at: ts };
    } else {
      store.termComments.push({
        id: store.nextTermCommentId++,
        student_id: studentId,
        semester: sem,
        content: text,
        source,
        created_at: ts,
        updated_at: ts,
      });
    }
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO student_term_comments (student_id, semester, content, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(student_id, semester) DO UPDATE SET
       content = excluded.content,
       source = excluded.source,
       updated_at = datetime('now','localtime')`,
    [studentId, sem, text, source]
  );
}

/** 删除某学生某学期的评语（留空时用） */
export async function deleteTermComment(studentId: number, semester: string): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.termComments = store.termComments.filter(
      (c) => !(c.student_id === studentId && c.semester === semester)
    );
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM student_term_comments WHERE student_id = ? AND semester = ?", [
    studentId,
    semester,
  ]);
}

