import Database from "@tauri-apps/plugin-sql";
import { localDateStr } from "./format";
import { DEFAULT_PROFILE } from "../types";
import type {
  BehaviorDimension,
  BehaviorInput,
  ClassBehaviorRecord,
  ClassSummary,
  CommentPreset,
  Gender,
  Guardian,
  Photo,
  Profile,
  Stats,
  Student,
  StudentBehaviorRecord,
  StudentInput,
  StudentRow,
} from "../types";

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
  classes: string[];
  guardians: Guardian[];
  behaviorDimensions: BehaviorDimension[];
  behaviorRecords: StudentBehaviorRecord[];
  commentPresets: (CommentPreset & { last_used_at: string })[];
  nextStudentId: number;
  nextPhotoId: number;
  nextGuardianId: number;
  nextDimensionId: number;
  nextBehaviorRecordId: number;
  nextCommentPresetId: number;
}

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/** 与 Rust Migration 5 的种子数据保持一致，浏览器演示态/单测共用 */
const BEHAVIOR_DIMENSIONS: BehaviorDimension[] = [
  { id: 1, category: "study", code: "homework", name: "作业情况", icon: "BookOpen", sort_order: 1, is_system: 1, is_active: 1 },
  { id: 2, category: "study", code: "exam", name: "单元/期中期末成绩", icon: "GraduationCap", sort_order: 2, is_system: 1, is_active: 1 },
  { id: 3, category: "behavior", code: "classroom", name: "课堂表现", icon: "MessageSquare", sort_order: 3, is_system: 1, is_active: 1 },
  { id: 4, category: "behavior", code: "labor", name: "劳动情况", icon: "Sparkles", sort_order: 4, is_system: 1, is_active: 1 },
];

const BEHAVIOR_PRESET_SEED: [number, CommentPreset["type"], string][] = [
  [1, "praise", "书写工整规范，解题步骤完整清晰"],
  [1, "praise", "按时独立完成作业，正确率极高"],
  [1, "improve", "作业未按时提交，需及时补交"],
  [1, "improve", "错题漏题较多，未进行及时订正"],
  [1, "neutral", "作业按时完成，整体表现平稳"],
  [2, "praise", "测试成绩名列前茅，基础扎实知识掌握牢固"],
  [2, "praise", "较上次有显著进步，难题突破能力提升"],
  [2, "improve", "基础计算失误较多，需加强审题与验算习惯"],
  [2, "improve", "重点知识点有脱节，需针对性复习补漏"],
  [2, "neutral", "成绩处于班级平均水平，保持学习节奏"],
  [3, "praise", "课堂听讲专注，积极举手发言发表独到见解"],
  [3, "praise", "互动热烈，能主动带动小组讨论探索"],
  [3, "improve", "课堂听讲容易走神，需要老师多次提醒注意集中"],
  [3, "improve", "自控力较弱，有做小动作或讲话现象"],
  [3, "neutral", "课堂表现平稳，能按时完成课堂任务"],
  [4, "praise", "主动承担卫生大扫除，擦黑板和整理卫生角非常细致"],
  [4, "praise", "值日尽职尽责，主动帮助其他同学整理桌椅"],
  [4, "improve", "值日敷衍草率，未完成清洁任务提前离开"],
  [4, "improve", "缺乏公共卫生意识，桌面及周围杂物未整理"],
  [4, "neutral", "按安排完成值日任务"],
];

function seedStore(): MemoryStore {
  const base = now();
  const names: [string, Gender, string, string, string][] = [
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

  const guardians: Guardian[] = [];
  let gid = 1;

  const students: Student[] = names.map(([name, gender, birth, klass, phone], i) => {
    const sid = i + 1;
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}建国`,
      phone,
      relation: "父亲",
      is_primary: true,
    });
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}秀英`,
      phone: phone.replace("8", "9"),
      relation: "母亲",
      is_primary: false,
    });
    return {
      id: sid,
      name,
      gender,
      birth_date: birth,
      student_no: `2023000${String(1 + i)}`,
      grade_class: klass,
      enroll_date: "2024-09-01",
      address: "杭州市西湖区文三路 128 号",
      status: "active",
      note: null,
      guardians: [],
      created_at: base,
      updated_at: base,
    };
  });

  for (const s of students) {
    s.guardians = guardians.filter((g) => g.student_id === s.id);
  }

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

  const initialClasses = Array.from(
    new Set(students.map((s) => s.grade_class).filter(Boolean))
  );

  return {
    students,
    photos,
    classes: initialClasses,
    guardians,
    behaviorDimensions: BEHAVIOR_DIMENSIONS.map((d) => ({ ...d })),
    behaviorRecords: [],
    commentPresets: BEHAVIOR_PRESET_SEED.map(([dimensionId, type, content], i) => ({
      id: i + 1,
      dimension_id: dimensionId,
      type,
      content,
      use_count: 1,
      source: "system" as const,
      last_used_at: base,
    })),
    nextStudentId: 11,
    nextPhotoId: pid,
    nextGuardianId: gid,
    nextDimensionId: BEHAVIOR_DIMENSIONS.length + 1,
    nextBehaviorRecordId: 1,
    nextCommentPresetId: BEHAVIOR_PRESET_SEED.length + 1,
  };
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
      guardians: sGuardians,
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
    guardians: guardians.map((g) => ({ ...g, is_primary: Boolean(g.is_primary) })),
  };
}

export async function createStudent(input: StudentInput): Promise<number> {
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
       (name, gender, birth_date, student_no, grade_class, enroll_date,
        address, status, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.student_no,
      input.grade_class,
      input.enroll_date,
      input.address,
      input.status,
      input.note,
    ]
  );
  const studentId = Number(result.lastInsertId ?? 0);
  if (studentId && input.guardians?.length) {
    for (const g of input.guardians) {
      await db.execute(
        "INSERT INTO guardians (student_id, name, phone, relation, is_primary) VALUES (?, ?, ?, ?, ?)",
        [studentId, g.name, g.phone, g.relation, g.is_primary ? 1 : 0]
      );
    }
  }
  return studentId;
}

export async function updateStudent(id: number, input: StudentInput): Promise<void> {
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
  await db.execute(
    `UPDATE students
        SET name = ?, gender = ?, birth_date = ?, student_no = ?, grade_class = ?,
            enroll_date = ?, address = ?, status = ?, note = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [
      input.name,
      input.gender,
      input.birth_date,
      input.student_no,
      input.grade_class,
      input.enroll_date,
      input.address,
      input.status,
      input.note,
      id,
    ]
  );
  await db.execute("DELETE FROM guardians WHERE student_id = ?", [id]);
  if (input.guardians?.length) {
    for (const g of input.guardians) {
      await db.execute(
        "INSERT INTO guardians (student_id, name, phone, relation, is_primary) VALUES (?, ?, ?, ?, ?)",
        [id, g.name, g.phone, g.relation, g.is_primary ? 1 : 0]
      );
    }
  }
}

export async function deleteStudent(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.students = store.students.filter((s) => s.id !== id);
    store.photos = store.photos.filter((p) => p.student_id !== id);
    store.guardians = store.guardians.filter((g) => g.student_id !== id);
    store.behaviorRecords = store.behaviorRecords.filter((r) => r.student_id !== id);
    return;
  }

  const db = await getDb();
  await db.execute("DELETE FROM guardians WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM photos WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM student_behavior_records WHERE student_id = ?", [id]);
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
  const classNames = new Set<string>();

  if (!isTauri()) {
    const store = mem();
    students = store.students;
    photos = store.photos;
    for (const c of store.classes) {
      if (c && c !== "未分班") classNames.add(c);
    }
  } else {
    const db = await getDb();
    students = await db.select<Student[]>("SELECT * FROM students");
    photos = await db.select<Photo[]>("SELECT * FROM photos");
    try {
      const explicitClasses = await db.select<{ name: string }[]>("SELECT name FROM classes");
      for (const row of explicitClasses) {
        if (row.name && row.name !== "未分班") classNames.add(row.name);
      }
    } catch {
      // 兼容尚未执行 Migration 3 的环境
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
    return;
  }

  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [trimmed]);
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
    return;
  }

  const db = await getDb();
  await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [newTrimmed]);
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
  try {
    await db.execute("DELETE FROM classes WHERE name = ?", [oldTrimmed]);
  } catch {}
}

export async function deleteClass(name: string, reassignToUnassigned = true): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === "未分班") throw new Error("系统「未分班」分类不能删除");

  if (!isTauri()) {
    const store = mem();
    store.classes = store.classes.filter((c) => c !== trimmed);
    if (reassignToUnassigned) {
      const ts = now();
      for (const s of store.students) {
        if (s.grade_class === trimmed) {
          s.grade_class = "";
          s.updated_at = ts;
        }
      }
      for (const p of store.photos) {
        if (p.grade_class === trimmed) {
          p.grade_class = null;
        }
      }
    }
    return;
  }

  const db = await getDb();
  try {
    await db.execute("DELETE FROM classes WHERE name = ?", [trimmed]);
  } catch {}
  if (reassignToUnassigned) {
    await db.execute(
      "UPDATE students SET grade_class = '', updated_at = datetime('now','localtime') WHERE grade_class = ?",
      [trimmed]
    );
    await db.execute("UPDATE photos SET grade_class = NULL WHERE grade_class = ?", [trimmed]);
  }
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
  if (targetClass) {
    try {
      await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [targetClass]);
    } catch {}
  }
  const placeholders = studentIds.map(() => "?").join(",");
  await db.execute(
    `UPDATE students
        SET grade_class = ?, updated_at = datetime('now','localtime')
      WHERE id IN (${placeholders})`,
    [targetClass, ...studentIds]
  );
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
    memory.classes = [];
    memory.guardians = [];
    memory.behaviorRecords = [];
    return;
  }
  const db = await getDb();
  try {
    await db.execute("DELETE FROM guardians");
  } catch {}
  await db.execute("DELETE FROM photos");
  await db.execute("DELETE FROM students");
  await db.execute("DELETE FROM student_behavior_records");
  try {
    await db.execute("DELETE FROM classes");
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 日常表现：维度字典 / 事实流水 / 评语沉淀（三层范式）                     */
/* ------------------------------------------------------------------ */

/** 维度字典列表（启用中的，按 sort_order 排序） */
export async function listBehaviorDimensions(): Promise<BehaviorDimension[]> {
  if (!isTauri()) {
    return mem()
      .behaviorDimensions.filter((d) => d.is_active)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  }
  const db = await getDb();
  return db.select<BehaviorDimension[]>(
    "SELECT * FROM behavior_dimensions WHERE is_active = 1 ORDER BY sort_order ASC, id ASC"
  );
}

/** 新增自定义维度（is_system = 0，category 固定 other，code 自动生成） */
export async function createBehaviorDimension(name: string): Promise<BehaviorDimension> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("维度名称不能为空");
  if (trimmed.length > 12) throw new Error("维度名称请控制在 12 字以内");

  const code = `custom_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

  if (!isTauri()) {
    const store = mem();
    const maxOrder = Math.max(0, ...store.behaviorDimensions.map((d) => d.sort_order));
    const dim: BehaviorDimension = {
      id: store.nextDimensionId++,
      category: "other",
      code,
      name: trimmed,
      icon: null,
      sort_order: maxOrder + 1,
      is_system: 0,
      is_active: 1,
    };
    store.behaviorDimensions.push(dim);
    return { ...dim };
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO behavior_dimensions (category, code, name, icon, sort_order, is_system)
     VALUES ('other', ?, ?, NULL,
       (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM behavior_dimensions), 0)`,
    [code, trimmed]
  );
  const id = Number(result.lastInsertId ?? 0);
  return {
    id,
    category: "other",
    code,
    name: trimmed,
    icon: null,
    sort_order: 0,
    is_system: 0,
    is_active: 1,
  };
}

/**
 * 写入一条表现流水，并同步评语沉淀（自学习闭环）：
 * 已有同 (维度, 倾向, 内容) 词条 → use_count+1；没有 → 新增 source='history'。
 */
export async function addBehaviorRecord(input: BehaviorInput): Promise<number> {
  if (!input.student_id) throw new Error("缺少学生");
  const comment = input.comment.trim();
  if (!comment) throw new Error("评语内容不能为空");
  if (comment.length > 200) throw new Error("评语请控制在 200 字以内");
  if (input.type !== "praise" && input.type !== "improve" && input.type !== "neutral")
    throw new Error("评价倾向不合法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.recorded_date)) throw new Error("日期格式不合法");
  if (input.recorded_date > localDateStr()) throw new Error("不能录入未来日期");

  if (!isTauri()) {
    const store = mem();
    const dim = store.behaviorDimensions.find((d) => d.id === input.dimension_id);
    if (!dim) throw new Error("评价维度不存在");

    const id = store.nextBehaviorRecordId++;
    store.behaviorRecords.push({
      id,
      student_id: input.student_id,
      dimension_id: dim.id,
      dimension_name_snap: dim.name,
      category_snap: dim.category,
      type: input.type,
      comment,
      recorded_date: input.recorded_date,
      created_at: now(),
    });

    const preset = store.commentPresets.find(
      (p) => p.dimension_id === dim.id && p.type === input.type && p.content === comment
    );
    if (preset) {
      preset.use_count += 1;
      preset.last_used_at = now();
    } else {
      store.commentPresets.push({
        id: store.nextCommentPresetId++,
        dimension_id: dim.id,
        type: input.type,
        content: comment,
        use_count: 1,
        source: "history",
        last_used_at: now(),
      });
    }
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO student_behavior_records
       (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.student_id,
      input.dimension_id,
      input.dimension_name_snap,
      input.category_snap,
      input.type,
      comment,
      input.recorded_date,
    ]
  );

  const existing = await db.select<{ id: number }[]>(
    `SELECT id FROM behavior_comment_presets
      WHERE dimension_id = ? AND type = ? AND content = ? LIMIT 1`,
    [input.dimension_id, input.type, comment]
  );
  if (existing[0]) {
    await db.execute(
      `UPDATE behavior_comment_presets
          SET use_count = use_count + 1, last_used_at = datetime('now','localtime')
        WHERE id = ?`,
      [existing[0].id]
    );
  } else {
    await db.execute(
      `INSERT INTO behavior_comment_presets (dimension_id, type, content, use_count, source)
       VALUES (?, ?, ?, 1, 'history')`,
      [input.dimension_id, input.type, comment]
    );
  }
  return Number(result.lastInsertId ?? 0);
}

/** 常用评语：按使用频次取前 N 条（默认 4） */
export async function listCommentPresets(
  dimensionId: number,
  type: CommentPreset["type"],
  limit = 4
): Promise<CommentPreset[]> {
  if (!isTauri()) {
    return mem()
      .commentPresets.filter((p) => p.dimension_id === dimensionId && p.type === type)
      .sort(
        (a, b) => b.use_count - a.use_count || (a.last_used_at < b.last_used_at ? 1 : -1) || a.id - b.id
      )
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        dimension_id: p.dimension_id,
        type: p.type,
        content: p.content,
        use_count: p.use_count,
        source: p.source,
      }));
  }
  const db = await getDb();
  return db.select<CommentPreset[]>(
    `SELECT id, dimension_id, type, content, use_count, source
       FROM behavior_comment_presets
      WHERE dimension_id = ? AND type = ?
      ORDER BY use_count DESC, last_used_at DESC, id ASC
      LIMIT ?`,
    [dimensionId, type, limit]
  );
}

/** 表现流水查询（详情页/统计用，默认最近 100 条） */
export async function listBehaviorRecords(
  studentId?: number,
  limit = 100
): Promise<StudentBehaviorRecord[]> {
  if (!isTauri()) {
    return mem()
      .behaviorRecords.filter((r) => studentId === undefined || r.student_id === studentId)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  const db = await getDb();
  return db.select<StudentBehaviorRecord[]>(
    `SELECT * FROM student_behavior_records
      WHERE (? IS NULL OR student_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [studentId ?? null, studentId ?? null, limit]
  );
}

/** 班级表现流水查询（班级管理时间轴用，带学生基本快照信息） */
export async function listBehaviorRecordsByClass(
  className: string,
  limit = 200
): Promise<ClassBehaviorRecord[]> {
  if (!isTauri()) {
    const store = mem();
    const classStudents = store.students.filter((s) => s.grade_class === className);
    const studentMap = new Map(classStudents.map((s) => [s.id, s]));
    return store.behaviorRecords
      .filter((r) => studentMap.has(r.student_id))
      .map((r) => {
        const s = studentMap.get(r.student_id)!;
        return {
          ...r,
          student_name: s.name,
          student_no: s.student_no,
          student_gender: s.gender,
        };
      })
      .sort((a, b) => {
        const da = a.recorded_date || a.created_at;
        const db = b.recorded_date || b.created_at;
        if (da !== db) return da < db ? 1 : -1;
        return b.id - a.id;
      })
      .slice(0, limit);
  }
  const db = await getDb();
  return db.select<ClassBehaviorRecord[]>(
    `SELECT 
      r.*,
      s.name AS student_name,
      s.student_no,
      s.gender AS student_gender
    FROM student_behavior_records r
    INNER JOIN students s ON r.student_id = s.id
    WHERE s.grade_class = ?
    ORDER BY r.recorded_date DESC, r.created_at DESC, r.id DESC
    LIMIT ?`,
    [className, limit]
  );
}
