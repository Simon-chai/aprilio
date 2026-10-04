/**
 * 班级域（拆分自 db.ts）：班级 CRUD / 归档 / 改名 / 删除 / 批量调班 / 班级照片 / 统计。
 */
import { getDb, isTauri, executeBatch } from "./core";
import { mem, now } from "./memory-store";
import { expireAtOf, photoSnap } from "./shared";
import { buildStudentSnapshot } from "./students";
import type {
  ClassMeta,
  ClassSnapshot,
  ClassSummary,
  Guardian,
  Photo,
  Student,
  StudentBehaviorRecord,
  StudentSnapshot,
  StudentTermComment,
  Stats,
} from "../../types";


export async function listClasses(): Promise<ClassSummary[]> {
  let students: Student[];
  let photos: Photo[];
  const classNames = new Set<string>();
  const archivedByName = new Map<string, string | null>();

  if (!isTauri()) {
    const store = mem();
    students = store.students;
    photos = store.photos;
    for (const c of store.classes) {
      if (c && c !== "未分班") classNames.add(c);
    }
    for (const [name, meta] of Object.entries(store.classMeta)) {
      archivedByName.set(name, meta.archived_at);
    }
  } else {
    const db = await getDb();
    students = await db.select<Student[]>("SELECT * FROM students");
    photos = await db.select<Photo[]>("SELECT * FROM photos");
    const explicitClasses = await db.select<{ name: string; archived_at: string | null }[]>(
      "SELECT name, archived_at FROM classes"
    );
    for (const row of explicitClasses) {
      if (row.name && row.name !== "未分班") classNames.add(row.name);
      archivedByName.set(row.name, row.archived_at ?? null);
    }
  }

  for (const s of students) {
    if (s.grade_class && s.grade_class !== "未分班") {
      classNames.add(s.grade_class);
    }
  }
  for (const p of photos) {
    if (p.grade_class && p.grade_class !== "未分班") {
      classNames.add(p.grade_class);
    }
  }

  // 检查是否有未分班学生，若有则加入「未分班」虚拟分组
  const hasUnassigned = students.some((s) => !s.grade_class || s.grade_class === "未分班");
  if (hasUnassigned) {
    classNames.add("未分班");
  }

  const summaries: ClassSummary[] = [];
  for (const name of classNames) {
    const inClass = students.filter((s) =>
      name === "未分班" ? !s.grade_class || s.grade_class === "未分班" : s.grade_class === name
    );
    const studentIds = new Set(inClass.map((s) => s.id));

    const studentCount = inClass.length;
    const maleCount = inClass.filter((s) => (s.gender as string) === "男" || (s.gender as string) === "male").length;
    const femaleCount = inClass.filter((s) => (s.gender as string) === "女" || (s.gender as string) === "female").length;

    const classPhotoCount = photos.filter(
      (p) => p.grade_class === name && p.student_id === null
    ).length;
    const studentPhotoCount = photos.filter(
      (p) => p.student_id !== null && studentIds.has(p.student_id)
    ).length;

    summaries.push({
      name,
      studentCount,
      maleCount,
      femaleCount,
      photoCount: classPhotoCount + studentPhotoCount,
      classPhotoCount,
      studentPhotoCount,
      archived_at: archivedByName.get(name) ?? null,
    });
  }

  return summaries.sort((a, b) => {
    if (a.name === "未分班") return 1;
    if (b.name === "未分班") return -1;
    return a.name.localeCompare(b.name, "zh");
  });
}

export async function createClass(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("班级名称不能为空");

  if (!isTauri()) {
    const store = mem();
    if (!store.classes.includes(trimmed)) {
      store.classes.push(trimmed);
    }
    if (!store.classMeta[trimmed]) {
      store.classMeta[trimmed] = { archived_at: null };
    }
    return;
  }

  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [trimmed]);
}

/** 班级元信息（归档状态）；班级不存在返回 archived_at: null */
export async function getClassMeta(name: string): Promise<ClassMeta> {
  const trimmed = name.trim();
  const empty: ClassMeta = { archived_at: null };
  if (!trimmed) return empty;

  if (!isTauri()) {
    return { ...empty, ...(mem().classMeta[trimmed] ?? {}) };
  }

  const db = await getDb();
  const rows = await db.select<{ archived_at: string | null }[]>(
    "SELECT archived_at FROM classes WHERE name = ?",
    [trimmed]
  );
  const row = rows[0];
  if (!row) return empty;
  return { archived_at: row.archived_at ?? null };
}

/** 归档班级：从班级管理移出，进入「历史带过的班」；数据全部保留 */
export async function archiveClass(name: string): Promise<void> {
  await setClassArchived(name, true);
}

/** 恢复归档班级：回到在用班级列表 */
export async function restoreClass(name: string): Promise<void> {
  await setClassArchived(name, false);
}

async function setClassArchived(name: string, archived: boolean): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("班级名称不能为空");

  if (!isTauri()) {
    const store = mem();
    const current = store.classMeta[trimmed] ?? { archived_at: null };
    store.classMeta[trimmed] = { ...current, archived_at: archived ? now() : null };
    return;
  }

  const db = await getDb();
  await db.execute("UPDATE classes SET archived_at = ? WHERE name = ?", [
    archived ? now() : null,
    trimmed,
  ]);
}

export async function renameClass(oldName: string, newName: string): Promise<void> {
  const oldTrimmed = oldName.trim();
  const newTrimmed = newName.trim();
  if (!oldTrimmed || !newTrimmed) throw new Error("班级名称不能为空");
  if (oldTrimmed === newTrimmed) return;

  if (!isTauri()) {
    const store = mem();
    const idx = store.classes.indexOf(oldTrimmed);
    if (idx >= 0) {
      store.classes[idx] = newTrimmed;
    } else if (!store.classes.includes(newTrimmed)) {
      store.classes.push(newTrimmed);
    }
    const ts = now();
    for (const s of store.students) {
      if (s.grade_class === oldTrimmed || (oldTrimmed === "未分班" && !s.grade_class)) {
        s.grade_class = newTrimmed;
        s.updated_at = ts;
      }
    }
    for (const p of store.photos) {
      if (p.grade_class === oldTrimmed) {
        p.grade_class = newTrimmed;
      }
    }
    if (store.classMeta[oldTrimmed]) {
      store.classMeta[newTrimmed] = store.classMeta[oldTrimmed];
      delete store.classMeta[oldTrimmed];
    }
    return;
  }

  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [newTrimmed]);
  // 归档状态随改名迁移（新行已 INSERT OR IGNORE，这里把旧行的归档时刻补过去）
  await db.execute(
    `UPDATE classes
        SET archived_at = (SELECT archived_at FROM classes WHERE name = ?)
      WHERE name = ?`,
    [oldTrimmed, newTrimmed]
  );
  if (oldTrimmed === "未分班") {
    await db.execute(
      "UPDATE students SET grade_class = ?, updated_at = datetime('now','localtime') WHERE grade_class = ? OR grade_class IS NULL OR grade_class = ''",
      [newTrimmed, oldTrimmed]
    );
  } else {
    await db.execute(
      "UPDATE students SET grade_class = ?, updated_at = datetime('now','localtime') WHERE grade_class = ?",
      [newTrimmed, oldTrimmed]
    );
  }
  await db.execute("UPDATE photos SET grade_class = ? WHERE grade_class = ?", [newTrimmed, oldTrimmed]);
  await db.execute("DELETE FROM classes WHERE name = ?", [oldTrimmed]);
}

/**
 * 删除班级 → 整班（学生档案、监护人、照片、表现流水、班级公共照片）移入回收站，
 * 保留 7 天可恢复。
 */
export async function deleteClass(name: string): Promise<void> {
  const trimmed = name.trim();

  if (!isTauri()) {
    const store = mem();
    const members = store.students.filter((s) =>
      trimmed === "未分班" ? !s.grade_class || s.grade_class === "未分班" : s.grade_class === trimmed
    );
    const classPhotos = store.photos.filter(
      (p) => p.grade_class === trimmed && p.student_id === null
    );

    const studentSnaps: StudentSnapshot[] = members.map((s) => {
      const guardians = store.guardians.filter((g) => g.student_id === s.id);
      const photos = store.photos.filter((p) => p.student_id === s.id);
      const behaviors = store.behaviorRecords.filter((r) => r.student_id === s.id);
      const termComments = store.termComments.filter((c) => c.student_id === s.id);
      return buildStudentSnapshot(s, guardians, photos, behaviors, termComments);
    });

    const photoTotal = classPhotos.length + studentSnaps.reduce((n, s) => n + s.photos.length, 0);
    const behaviorTotal = studentSnaps.reduce((n, s) => n + s.behaviors.length, 0);
    const ts = now();

    store.recycleBin.unshift({
      id: store.nextRecycleId++,
      entity_type: "class",
      label: trimmed,
      summary: `${members.length} 名学生 · 照片 ${photoTotal} 张 · 表现 ${behaviorTotal} 条`,
      payload: { name: trimmed, students: studentSnaps, classPhotos: classPhotos.map(photoSnap) } satisfies ClassSnapshot,
      deleted_at: ts,
      expire_at: expireAtOf(ts),
    });

    const memberIds = new Set(members.map((s) => s.id));
    store.students = store.students.filter((s) => !memberIds.has(s.id));
    store.guardians = store.guardians.filter((g) => !memberIds.has(g.student_id ?? -1));
    store.photos = store.photos.filter(
      (p) =>
        p.grade_class !== trimmed &&
        (p.student_id === null || !memberIds.has(p.student_id))
    );
    store.behaviorRecords = store.behaviorRecords.filter((r) => !memberIds.has(r.student_id));
    store.termComments = store.termComments.filter((c) => !memberIds.has(c.student_id));
    store.homeworks = store.homeworks.filter((r) => !memberIds.has(r.student_id));
    store.evalReports = store.evalReports.filter((r) => !memberIds.has(r.student_id));
    const classExamIds = new Set(store.exams.filter((e) => e.class_name === trimmed).map((e) => e.id));
    store.exams = store.exams.filter((e) => e.class_name !== trimmed);
    store.examScores = store.examScores.filter(
      (s) => !classExamIds.has(s.exam_id) && !memberIds.has(s.student_id)
    );
    // 课表随班级删除（不进回收站快照，与成绩同口径）
    const classTimetableIds = new Set(
      store.timetables.filter((t) => t.class_name === trimmed).map((t) => t.id)
    );
    store.timetables = store.timetables.filter((t) => t.class_name !== trimmed);
    store.timetableSlots = store.timetableSlots.filter((s) => !classTimetableIds.has(s.timetable_id));
    store.timetableExceptions = store.timetableExceptions.filter(
      (e) => !classTimetableIds.has(e.timetable_id)
    );
    store.calendarEvents = store.calendarEvents.filter((e) => e.class_name !== trimmed);
    store.classes = store.classes.filter((c) => c !== trimmed);
    delete store.classMeta[trimmed];
    return;
  }

  const db = await getDb();
  // 「未分班」是虚拟分组，成员口径同 listStudents：字面量 + grade_class 为空的存量学生
  const memberWhere =
    trimmed === "未分班"
      ? "(grade_class IS NULL OR grade_class = '' OR grade_class = '未分班')"
      : "grade_class = ?";
  const memberParams = trimmed === "未分班" ? [] : [trimmed];
  const members = await db.select<Student[]>(`SELECT * FROM students WHERE ${memberWhere}`, memberParams);
  const classPhotos = await db.select<Photo[]>(
    "SELECT * FROM photos WHERE grade_class = ? AND student_id IS NULL",
    [trimmed]
  );

  const studentSnaps: StudentSnapshot[] = [];
  for (const s of members) {
    const guardians = await db.select<Guardian[]>(
      "SELECT * FROM guardians WHERE student_id = ? ORDER BY is_primary DESC, id ASC",
      [s.id]
    );
    const photos = await db.select<Photo[]>("SELECT * FROM photos WHERE student_id = ?", [s.id]);
    const behaviors = await db.select<StudentBehaviorRecord[]>(
      "SELECT * FROM student_behavior_records WHERE student_id = ?",
      [s.id]
    );
    const termComments = await db.select<StudentTermComment[]>(
      "SELECT * FROM student_term_comments WHERE student_id = ?",
      [s.id]
    );
    studentSnaps.push(buildStudentSnapshot(s, guardians, photos, behaviors, termComments));
  }

  const photoTotal = classPhotos.length + studentSnaps.reduce((n, s) => n + s.photos.length, 0);
  const behaviorTotal = studentSnaps.reduce((n, s) => n + s.behaviors.length, 0);
  // 快照入回收站与全表清空同一写批原子生效（顺序：成绩 → 课表 → 流水 → 照片 → 监护人 → 学生 → 班级）
  await executeBatch(
    db,
    [
      "INSERT INTO recycle_bin (entity_type, label, summary, payload) VALUES ('class', ?, ?, ?)",
      `DELETE FROM exam_scores WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      "DELETE FROM exam_scores WHERE exam_id IN (SELECT id FROM exams WHERE class_name = ?)",
      "DELETE FROM exams WHERE class_name = ?",
      // 课表随班级删除（不进回收站快照，与成绩同口径）
      "DELETE FROM timetable_slots WHERE timetable_id IN (SELECT id FROM timetables WHERE class_name = ?)",
      "DELETE FROM timetable_exceptions WHERE timetable_id IN (SELECT id FROM timetables WHERE class_name = ?)",
      "DELETE FROM timetables WHERE class_name = ?",
      "DELETE FROM calendar_events WHERE class_name = ?",
      `DELETE FROM student_behavior_records WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM student_term_comments WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM student_homework_records WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM student_eval_reports WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM photos WHERE (grade_class = ? AND student_id IS NULL) OR student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM guardians WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
      `DELETE FROM students WHERE ${memberWhere}`,
      "DELETE FROM classes WHERE name = ?",
    ],
    [
      // ① 快照入回收站
      trimmed,
      `${members.length} 名学生 · 照片 ${photoTotal} 张 · 表现 ${behaviorTotal} 条`,
      JSON.stringify({
        name: trimmed,
        students: studentSnaps,
        classPhotos: classPhotos.map(photoSnap),
      } satisfies ClassSnapshot),
      // ② 成绩（按学生）
      ...memberParams,
      // ③ 成绩（按考试）④ 考试 ⑤ 节次 ⑥ 调课例外 ⑦ 课表 ⑧ 日程
      trimmed,
      trimmed,
      trimmed,
      trimmed,
      trimmed,
      trimmed,
      // ⑨~⑫ 表现 / 评语 / 作业 / 评价报告（按学生）
      ...memberParams,
      ...memberParams,
      ...memberParams,
      ...memberParams,
      // ⑬ 照片（班级照 + 学生照）⑭ 监护人 ⑮ 学生 ⑯ 班级
      trimmed,
      ...memberParams,
      ...memberParams,
      ...memberParams,
      trimmed,
    ]
  );
}

export async function batchUpdateStudentClass(
  studentIds: number[],
  newClass: string
): Promise<void> {
  if (!studentIds.length) return;
  const targetClass = newClass === "未分班" ? "" : newClass.trim();

  if (!isTauri()) {
    const store = mem();
    if (targetClass && !store.classes.includes(targetClass)) {
      store.classes.push(targetClass);
    }
    const idSet = new Set(studentIds);
    const ts = now();
    for (const s of store.students) {
      if (idSet.has(s.id)) {
        s.grade_class = targetClass;
        s.updated_at = ts;
      }
    }
    return;
  }

  const db = await getDb();
  // 建班与批量改班同一写批原子生效
  const placeholders = studentIds.map(() => "?").join(",");
  const statements = [
    `UPDATE students
        SET grade_class = ?, updated_at = datetime('now','localtime')
      WHERE id IN (${placeholders})`,
  ];
  const params: unknown[] = [targetClass, ...studentIds];
  if (targetClass) {
    statements.unshift("INSERT OR IGNORE INTO classes (name) VALUES (?)");
    params.unshift(targetClass);
  }
  await executeBatch(db, statements, params);
}

export async function getClassSummary(name: string): Promise<ClassSummary | null> {
  const classes = await listClasses();
  return classes.find((c) => c.name === name) ?? null;
}

export async function listPhotosByClass(
  className: string,
  filterType: "all" | "public" | "student" = "all"
): Promise<Photo[]> {
  if (!isTauri()) {
    const store = mem();
    const inClass = store.students.filter((s) =>
      className === "未分班" ? !s.grade_class || s.grade_class === "未分班" : s.grade_class === className
    );
    const studentIds = new Set(inClass.map((s) => s.id));

    const isPublic = (p: Photo) => p.grade_class === className && p.student_id === null;
    const isStudent = (p: Photo) => p.student_id !== null && studentIds.has(p.student_id);

    return store.photos
      .filter((p) => {
        if (filterType === "public") return isPublic(p);
        if (filterType === "student") return isStudent(p);
        return isPublic(p) || isStudent(p);
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const db = await getDb();
  if (filterType === "public") {
    return db.select<Photo[]>(
      `SELECT * FROM photos
        WHERE grade_class = ? AND student_id IS NULL
        ORDER BY created_at DESC, id DESC`,
      [className]
    );
  }
  if (filterType === "student") {
    if (className === "未分班") {
      return db.select<Photo[]>(
        `SELECT * FROM photos
          WHERE student_id IN (SELECT id FROM students WHERE grade_class IS NULL OR grade_class = '' OR grade_class = '未分班')
          ORDER BY created_at DESC, id DESC`
      );
    }
    return db.select<Photo[]>(
      `SELECT * FROM photos
        WHERE student_id IN (SELECT id FROM students WHERE grade_class = ?)
        ORDER BY created_at DESC, id DESC`,
      [className]
    );
  }
  // 'all'
  if (className === "未分班") {
    return db.select<Photo[]>(
      `SELECT * FROM photos
        WHERE (grade_class = ? AND student_id IS NULL)
           OR student_id IN (SELECT id FROM students WHERE grade_class IS NULL OR grade_class = '' OR grade_class = '未分班')
        ORDER BY created_at DESC, id DESC`,
      [className]
    );
  }
  return db.select<Photo[]>(
    `SELECT * FROM photos
      WHERE (grade_class = ? AND student_id IS NULL)
         OR student_id IN (SELECT id FROM students WHERE grade_class = ?)
      ORDER BY created_at DESC, id DESC`,
    [className, className]
  );
}

export async function addClassPhoto(
  className: string,
  fileName: string,
  caption: string | null = null,
  takenAt: string | null = null
): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const id = store.nextPhotoId++;
    store.photos.push({
      id,
      student_id: null,
      grade_class: className,
      file_name: fileName,
      caption,
      taken_at: takenAt,
      created_at: now(),
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO photos (student_id, grade_class, file_name, caption, taken_at) VALUES (NULL, ?, ?, ?, ?)",
    [className, fileName, caption, takenAt]
  );
  return Number(result.lastInsertId ?? 0);
}

export async function getStats(): Promise<Stats> {
  if (!isTauri()) {
    const store = mem();
    const month = new Date().toISOString().slice(0, 7);
    return {
      students: store.students.length,
      photos: store.photos.length,
      month_new: store.students.filter((s) => s.created_at.startsWith(month)).length,
    };
  }

  const db = await getDb();
  const rows = await db.select<Stats[]>(
    `SELECT (SELECT COUNT(*) FROM students) AS students,
            (SELECT COUNT(*) FROM photos)   AS photos,
            (SELECT COUNT(*) FROM students
              WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now','localtime')) AS month_new`
  );
  return rows[0] ?? { students: 0, photos: 0, month_new: 0 };
}

