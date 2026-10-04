/**
 * 学生域（拆分自 db.ts）：花名册查询 / 增删改 / 回收站快照构建。
 */
import { executeBatch, getDb, isTauri } from "./core";
import { createClass } from "./classes";
import { mem, now } from "./memory-store";
import { expireAtOf, parseTags, photoSnap } from "./shared";
import type {
  Guardian,
  Photo,
  Student,
  StudentBehaviorRecord,
  StudentInput,
  StudentRow,
  StudentSnapshot,
  StudentTermComment,
} from "../../types";

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export async function listStudents(keyword = "", gradeClass?: string): Promise<StudentRow[]> {
  const kw = keyword.trim();
  if (!isTauri()) {
    const store = mem();
    const k = kw.toLowerCase();
    const byClass = (s: Student) => {
      if (!gradeClass) return true;
      if (gradeClass === "未分班") return !s.grade_class || s.grade_class === "未分班";
      return s.grade_class === gradeClass;
    };
    return store.students
      .filter(byClass)
      .filter(
        (s) =>
          !k || s.name.toLowerCase().includes(k) || s.student_no.toLowerCase().includes(k)
      )
      .map((s) => {
        const sGuardians = store.guardians.filter((g) => g.student_id === s.id);
        const primaryG = sGuardians.find((g) => g.is_primary) ?? sGuardians[0];
        return {
          ...s,
          guardians: sGuardians,
          primary_phone: primaryG?.phone ?? null,
          primary_relation: primaryG?.relation ?? null,
          photo_count: store.photos.filter((p) => p.student_id === s.id).length,
        };
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (kw) {
    conditions.push("(s.name LIKE '%' || ? || '%' OR s.student_no LIKE '%' || ? || '%')");
    params.push(kw, kw);
  }
  if (gradeClass) {
    if (gradeClass === "未分班") {
      conditions.push("(s.grade_class IS NULL OR s.grade_class = '' OR s.grade_class = '未分班')");
    } else {
      conditions.push("s.grade_class = ?");
      params.push(gradeClass);
    }
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.select<StudentRow[]>(
    `SELECT s.*,
            (SELECT phone FROM guardians g WHERE g.student_id = s.id ORDER BY is_primary DESC, id ASC LIMIT 1) AS primary_phone,
            (SELECT relation FROM guardians g WHERE g.student_id = s.id ORDER BY is_primary DESC, id ASC LIMIT 1) AS primary_relation,
            (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id) AS photo_count
       FROM students s
      ${whereClause}
      ORDER BY s.updated_at DESC, s.id DESC`,
    params
  );
}

export async function getStudent(id: number): Promise<Student | null> {
  if (!isTauri()) {
    const student = mem().students.find((s) => s.id === id);
    if (!student) return null;
    const sGuardians = mem().guardians.filter((g) => g.student_id === id);
    return {
      ...student,
      guardians: sGuardians.map((g) => ({
        ...g,
        is_primary: Boolean(g.is_primary),
        occupation: g.occupation ?? "",
        tags: parseTags(g.tags),
      })),
    };
  }
  const db = await getDb();
  const rows = await db.select<Student[]>("SELECT * FROM students WHERE id = ?", [id]);
  const student = rows[0];
  if (!student) return null;
  const guardians = await db.select<Guardian[]>(
    "SELECT * FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id ASC",
    [id]
  );
  return {
    ...student,
    guardians: guardians.map((g) => ({
      ...g,
      is_primary: Boolean(g.is_primary),
      occupation: g.occupation ?? "",
      tags: parseTags(g.tags),
    })),
  };
}

/** 学生落库前确保班级存在：手动输入的新班级名默认建档（已存在 / 「未分班」跳过） */
async function ensureClassForStudent(gradeClass: string | null | undefined): Promise<void> {
  const name = (gradeClass ?? "").trim();
  if (!name || name === "未分班") return;
  await createClass(name);
}

export async function createStudent(input: StudentInput): Promise<number> {
  await ensureClassForStudent(input.grade_class);

  if (!isTauri()) {
    const store = mem();
    const id = store.nextStudentId++;
    const ts = now();
    const studentGuardians: Guardian[] = (input.guardians ?? []).map((g) => ({
      ...g,
      id: store.nextGuardianId++,
      student_id: id,
    }));
    store.guardians.push(...studentGuardians);
    store.students.push({
      ...input,
      id,
      guardians: studentGuardians,
      created_at: ts,
      updated_at: ts,
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO students
       (name, gender, birth_date, student_no, grade_class, id_card,
        address, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.student_no,
      input.grade_class,
      input.id_card,
      input.address,
      input.status,
      input.note,
    ]
  );
  const studentId = Number(result.lastInsertId ?? 0);
  if (studentId && input.guardians?.length) {
    for (const g of input.guardians) {
      await db.execute(
        "INSERT INTO guardians (student_id, name, phone, relation, is_primary, occupation, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          studentId,
          g.name,
          g.phone,
          g.relation,
          g.is_primary ? 1 : 0,
          g.occupation ?? "",
          JSON.stringify(g.tags ?? []),
        ]
      );
    }
  }
  return studentId;
}

export async function updateStudent(id: number, input: StudentInput): Promise<void> {
  // 编辑档案时改成新班级名，同样默认建档
  await ensureClassForStudent(input.grade_class);

  if (!isTauri()) {
    const store = mem();
    const idx = store.students.findIndex((s) => s.id === id);
    if (idx >= 0) {
      store.guardians = store.guardians.filter((g) => g.student_id !== id);
      const studentGuardians: Guardian[] = (input.guardians ?? []).map((g) => ({
        ...g,
        id: g.id ?? store.nextGuardianId++,
        student_id: id,
      }));
      store.guardians.push(...studentGuardians);
      store.students[idx] = {
        ...store.students[idx],
        ...input,
        guardians: studentGuardians,
        updated_at: now(),
      };
    }
    return;
  }

  const db = await getDb();
  // 学生字段更新与监护人重写同一写批原子生效
  const statements = [
    `UPDATE students
        SET name = ?, gender = ?, birth_date = ?, student_no = ?, grade_class = ?,
            id_card = ?, address = ?, status = ?, note = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    "DELETE FROM guardians WHERE student_id = ?",
  ];
  const params: unknown[] = [
    input.name,
    input.gender,
    input.birth_date,
    input.student_no,
    input.grade_class,
    input.id_card,
    input.address,
    input.status,
    input.note,
    id,
    id,
  ];
  for (const g of input.guardians ?? []) {
    statements.push(
      "INSERT INTO guardians (student_id, name, phone, relation, is_primary, occupation, tags) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    params.push(
      id,
      g.name,
      g.phone,
      g.relation,
      g.is_primary ? 1 : 0,
      g.occupation ?? "",
      JSON.stringify(g.tags ?? [])
    );
  }
  await executeBatch(db, statements, params);
}

/** 学生完整快照（供回收站与恢复使用，浏览器/SQLite 双通道共用） */
export function buildStudentSnapshot(
  student: Student,
  guardians: Guardian[],
  photos: Photo[],
  behaviors: StudentBehaviorRecord[],
  termComments: StudentTermComment[] = []
): StudentSnapshot {
  return {
    student: {
      name: student.name,
      gender: student.gender,
      birth_date: student.birth_date ?? null,
      student_no: student.student_no ?? "",
      grade_class: student.grade_class ?? "",
      id_card: student.id_card ?? null,
      address: student.address ?? null,
      status: student.status ?? "active",
      note: student.note ?? null,
    },
    guardians: guardians.map((g) => ({
      name: g.name ?? "",
      phone: g.phone ?? "",
      relation: g.relation ?? "监护人",
      is_primary: Boolean(g.is_primary),
      occupation: g.occupation ?? "",
      tags: parseTags(g.tags),
    })),
    photos: photos.map(photoSnap),
    behaviors: behaviors.map((b) => ({
      dimension_id: b.dimension_id,
      dimension_name_snap: b.dimension_name_snap,
      category_snap: b.category_snap,
      type: b.type,
      comment: b.comment,
      recorded_date: b.recorded_date,
      created_at: b.created_at,
    })),
    termComments: termComments.map((c) => ({
      semester: c.semester,
      content: c.content,
      source: c.source,
    })),
  };
}

/** 学生快照摘要：班级 · 照片数 · 表现条数 */
function studentSummary(snap: StudentSnapshot): string {
  const parts = [snap.student.grade_class || "未分班"];
  if (snap.student.student_no) parts.push(`学号 ${snap.student.student_no}`);
  parts.push(`照片 ${snap.photos.length} 张`, `表现 ${snap.behaviors.length} 条`);
  return parts.join(" · ");
}

/**
 * 删除学生 → 移入回收站（保留 7 天）。
 * 档案、监护人、照片记录与表现流水整体进快照；落盘图片在彻底删除前不清理，
 * 以便随时恢复。
 */
export async function deleteStudent(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.students.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const [student] = store.students.splice(idx, 1);
    const guardians = store.guardians.filter((g) => g.student_id === id);
    store.guardians = store.guardians.filter((g) => g.student_id !== id);
    const photos = store.photos.filter((p) => p.student_id === id);
    store.photos = store.photos.filter((p) => p.student_id !== id);
    const behaviors = store.behaviorRecords.filter((r) => r.student_id === id);
    store.behaviorRecords = store.behaviorRecords.filter((r) => r.student_id !== id);
    store.examScores = store.examScores.filter((r) => r.student_id !== id);
    const termComments = store.termComments.filter((c) => c.student_id === id);
    store.termComments = store.termComments.filter((c) => c.student_id !== id);
    store.homeworks = store.homeworks.filter((r) => r.student_id !== id);
    store.evalReports = store.evalReports.filter((r) => r.student_id !== id);

    const snap = buildStudentSnapshot(student, guardians, photos, behaviors, termComments);
    const ts = now();
    store.recycleBin.unshift({
      id: store.nextRecycleId++,
      entity_type: "student",
      label: student.name,
      summary: studentSummary(snap),
      payload: snap,
      deleted_at: ts,
      expire_at: expireAtOf(ts),
    });
    return;
  }

  const db = await getDb();
  const rows = await db.select<Student[]>("SELECT * FROM students WHERE id = ?", [id]);
  const student = rows[0];
  if (!student) return;
  const guardians = await db.select<Guardian[]>(
    "SELECT * FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id ASC",
    [id]
  );
  const photos = await db.select<Photo[]>("SELECT * FROM photos WHERE student_id = ?", [id]);
  const behaviors = await db.select<StudentBehaviorRecord[]>(
    "SELECT * FROM student_behavior_records WHERE student_id = ?",
    [id]
  );
  const termComments = await db.select<StudentTermComment[]>(
    "SELECT * FROM student_term_comments WHERE student_id = ?",
    [id]
  );

  const snap = buildStudentSnapshot(student, guardians, photos, behaviors, termComments);
  // 快照入回收站与全表删除同一写批原子生效
  await executeBatch(
    db,
    [
      "INSERT INTO recycle_bin (entity_type, label, summary, payload) VALUES ('student', ?, ?, ?)",
      "DELETE FROM guardians WHERE student_id = ?",
      "DELETE FROM photos WHERE student_id = ?",
      "DELETE FROM student_behavior_records WHERE student_id = ?",
      "DELETE FROM student_term_comments WHERE student_id = ?",
      "DELETE FROM exam_scores WHERE student_id = ?",
      "DELETE FROM student_homework_records WHERE student_id = ?",
      "DELETE FROM student_eval_reports WHERE student_id = ?",
      "DELETE FROM students WHERE id = ?",
    ],
    [student.name, studentSummary(snap), JSON.stringify(snap), id, id, id, id, id, id, id, id, id]
  );
}

