import Database from "@tauri-apps/plugin-sql";
import { DEFAULT_PROFILE } from "../types";
import type { ClassSummary, Photo, Profile, Stats, Student, StudentInput, StudentRow } from "../types";

/** 是否在 Tauri 外壳里运行；浏览器里跑 dev 时走内存兜底，方便调样式。 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DB_URL = "sqlite:aprilio.db";

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).catch((e: unknown) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/* ------------------------------------------------------------------ */
/* 内存兜底：浏览器里也能看到完整界面                                    */
/* ------------------------------------------------------------------ */

interface MemoryStore {
  students: Student[];
  photos: Photo[];
  nextStudentId: number;
  nextPhotoId: number;
}

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function seedStore(): MemoryStore {
  const base = now();
  const names: [string, string, string, string, string][] = [
    ["林知远", "男", "2017-05-12", "三年级二班", "138 0012 8846"],
    ["苏晚", "女", "2017-08-03", "三年级二班", "139 8877 2310"],
    ["陈嘉树", "男", "2016-11-27", "四年级一班", "137 6620 4518"],
    ["周砚", "男", "2016-03-14", "四年级一班", "150 2211 9073"],
    ["何听雨", "女", "2018-01-09", "二年级三班", "186 5540 7782"],
    ["顾星野", "男", "2017-09-30", "二年级三班", "133 9080 3321"],
    ["沈屿", "女", "2017-06-18", "三年级一班", "159 3344 1208"],
    ["温故", "男", "2017-02-21", "三年级一班", "188 0077 6690"],
    ["江雪眠", "女", "2015-12-05", "五年级二班", "132 5511 4477"],
    ["陆时安", "男", "2016-07-16", "五年级二班", "181 2290 3388"],
  ];

  const students: Student[] = names.map(([name, gender, birth, klass, phone], i) => ({
    id: i + 1,
    name,
    gender,
    birth_date: birth,
    student_no: `2023000${String(1 + i)}`,
    grade_class: klass,
    enroll_date: "2024-09-01",
    guardian_name: `${name.slice(0, 1)}建国（父亲）`,
    guardian_phone: phone,
    address: "杭州市西湖区文三路 128 号",
    status: "active",
    note: null,
    created_at: base,
    updated_at: base,
  }));

  const captions = ["校园运动会", "科学课实验", "期中表彰", "课外阅读", "春游合影"];
  const photos: Photo[] = [];
  let pid = 1;

  photos.push({
    id: pid++,
    student_id: null,
    grade_class: "三年级二班",
    file_name: "demo-class-32.jpg",
    caption: "三年级二班开学集体合影",
    taken_at: "2026-09-01",
    created_at: base,
  });

  for (const s of students) {
    const count = 3 + (s.id % 5);
    for (let i = 0; i < count; i++) {
      photos.push({
        id: pid++,
        student_id: s.id,
        file_name: `demo-${s.id}-${i + 1}.jpg`,
        caption: captions[(s.id + i) % captions.length],
        taken_at: "2026-08-20",
        created_at: base,
      });
    }
  }

  return { students, photos, nextStudentId: 11, nextPhotoId: pid };
}

let memory: MemoryStore | null = null;
function mem(): MemoryStore {
  if (!memory) memory = seedStore();
  return memory;
}

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
      if (gradeClass === "未分班") return !s.grade_class;
      return s.grade_class === gradeClass;
    };
    return store.students
      .filter(byClass)
      .filter(
        (s) =>
          !k || s.name.toLowerCase().includes(k) || s.student_no.toLowerCase().includes(k)
      )
      .map((s) => ({
        ...s,
        photo_count: store.photos.filter((p) => p.student_id === s.id).length,
      }))
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
      conditions.push("(s.grade_class IS NULL OR s.grade_class = '')");
    } else {
      conditions.push("s.grade_class = ?");
      params.push(gradeClass);
    }
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.select<StudentRow[]>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id) AS photo_count
       FROM students s
      ${whereClause}
      ORDER BY s.updated_at DESC, s.id DESC`,
    params
  );
}

export async function getStudent(id: number): Promise<Student | null> {
  if (!isTauri()) return mem().students.find((s) => s.id === id) ?? null;
  const db = await getDb();
  const rows = await db.select<Student[]>("SELECT * FROM students WHERE id = ?", [id]);
  return rows[0] ?? null;
}

export async function createStudent(input: StudentInput): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const id = store.nextStudentId++;
    const ts = now();
    store.students.push({ ...input, id, created_at: ts, updated_at: ts });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO students
       (name, gender, birth_date, student_no, grade_class, enroll_date,
        guardian_name, guardian_phone, address, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.student_no,
      input.grade_class,
      input.enroll_date,
      input.guardian_name,
      input.guardian_phone,
      input.address,
      input.status,
      input.note,
    ]
  );
  return Number(result.lastInsertId ?? 0);
}

export async function updateStudent(id: number, input: StudentInput): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.students.findIndex((s) => s.id === id);
    if (idx >= 0) store.students[idx] = { ...store.students[idx], ...input, updated_at: now() };
    return;
  }

  const db = await getDb();
  await db.execute(
    `UPDATE students
        SET name = ?, gender = ?, birth_date = ?, student_no = ?, grade_class = ?,
            enroll_date = ?, guardian_name = ?, guardian_phone = ?, address = ?,
            status = ?, note = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.student_no,
      input.grade_class,
      input.enroll_date,
      input.guardian_name,
      input.guardian_phone,
      input.address,
      input.status,
      input.note,
      id,
    ]
  );
}

export async function deleteStudent(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.students = store.students.filter((s) => s.id !== id);
    store.photos = store.photos.filter((p) => p.student_id !== id);
    return;
  }

  const db = await getDb();
  await db.execute("DELETE FROM photos WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM students WHERE id = ?", [id]);
}

export async function listPhotos(studentId?: number): Promise<Photo[]> {
  if (!isTauri()) {
    return mem()
      .photos.filter((p) => studentId === undefined || p.student_id === studentId)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  const db = await getDb();
  return db.select<Photo[]>(
    `SELECT * FROM photos
      WHERE (? IS NULL OR student_id = ?)
      ORDER BY created_at DESC, id DESC`,
    [studentId ?? null, studentId ?? null]
  );
}

export async function addPhoto(
  studentId: number,
  fileName: string,
  caption: string | null = null,
  takenAt: string | null = null
): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const id = store.nextPhotoId++;
    store.photos.push({
      id,
      student_id: studentId,
      file_name: fileName,
      caption,
      taken_at: takenAt,
      created_at: now(),
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO photos (student_id, file_name, caption, taken_at) VALUES (?, ?, ?, ?)",
    [studentId, fileName, caption, takenAt]
  );
  return Number(result.lastInsertId ?? 0);
}

export async function deletePhoto(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.photos = store.photos.filter((p) => p.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM photos WHERE id = ?", [id]);
}

export async function listClasses(): Promise<ClassSummary[]> {
  let students: Student[];
  let photos: Photo[];

  if (!isTauri()) {
    const store = mem();
    students = store.students;
    photos = store.photos;
  } else {
    const db = await getDb();
    students = await db.select<Student[]>("SELECT * FROM students");
    photos = await db.select<Photo[]>("SELECT * FROM photos");
  }

  const classNames = new Set<string>();
  for (const s of students) {
    classNames.add(s.grade_class || "未分班");
  }
  for (const p of photos) {
    if (p.grade_class) classNames.add(p.grade_class);
  }

  const summaries: ClassSummary[] = [];
  for (const name of classNames) {
    const inClass = students.filter((s) =>
      name === "未分班" ? !s.grade_class || s.grade_class === "未分班" : s.grade_class === name
    );
    const studentIds = new Set(inClass.map((s) => s.id));

    const studentCount = inClass.length;
    const maleCount = inClass.filter((s) => s.gender === "男" || s.gender === "male").length;
    const femaleCount = inClass.filter((s) => s.gender === "女" || s.gender === "female").length;

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
    });
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name, "zh"));
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

/* ------------------------------------------------------------------ */
/* 个人资料（单条记录，id 恒为 1）                                       */
/* ------------------------------------------------------------------ */

let memProfile: Profile = { ...DEFAULT_PROFILE };

export async function getProfile(): Promise<Profile> {
  if (!isTauri()) return { ...memProfile };

  const db = await getDb();
  const rows = await db.select<Profile[]>(
    "SELECT name, title, motto, avatar, hero FROM profile WHERE id = 1"
  );
  return { ...DEFAULT_PROFILE, ...(rows[0] ?? {}) };
}

export async function saveProfile(p: Profile): Promise<void> {
  if (!isTauri()) {
    memProfile = { ...p };
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO profile (id, name, title, motto, avatar, hero, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET
          name       = excluded.name,
          title      = excluded.title,
          motto      = excluded.motto,
          avatar     = excluded.avatar,
          hero       = excluded.hero,
          updated_at = excluded.updated_at`,
    [p.name, p.title, p.motto, p.avatar, p.hero]
  );
}

/** 清空所有数据（设置页用） */
export async function clearAll(): Promise<void> {
  if (!isTauri()) {
    memory = seedStore();
    memory.students = [];
    memory.photos = [];
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM photos");
  await db.execute("DELETE FROM students");
}
