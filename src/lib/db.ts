import Database from "@tauri-apps/plugin-sql";
import { localDateStr } from "./format";
import {
  computeExamStats,
  computeStudentTotals,
  inferExamType,
  rankBySubject,
  rankByTotal,
  subjectAverages,
  trendOf,
} from "./score-analysis";
import { scoreLines } from "./score-config";
import { currentSemester, normalizeMySubjects, parseMySubjectsJson, parsePeriodsJson } from "./timetable";
import { DEFAULT_PROFILE } from "../types";
import type {
  BehaviorDimension,
  BehaviorInput,
  CalendarEvent,
  CalendarEventType,
  ClassBehaviorRecord,
  ClassExamTrendPoint,
  ClassScoreOverviewRow,
  ClassSnapshot,
  ClassSummary,
  CommentPreset,
  Exam,
  ExamInput,
  ExamScore,
  ExamScoreRow,
  ExamType,
  ExamWithStats,
  Gender,
  Guardian,
  Photo,
  Profile,
  RecycleEntityType,
  RecycleItem,
  Student,
  StudentBehaviorRecord,
  StudentExamReport,
  StudentExamScore,
  StudentExamSubject,
  StudentInput,
  StudentRow,
  StudentScoreReport,
  StudentSnapshot,
  Stats,
  Timetable,
  TimetableException,
  TimetableExceptionWithClass,
  TimetablePeriod,
  TimetableSlot,
  TimetableSlotWithClass,
} from "../types";
import { RECYCLE_RETENTION_DAYS } from "../types";

/** 是否在 Tauri 外壳里运行；浏览器里跑 dev 时走内存兜底，方便调样式。 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DB_URL = "sqlite:aprilio.db";

let dbPromise: Promise<Database> | null = null;

/**
 * 前端持有的表结构契约（与 src-tauri/src/lib.rs 迁移保持同构，tests/schema-sync.test.ts 对账）。
 * 启动时幂等执行一遍：即使本地调试库的迁移版本历史与代码不一致
 * （例如版本号曾被历史迁移占用，导致新迁移被跳过），也不会出现「no such table」。
 */
const SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS students (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL DEFAULT '',
    gender      TEXT NOT NULL DEFAULT '男',
    birth_date  TEXT,
    student_no  TEXT,
    grade_class TEXT,
    id_card     TEXT,
    address     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS guardians (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    relation   TEXT NOT NULL DEFAULT '监护人',
    is_primary INTEGER NOT NULL DEFAULT 0,
    occupation TEXT NOT NULL DEFAULT '',
    tags       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_guardians_student_id ON guardians(student_id)`,
  `CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER,
    grade_class TEXT,
    file_name   TEXT NOT NULL,
    caption     TEXT,
    taken_at    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS classes (
    name       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS profile (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    motto        TEXT NOT NULL DEFAULT '',
    avatar       TEXT NOT NULL DEFAULT '',
    hero         TEXT NOT NULL DEFAULT '',
    my_subjects  TEXT,
    timetable_bg TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `INSERT INTO profile (id) VALUES (1) ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS behavior_dimensions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL DEFAULT 'study',
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    icon        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_system   INTEGER NOT NULL DEFAULT 1,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS student_behavior_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id          INTEGER NOT NULL,
    dimension_id        INTEGER NOT NULL,
    dimension_name_snap TEXT NOT NULL,
    category_snap       TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'praise',
    comment             TEXT NOT NULL,
    recorded_date       TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_student_date ON student_behavior_records(student_id, recorded_date)`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_recorded_date ON student_behavior_records(recorded_date)`,
  `CREATE INDEX IF NOT EXISTS idx_behavior_dimension ON student_behavior_records(dimension_id)`,
  `CREATE TABLE IF NOT EXISTS behavior_comment_presets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension_id INTEGER NOT NULL,
    type         TEXT NOT NULL DEFAULT 'praise',
    content      TEXT NOT NULL,
    use_count    INTEGER NOT NULL DEFAULT 1,
    source       TEXT NOT NULL DEFAULT 'system',
    last_used_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comment_presets_dim_type ON behavior_comment_presets(dimension_id, type, use_count DESC)`,
  `CREATE TABLE IF NOT EXISTS recycle_bin (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    label       TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL,
    deleted_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON recycle_bin(deleted_at)`,
  `CREATE TABLE IF NOT EXISTS exams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name  TEXT NOT NULL,
    name        TEXT NOT NULL,
    exam_date   TEXT NOT NULL,
    exam_type   TEXT NOT NULL DEFAULT 'minor',
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exams_class_date ON exams(class_name, exam_date)`,
  `CREATE TABLE IF NOT EXISTS exam_scores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id     INTEGER NOT NULL,
    student_id  INTEGER NOT NULL,
    subject     TEXT NOT NULL,
    score       REAL,
    grade       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (exam_id, student_id, subject),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exam_scores_student ON exam_scores(student_id)`,
  `CREATE TABLE IF NOT EXISTS timetables (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name   TEXT NOT NULL,
    semester     TEXT NOT NULL,
    note         TEXT,
    periods_json TEXT,
    my_subjects  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (class_name, semester)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_timetables_class ON timetables(class_name, semester)`,
  `CREATE TABLE IF NOT EXISTS timetable_slots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id INTEGER NOT NULL,
    day_of_week  INTEGER NOT NULL,
    period       INTEGER NOT NULL,
    subject      TEXT NOT NULL DEFAULT '',
    note         TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (timetable_id, day_of_week, period),
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_timetable_slots_timetable ON timetable_slots(timetable_id)`,
  `CREATE TABLE IF NOT EXISTS timetable_exceptions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timetable_id   INTEGER NOT NULL,
    exception_date TEXT NOT NULL,
    period         INTEGER NOT NULL,
    subject        TEXT NOT NULL DEFAULT '',
    note           TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (timetable_id, exception_date, period),
    FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_timetable_exceptions_date ON timetable_exceptions(exception_date)`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name TEXT,
    event_date TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'memo',
    period     INTEGER,
    content    TEXT NOT NULL,
    title      TEXT,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date)`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_events_class_date ON calendar_events(class_name, event_date)`,
];

/**
 * 旧 calendar_memos（v3 及以前）→ calendar_events（v4 起）的一次性数据迁移。
 * 迁移已在 v4 SQL 里做过；这里兜底「迁移历史混乱、v4 被跳过但 ensureSchema 已建新表」
 * 的调试库：能查到旧表就把数据搬过去再删旧表，查不到（正常路径）就静默跳过。
 */
export async function migrateLegacyCalendarMemos(db: Database): Promise<void> {
  let legacy: { class_name: string; memo_date: string; content: string; done: number }[];
  try {
    legacy = await db.select(
      "SELECT class_name, memo_date, content, done FROM calendar_memos WHERE TRIM(content) != ''"
    );
  } catch {
    return; // 旧表不存在：v4 已迁移并删除
  }
  for (const m of legacy) {
    await db.execute(
      "INSERT INTO calendar_events (class_name, event_date, type, content, done) VALUES (?, ?, 'memo', ?, ?)",
      [m.class_name, m.memo_date, m.content, m.done]
    );
  }
  await db.execute("DROP TABLE calendar_memos");
}

async function ensureSchema(db: Database): Promise<void> {
  for (const sql of SCHEMA_DDL) {
    await db.execute(sql);
  }
  try {
    // 旧代库 students 表没有 id_card（v1 收敛建表对已存在的表不生效）：幂等补列，
    // 否则 listStudents / createStudent / updateStudent 全部报 "no column named id_card"
    await db.execute("ALTER TABLE students ADD COLUMN id_card TEXT");
  } catch {
    /* 列已存在 */
  }
  try {
    await db.execute("ALTER TABLE profile ADD COLUMN my_subjects TEXT");
  } catch {
    /* 列已存在：迁移或上次启动已补齐 */
  }
  try {
    // 班级「我的科目」标记（2026-09-08）：旧库幂等补列；NULL = 未标记回退全局任教学科
    await db.execute("ALTER TABLE timetables ADD COLUMN my_subjects TEXT");
  } catch {
    /* 列已存在 */
  }
  try {
    // 首页课表面板背景图（2026-09-08）：文件名 / dataURL；空串 = 无图
    await db.execute("ALTER TABLE profile ADD COLUMN timetable_bg TEXT");
  } catch {
    /* 列已存在 */
  }
  try {
    // 日程事件绑定节次（2026-09-07）：旧库幂等补列；period 为 NULL = 全天/日报事件
    await db.execute("ALTER TABLE calendar_events ADD COLUMN period INTEGER");
  } catch {
    /* 列已存在 */
  }
  try {
    // 日程事件 AI 快速浏览标题（2026-09-07）：旧库幂等补列；NULL = 未生成（未配置 AI 退回前几字）
    await db.execute("ALTER TABLE calendar_events ADD COLUMN title TEXT");
  } catch {
    /* 列已存在 */
  }
  try {
    // 考试种类 大考/小考（2026-09-09）：旧库幂等补列；默认按小考，导入时按考试名自动判定
    await db.execute("ALTER TABLE exams ADD COLUMN exam_type TEXT NOT NULL DEFAULT 'minor'");
  } catch {
    /* 列已存在 */
  }
  await migrateLegacyCalendarMemos(db);
}

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = (async () => {
      try {
        const db = await Database.load(DB_URL);
        await ensureSchema(db);
        return db;
      } catch (firstError) {
        // tauri-plugin-sql 的迁移列表是一次性消费（load 内部 remove）：
        // 首次 load 若因迁移校验失败被拒（如历史库 checksum 与源码不一致），
        // 重试会跳过迁移直接拿到连接池，表结构由 ensureSchema 幂等兜底。
        // 落盘首次失败便于排查，两次都失败才是真故障。
        console.error(
          "[renderer] Database.load 首次失败（多为迁移校验问题），正在重试跳过迁移：",
          firstError instanceof Error ? firstError.message : firstError,
        );
        const db = await Database.load(DB_URL);
        await ensureSchema(db);
        return db;
      }
    })().catch((e: unknown) => {
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
  recycleBin: RecycleItem[];
  exams: Exam[];
  examScores: ExamScore[];
  timetables: Timetable[];
  timetableSlots: TimetableSlot[];
  timetableExceptions: TimetableException[];
  calendarEvents: CalendarEvent[];
  nextStudentId: number;
  nextPhotoId: number;
  nextGuardianId: number;
  nextDimensionId: number;
  nextBehaviorRecordId: number;
  nextCommentPresetId: number;
  nextRecycleId: number;
  nextExamId: number;
  nextExamScoreId: number;
  nextTimetableId: number;
  nextTimetableSlotId: number;
  nextTimetableExceptionId: number;
  nextCalendarEventId: number;
}

/** 与 SQLite datetime('now','localtime') 同格式的本地时间戳 */
const now = () => fmtLocalTs(new Date());

/** 与 Rust 迁移种子数据保持一致，浏览器演示态/单测共用 */
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
    // 四年级一班补足到 10 人：与 docs/examples/成绩单-四年级一班-*.csv 样例对应，
    // 让「班级成绩 / 个人成绩」面板在浏览器演示态即有完整的班级统计与排名。
    ["赵晨曦", "女", "2016-04-18", "四年级一班", "137 5566 1201"],
    ["钱雨泽", "男", "2016-09-02", "四年级一班", "138 2233 4502"],
    ["孙梦琪", "女", "2016-06-25", "四年级一班", "139 6688 7303"],
    ["李承宇", "男", "2016-02-11", "四年级一班", "150 3344 8604"],
    ["周思远", "男", "2016-12-08", "四年级一班", "151 7788 9905"],
    ["吴佳怡", "女", "2016-08-19", "四年级一班", "158 1122 2306"],
    ["郑子轩", "男", "2016-05-30", "四年级一班", "159 4455 6607"],
    ["王诗雅", "女", "2016-10-14", "四年级一班", "180 6677 8808"],
  ];

  const guardians: Guardian[] = [];
  let gid = 1;
  const fatherJobs = ["工程师", "个体经营", "公务员", "司机", "销售"];
  const motherJobs = ["教师", "护士", "会计", "全职妈妈", "设计师"];

  const students: Student[] = names.map(([name, gender, birth, klass, phone], i) => {
    const sid = i + 1;
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}建国`,
      phone,
      relation: "父亲",
      is_primary: true,
      occupation: fatherJobs[i % fatherJobs.length],
      tags: i % 2 === 0 ? ["积极配合"] : ["严格"],
    });
    guardians.push({
      id: gid++,
      student_id: sid,
      name: `${name.slice(0, 1)}秀英`,
      phone: phone.replace("8", "9"),
      relation: "母亲",
      is_primary: false,
      occupation: motherJobs[i % motherJobs.length],
      tags: ["沟通顺畅"],
    });
    return {
      id: sid,
      name,
      gender,
      birth_date: birth,
      student_no: `2023000${String(1 + i)}`,
      grade_class: klass,
      id_card: null,
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

  // 演示课表：三年级二班整周 + 三年级一班少量格子；
  // 周一第 2 节两个班都有语文 → 演示「我的课表」跨班聚合与撞课告警
  const demoTimetableEntries: [string, [number, number, string, string?][]][] = [
    [
      "三年级二班",
      [
        [1, 1, "数学"],
        [1, 2, "语文"],
        [1, 3, "英语"],
        [1, 5, "体育"],
        [1, 6, "音乐"],
        [2, 1, "语文"],
        [2, 2, "数学"],
        [2, 3, "美术"],
        [2, 5, "道德与法治"],
        [3, 1, "语文"],
        [3, 2, "数学"],
        [3, 3, "科学"],
        [3, 5, "信息科技", "去机房"],
        [4, 1, "数学"],
        [4, 2, "语文"],
        [4, 3, "体育"],
        [4, 5, "劳动"],
        [5, 1, "英语"],
        [5, 2, "数学"],
        [5, 3, "语文"],
        [5, 5, "班会"],
      ],
    ],
    [
      "三年级一班",
      [
        [1, 1, "数学"],
        [1, 2, "语文"],
        [1, 3, "英语"],
        [3, 1, "语文"],
        [3, 2, "数学"],
        [5, 3, "语文"],
      ],
    ],
  ];

  const semester = currentSemester();
  const timetables: Timetable[] = [];
  const timetableSlots: TimetableSlot[] = [];
  let timetableId = 1;
  let slotId = 1;
  for (const [className, entries] of demoTimetableEntries) {
    const tid = timetableId++;
    timetables.push({
      id: tid,
      class_name: className,
      semester,
      note: null,
      periods: null,
      my_subjects: null,
      created_at: base,
      updated_at: base,
    });
    for (const [day, period, subject, note] of entries) {
      timetableSlots.push({
        id: slotId++,
        timetable_id: tid,
        day_of_week: day,
        period,
        subject,
        note: note ?? null,
        updated_at: base,
      });
    }
  }

  // 演示日程事件：班级事件（type 区分）+ 教师个人事件（class_name 为 null）
  const localDate = (offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const calendarEvents: CalendarEvent[] = [
    { id: 1, class_name: "三年级二班", event_date: localDate(1), type: "todo", period: null, content: "收秋游回执单", title: null, done: 0, created_at: base, updated_at: base },
    { id: 2, class_name: "三年级二班", event_date: localDate(3), type: "memo", period: null, content: "大课间彩排", title: null, done: 0, created_at: base, updated_at: base },
    { id: 3, class_name: "三年级二班", event_date: localDate(-2), type: "memo", period: null, content: "班委开会", title: null, done: 1, created_at: base, updated_at: base },
    { id: 4, class_name: "三年级二班", event_date: localDate(2), type: "exam", period: 6, content: "数学第一单元测验", title: null, done: 0, created_at: base, updated_at: base },
    { id: 5, class_name: null, event_date: localDate(0), type: "homework", period: 4, content: "布置语文第 3 课抄写", title: null, done: 0, created_at: base, updated_at: base },
    { id: 6, class_name: null, event_date: localDate(0), type: "todo", period: null, content: "下午教研组会议", title: null, done: 0, created_at: base, updated_at: base },
  ];

  // 演示调课例外：明天第 6 节停课（彩排）、后天第 7 节加一节语文
  const timetableExceptions: TimetableException[] = [
    {
      id: 1,
      timetable_id: 1,
      exception_date: localDate(1),
      period: 6,
      subject: "",
      note: "大课间彩排",
      created_at: base,
      updated_at: base,
    },
    {
      id: 2,
      timetable_id: 1,
      exception_date: localDate(2),
      period: 7,
      subject: "语文",
      note: "调课补课",
      created_at: base,
      updated_at: base,
    },
  ];

  // 演示成绩：多班级 × 多次考试，覆盖「数字分」与「等级制」两种口径。
  // - 四年级一班：与 docs/examples 成绩单样例同源（10 人 × 5 次考试，含等级制月考），
  //   用于展示多考试趋势、个人单科走势与偏科诊断；
  // - 三年级二班：主演示班（林知远 / 苏晚）3 次考试，展示逐次进步；
  // - 其余班级：按学生/科目确定性生成 3 次考试，保证任意班级打开「考试成绩」都有多考试对比。
  interface DemoExamDef {
    name: string;
    exam_date: string;
    subjects: string[];
    rows: [string, ...(number | string)[]][];
  }

  const explicitScoreSpecs: { class_name: string; exams: DemoExamDef[] }[] = [
    {
      class_name: "四年级一班",
      exams: [
        {
          name: "学情摸底测试",
          exam_date: "2026-09-18",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 88, 91, 85],
            ["周砚", 82, 85, 78],
            ["赵晨曦", 95, 89, 92],
            ["钱雨泽", 76, 81, 73],
            ["孙梦琪", 90, 87, 91],
            ["李承宇", 84, 92, 86],
            ["周思远", 72, 78, 70],
            ["吴佳怡", 87, 84, 88],
            ["郑子轩", 93, 86, 85],
            ["王诗雅", 80, 83, 77],
          ],
        },
        {
          name: "第一单元测验",
          exam_date: "2026-09-25",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 85, 90, 78],
            ["周砚", 79, 83, 72],
            ["赵晨曦", 92, 88, 90],
            ["钱雨泽", 74, 80, 70],
            ["孙梦琪", 88, 85, 89],
            ["李承宇", 80, 89, 82],
            ["周思远", 70, 76, 68],
            ["吴佳怡", 85, 82, 86],
            ["郑子轩", 90, 84, 83],
            ["王诗雅", 78, 81, 75],
          ],
        },
        {
          name: "第一次月考",
          exam_date: "2026-10-09",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["陈嘉树", 92, 93, 84],
            ["周砚", 83, 82, 66],
            ["赵晨曦", 96, 95, 94],
            ["钱雨泽", 65, 81, 64],
            ["孙梦琪", 94, 93, 95],
            ["李承宇", 85, 91, 83],
            ["周思远", 55, 62, 54],
            ["吴佳怡", 91, 82, 92],
            ["郑子轩", 93, 94, 82],
            ["王诗雅", 82, 81, 63],
          ],
        },
        {
          name: "期中考试",
          exam_date: "2026-11-05",
          subjects: ["语文", "数学", "英语", "科学"],
          rows: [
            ["陈嘉树", 92, 95, 88, 90],
            ["周砚", 85, 88, 79, 84],
            ["赵晨曦", 96, 91, 94, 92],
            ["钱雨泽", 78, 83, 81, 86],
            ["孙梦琪", 91, 89, 93, 88],
            ["李承宇", 83, 92, 85, 90],
            ["周思远", 75, 80, 72, 78],
            ["吴佳怡", 89, 86, 90, 84],
            ["郑子轩", 94, 87, 88, 91],
            ["王诗雅", 82, 84, 79, 83],
          ],
        },
        {
          name: "期末考试",
          exam_date: "2027-01-15",
          subjects: ["数学", "语文", "英语", "科学", "道德与法治"],
          rows: [
            ["陈嘉树", 96, 90, 92, 89, 91],
            ["周砚", 89, 86, 84, 88, 85],
            ["赵晨曦", 93, 97, 95, 93, 94],
            ["钱雨泽", 85, 80, 83, 87, 84],
            ["孙梦琪", 92, 93, 94, 90, 92],
            ["李承宇", 94, 85, 88, 91, 89],
            ["周思远", 82, 78, 76, 80, 79],
            ["吴佳怡", 88, 90, 89, 86, 87],
            ["郑子轩", 90, 95, 87, 92, 90],
            ["王诗雅", 86, 84, 82, 85, 83],
          ],
        },
      ],
    },
    {
      class_name: "三年级二班",
      exams: [
        {
          name: "第一次月考",
          exam_date: "2026-09-26",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 88, 92, 85],
            ["苏晚", 90, 86, 91],
          ],
        },
        {
          name: "期中考试",
          exam_date: "2026-11-06",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 91, 95, 88],
            ["苏晚", 93, 89, 94],
          ],
        },
        {
          name: "期末考试",
          exam_date: "2027-01-14",
          subjects: ["语文", "数学", "英语"],
          rows: [
            ["林知远", 94, 97, 90],
            ["苏晚", 95, 92, 96],
          ],
        },
      ],
    },
  ];

  const generatedClasses: { class_name: string; names: string[] }[] = [
    { class_name: "三年级一班", names: ["沈屿", "温故"] },
    { class_name: "五年级二班", names: ["江雪眠", "陆时安"] },
    { class_name: "二年级三班", names: ["何听雨", "顾星野"] },
  ];
  const generatedExams = [
    { name: "第一次月考", exam_date: "2026-09-24" },
    { name: "期中考试", exam_date: "2026-11-07" },
    { name: "期末考试", exam_date: "2027-01-13" },
  ];
  const generatedSubjects = ["语文", "数学", "英语"];
  /** 确定性伪随机成绩（72~91 起，逐次略升），仅用于演示数据，保证每次启动一致 */
  const demoScoreOf = (studentId: number, subjectIndex: number, examIndex: number): number => {
    const baseScore = 72 + ((studentId * 7 + subjectIndex * 11) % 20);
    const drift = examIndex * 2;
    const jitter = ((studentId + subjectIndex * 3 + examIndex * 5) % 5) - 2;
    return Math.max(55, Math.min(100, baseScore + drift + jitter));
  };

  const exams: Exam[] = [];
  const examScores: ExamScore[] = [];
  let examId = 1;
  let examScoreId = 1;
  const pushExam = (className: string, def: DemoExamDef) => {
    exams.push({
      id: examId,
      class_name: className,
      name: def.name,
      exam_date: def.exam_date,
      exam_type: inferExamType(def.name),
      note: null,
      created_at: base,
      updated_at: base,
    });
    for (const [studentName, ...cells] of def.rows) {
      const student = students.find((s) => s.name === studentName);
      if (!student) continue;
      def.subjects.forEach((subject, i) => {
        const value = cells[i];
        const isNumeric = typeof value === "number";
        examScores.push({
          id: examScoreId++,
          exam_id: examId,
          student_id: student.id,
          subject,
          score: isNumeric ? value : null,
          grade: isNumeric ? null : String(value),
          created_at: base,
          updated_at: base,
        });
      });
    }
    examId++;
  };

  for (const spec of explicitScoreSpecs) {
    for (const def of spec.exams) pushExam(spec.class_name, def);
  }

  for (const { class_name, names: classNames } of generatedClasses) {
    generatedExams.forEach((exam, examIndex) => {
      const rows: [string, ...(number | string)[]][] = classNames.map((name) => {
        const student = students.find((s) => s.name === name);
        const cells = generatedSubjects.map((_, subjectIndex) =>
          student ? demoScoreOf(student.id, subjectIndex, examIndex) : 80
        );
        return [name, ...cells];
      });
      pushExam(class_name, { ...exam, subjects: generatedSubjects, rows });
    });
  }

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
    recycleBin: [],
    exams,
    examScores,
    timetables,
    timetableSlots,
    timetableExceptions,
    calendarEvents,
    nextStudentId: 19,
    nextPhotoId: pid,
    nextGuardianId: gid,
    nextDimensionId: BEHAVIOR_DIMENSIONS.length + 1,
    nextBehaviorRecordId: 1,
    nextCommentPresetId: BEHAVIOR_PRESET_SEED.length + 1,
    nextRecycleId: 1,
    nextExamId: examId,
    nextExamScoreId: examScoreId,
    nextTimetableId: timetableId,
    nextTimetableSlotId: slotId,
    nextTimetableExceptionId: timetableExceptions.length + 1,
    nextCalendarEventId: calendarEvents.length + 1,
  };
}

let memory: MemoryStore | null = null;
function mem(): MemoryStore {
  if (!memory) memory = seedStore();
  return memory;
}

/* ------------------------------------------------------------------ */
/* 回收站：快照存取辅助                                                  */
/* ------------------------------------------------------------------ */

const RETENTION_MS = RECYCLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** "2026-09-06 10:00:00" 格式化 */
function fmtLocalTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** deleted_at + 保留天数 → 过期时间戳 */
function expireAtOf(deletedAt: string): string {
  const t = new Date(deletedAt.replace(" ", "T")).getTime();
  if (Number.isNaN(t)) return deletedAt;
  return fmtLocalTs(new Date(t + RETENTION_MS));
}

/** 距彻底删除还剩几天（向上取整，最小 0） */
export function recycleRemainingDays(item: Pick<RecycleItem, "expire_at">, now = new Date()): number {
  const expire = new Date(item.expire_at.replace(" ", "T")).getTime();
  if (Number.isNaN(expire)) return 0;
  return Math.max(0, Math.ceil((expire - now.getTime()) / (24 * 60 * 60 * 1000)));
}

/** 监护人标签解析：JSON 数组字符串 / 已是数组 / 脏数据 → string[] */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/** 快照里抽出的照片元数据 */
interface PhotoSnapshot {
  grade_class?: string | null;
  file_name: string;
  caption: string | null;
  taken_at: string | null;
}

function photoSnap(p: Pick<Photo, "grade_class" | "file_name" | "caption" | "taken_at">): PhotoSnapshot {
  return {
    grade_class: p.grade_class ?? null,
    file_name: p.file_name,
    caption: p.caption ?? null,
    taken_at: p.taken_at ?? null,
  };
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
            id_card = ?, address = ?, status = ?, note = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
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
      id,
    ]
  );
  await db.execute("DELETE FROM guardians WHERE student_id = ?", [id]);
  if (input.guardians?.length) {
    for (const g of input.guardians) {
      await db.execute(
        "INSERT INTO guardians (student_id, name, phone, relation, is_primary, occupation, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          id,
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
}

/** 学生完整快照（供回收站与恢复使用，浏览器/SQLite 双通道共用） */
function buildStudentSnapshot(
  student: Student,
  guardians: Guardian[],
  photos: Photo[],
  behaviors: StudentBehaviorRecord[]
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

    const snap = buildStudentSnapshot(student, guardians, photos, behaviors);
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

  const snap = buildStudentSnapshot(student, guardians, photos, behaviors);
  await db.execute(
    "INSERT INTO recycle_bin (entity_type, label, summary, payload) VALUES ('student', ?, ?, ?)",
    [student.name, studentSummary(snap), JSON.stringify(snap)]
  );
  await db.execute("DELETE FROM guardians WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM photos WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM student_behavior_records WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM exam_scores WHERE student_id = ?", [id]);
  await db.execute("DELETE FROM students WHERE id = ?", [id]);
}

/* ------------------------------------------------------------------ */
/* 回收站：列表 / 恢复 / 彻底删除 / 过期清理                              */
/* ------------------------------------------------------------------ */

/** SQLite 回收站行（payload 为 JSON 字符串） */
interface RecycleBinRow {
  id: number;
  entity_type: string;
  label: string;
  summary: string;
  payload: string | ClassSnapshot | StudentSnapshot;
  deleted_at: string;
}

/** 行 → 回收站条目：补 expire_at，payload 按需 JSON 反序列化 */
function toRecycleItem(row: RecycleBinRow): RecycleItem {
  let payload: ClassSnapshot | StudentSnapshot;
  if (typeof row.payload === "string") {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = { name: row.label, students: [], classPhotos: [] };
    }
  } else {
    payload = row.payload;
  }
  return {
    id: Number(row.id),
    entity_type: row.entity_type as RecycleEntityType,
    label: row.label,
    summary: row.summary ?? "",
    payload,
    deleted_at: row.deleted_at,
    expire_at: expireAtOf(row.deleted_at),
  };
}

/** 快照里所有照片文件名（彻底删除时同步清落盘文件） */
function snapshotFileNames(payload: ClassSnapshot | StudentSnapshot): string[] {
  if ("classPhotos" in payload) {
    return [
      ...payload.classPhotos.map((p) => p.file_name),
      ...payload.students.flatMap((s) => s.photos.map((p) => p.file_name)),
    ];
  }
  return payload.photos.map((p) => p.file_name);
}

/** 恢复一条学生快照（重新分配 ID，照片/监护人/表现流水重新挂接） */
async function insertStudentSnapshot(db: Database, snap: StudentSnapshot): Promise<number> {
  const result = await db.execute(
    `INSERT INTO students
       (name, gender, birth_date, student_no, grade_class, id_card,
        address, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
    [
      snap.student.name,
      snap.student.gender,
      snap.student.birth_date,
      snap.student.student_no,
      snap.student.grade_class,
      snap.student.id_card,
      snap.student.address,
      snap.student.status,
      snap.student.note,
    ]
  );
  const studentId = Number(result.lastInsertId ?? 0);

  for (const g of snap.guardians) {
    await db.execute(
      "INSERT INTO guardians (student_id, name, phone, relation, is_primary, occupation, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [studentId, g.name, g.phone, g.relation, g.is_primary ? 1 : 0, g.occupation ?? "", JSON.stringify(g.tags ?? [])]
    );
  }
  for (const p of snap.photos) {
    await db.execute(
      "INSERT INTO photos (student_id, grade_class, file_name, caption, taken_at) VALUES (?, ?, ?, ?, ?)",
      [studentId, p.grade_class ?? null, p.file_name, p.caption, p.taken_at]
    );
  }
  for (const b of snap.behaviors) {
    await db.execute(
      `INSERT INTO student_behavior_records
         (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        studentId,
        b.dimension_id,
        b.dimension_name_snap,
        b.category_snap,
        b.type,
        b.comment,
        b.recorded_date,
        b.created_at,
      ]
    );
  }
  return studentId;
}

/** 内存态恢复学生快照（返回新学生 ID） */
function insertStudentSnapshotMemory(store: MemoryStore, snap: StudentSnapshot): number {
  const id = store.nextStudentId++;
  const ts = now();
  const guardians: Guardian[] = snap.guardians.map((g) => ({
    ...g,
    id: store.nextGuardianId++,
    student_id: id,
  }));
  store.guardians.push(...guardians);
  const photos: Photo[] = snap.photos.map((p) => ({
    id: store.nextPhotoId++,
    student_id: id,
    grade_class: p.grade_class ?? null,
    file_name: p.file_name,
    caption: p.caption,
    taken_at: p.taken_at,
    created_at: ts,
  }));
  store.photos.push(...photos);
  const behaviors: StudentBehaviorRecord[] = snap.behaviors.map((b) => ({
    ...b,
    id: store.nextBehaviorRecordId++,
    student_id: id,
  }));
  store.behaviorRecords.push(...behaviors);
  store.students.push({
    ...snap.student,
    id,
    guardians,
    created_at: ts,
    updated_at: ts,
  });
  return id;
}

/** 回收站条目列表（打开即先清理过期项） */
export async function listRecycleItems(): Promise<RecycleItem[]> {
  await purgeExpiredRecycleItems();
  if (!isTauri()) {
    return [...mem().recycleBin].sort(
      (a, b) => (a.deleted_at < b.deleted_at ? 1 : -1) || b.id - a.id
    );
  }
  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>(
    "SELECT * FROM recycle_bin ORDER BY deleted_at DESC, id DESC"
  );
  return rows.map(toRecycleItem);
}

/** 恢复回收站条目：班级整体重建（含学生/照片/表现流水），学生档案重新入库 */
export async function restoreRecycleItem(itemId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.recycleBin.findIndex((r) => r.id === itemId);
    if (idx === -1) return;
    const [item] = store.recycleBin.splice(idx, 1);
    if (item.entity_type === "class") {
      const snap = item.payload as ClassSnapshot;
      if (!store.classes.includes(snap.name)) store.classes.push(snap.name);
      for (const s of snap.students) insertStudentSnapshotMemory(store, s);
      const ts = now();
      for (const p of snap.classPhotos) {
        store.photos.push({
          id: store.nextPhotoId++,
          student_id: null,
          grade_class: snap.name,
          file_name: p.file_name,
          caption: p.caption,
          taken_at: p.taken_at,
          created_at: ts,
        });
      }
    } else {
      insertStudentSnapshotMemory(store, item.payload as StudentSnapshot);
    }
    return;
  }

  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>("SELECT * FROM recycle_bin WHERE id = ?", [itemId]);
  if (!rows.length) return;
  const item = toRecycleItem(rows[0]);

  if (item.entity_type === "class") {
    const snap = item.payload as ClassSnapshot;
    await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [snap.name]);
    for (const s of snap.students) await insertStudentSnapshot(db, s);
    for (const p of snap.classPhotos) {
      await db.execute(
        "INSERT INTO photos (student_id, grade_class, file_name, caption, taken_at) VALUES (NULL, ?, ?, ?, ?)",
        [snap.name, p.file_name, p.caption, p.taken_at]
      );
    }
  } else {
    await insertStudentSnapshot(db, item.payload as StudentSnapshot);
  }
  await db.execute("DELETE FROM recycle_bin WHERE id = ?", [itemId]);
}

/** 彻底删除单条回收站条目（连带清落盘图片文件，尽力而为） */
export async function purgeRecycleItem(itemId: number): Promise<void> {
  const items = await listRecycleBinForPurge(itemId);
  await removeRecycleRows([itemId]);
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length && isTauri()) {
    const { deletePhotoFile } = await import("./photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {
        // 文件可能已不存在，忽略单张失败
      }
    }
  }
}

/** 清空回收站并连带清理落盘图片 */
export async function clearRecycleBin(): Promise<void> {
  const items = await listRecycleItems();
  await removeRecycleRows(items.map((i) => i.id));
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length && isTauri()) {
    const { deletePhotoFile } = await import("./photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {}
    }
  }
}

/** 读取待清理条目（SQLite 通道；内存通道返回空数组，内存态直接过滤） */
async function listRecycleBinForPurge(itemId: number): Promise<RecycleItem[]> {
  if (!isTauri()) {
    return mem().recycleBin.filter((r) => r.id === itemId);
  }
  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>("SELECT * FROM recycle_bin WHERE id = ?", [itemId]);
  return rows.map(toRecycleItem);
}

async function removeRecycleRows(ids: number[]): Promise<void> {
  if (!ids.length) return;
  if (!isTauri()) {
    const store = mem();
    const idSet = new Set(ids);
    store.recycleBin = store.recycleBin.filter((r) => !idSet.has(r.id));
    return;
  }
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.execute(`DELETE FROM recycle_bin WHERE id IN (${placeholders})`, ids);
}

/** 清理超过保留期（默认 7 天）的回收站条目，连带清落盘图片 */
export async function purgeExpiredRecycleItems(): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const cutoff = Date.now() - RETENTION_MS;
    const expired = store.recycleBin.filter((r) => {
      const t = new Date(r.deleted_at.replace(" ", "T")).getTime();
      return !Number.isNaN(t) && t <= cutoff;
    });
    if (!expired.length) return;
    const expiredIds = new Set(expired.map((r) => r.id));
    store.recycleBin = store.recycleBin.filter((r) => !expiredIds.has(r.id));
    return;
  }

  const db = await getDb();
  const rows = await db.select<RecycleBinRow[]>(
    "SELECT * FROM recycle_bin WHERE deleted_at <= datetime('now','localtime','-7 day')"
  );
  if (!rows.length) return;
  const items = rows.map(toRecycleItem);
  await removeRecycleRows(items.map((i) => i.id));
  const fileNames = items.flatMap((i) => snapshotFileNames(i.payload));
  if (fileNames.length) {
    const { deletePhotoFile } = await import("./photos");
    for (const f of fileNames) {
      try {
        await deletePhotoFile(f);
      } catch {}
    }
  }
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
    const explicitClasses = await db.select<{ name: string }[]>("SELECT name FROM classes");
    for (const row of explicitClasses) {
      if (row.name && row.name !== "未分班") classNames.add(row.name);
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
      return buildStudentSnapshot(s, guardians, photos, behaviors);
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
    studentSnaps.push(buildStudentSnapshot(s, guardians, photos, behaviors));
  }

  const photoTotal = classPhotos.length + studentSnaps.reduce((n, s) => n + s.photos.length, 0);
  const behaviorTotal = studentSnaps.reduce((n, s) => n + s.behaviors.length, 0);
  await db.execute(
    "INSERT INTO recycle_bin (entity_type, label, summary, payload) VALUES ('class', ?, ?, ?)",
    [
      trimmed,
      `${members.length} 名学生 · 照片 ${photoTotal} 张 · 表现 ${behaviorTotal} 条`,
      JSON.stringify({
        name: trimmed,
        students: studentSnaps,
        classPhotos: classPhotos.map(photoSnap),
      } satisfies ClassSnapshot),
    ]
  );

  // 学生已整体进回收站，这里按班级把主表数据清掉（顺序：成绩 → 流水 → 照片 → 监护人 → 学生）
  await db.execute(
    `DELETE FROM exam_scores WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
    memberParams
  );
  await db.execute(
    "DELETE FROM exam_scores WHERE exam_id IN (SELECT id FROM exams WHERE class_name = ?)",
    [trimmed]
  );
  await db.execute("DELETE FROM exams WHERE class_name = ?", [trimmed]);
  // 课表随班级删除（不进回收站快照，与成绩同口径）
  await db.execute("DELETE FROM timetable_slots WHERE timetable_id IN (SELECT id FROM timetables WHERE class_name = ?)", [trimmed]);
  await db.execute("DELETE FROM timetable_exceptions WHERE timetable_id IN (SELECT id FROM timetables WHERE class_name = ?)", [trimmed]);
  await db.execute("DELETE FROM timetables WHERE class_name = ?", [trimmed]);
  await db.execute("DELETE FROM calendar_events WHERE class_name = ?", [trimmed]);
  await db.execute(
    `DELETE FROM student_behavior_records WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
    memberParams
  );
  await db.execute(
    `DELETE FROM photos WHERE (grade_class = ? AND student_id IS NULL) OR student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
    [trimmed, ...memberParams]
  );
  await db.execute(
    `DELETE FROM guardians WHERE student_id IN (SELECT id FROM students WHERE ${memberWhere})`,
    memberParams
  );
  await db.execute(`DELETE FROM students WHERE ${memberWhere}`, memberParams);
  await db.execute("DELETE FROM classes WHERE name = ?", [trimmed]);
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
    await db.execute("INSERT OR IGNORE INTO classes (name) VALUES (?)", [targetClass]);
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
  const rows = await db.select<(Profile & { my_subjects: unknown })[]>(
    "SELECT name, title, motto, avatar, hero, my_subjects, timetable_bg FROM profile WHERE id = 1"
  );
  return {
    ...DEFAULT_PROFILE,
    ...(rows[0] ?? {}),
    my_subjects: parseTags(rows[0]?.my_subjects),
    timetable_bg: rows[0]?.timetable_bg ?? "",
  };
}

export async function saveProfile(p: Profile): Promise<void> {
  if (!isTauri()) {
    memProfile = { ...p };
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO profile (id, name, title, motto, avatar, hero, my_subjects, timetable_bg, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET
          name          = excluded.name,
          title         = excluded.title,
          motto         = excluded.motto,
          avatar        = excluded.avatar,
          hero          = excluded.hero,
          my_subjects   = excluded.my_subjects,
          timetable_bg  = excluded.timetable_bg,
          updated_at    = excluded.updated_at`,
    [p.name, p.title, p.motto, p.avatar, p.hero, JSON.stringify(p.my_subjects ?? []), p.timetable_bg]
  );
}

/** 清空所有数据（设置页用，回收站一并清空） */
export async function clearAll(): Promise<void> {
  if (!isTauri()) {
    memory = seedStore();
    memory.students = [];
    memory.photos = [];
    memory.classes = [];
    memory.guardians = [];
    memory.behaviorRecords = [];
    memory.exams = [];
    memory.examScores = [];
    memory.timetables = [];
    memory.timetableSlots = [];
    memory.timetableExceptions = [];
    memory.calendarEvents = [];
    memory.recycleBin = [];
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM guardians");
  await db.execute("DELETE FROM photos");
  await db.execute("DELETE FROM students");
  await db.execute("DELETE FROM student_behavior_records");
  await db.execute("DELETE FROM exam_scores");
  await db.execute("DELETE FROM exams");
  await db.execute("DELETE FROM timetable_slots");
  await db.execute("DELETE FROM timetable_exceptions");
  await db.execute("DELETE FROM timetables");
  await db.execute("DELETE FROM calendar_events");
  await db.execute("DELETE FROM classes");
  await db.execute("DELETE FROM recycle_bin");
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

/**
 * 删除一条表现流水，并对称回退评语沉淀：
 * 同 (维度, 倾向, 内容) 词条 use_count-1；history 来源的词条计数归零后随之移除。
 */
export async function deleteBehaviorRecord(recordId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const idx = store.behaviorRecords.findIndex((r) => r.id === recordId);
    if (idx === -1) return;
    const [rec] = store.behaviorRecords.splice(idx, 1);
    const preset = store.commentPresets.find(
      (p) => p.dimension_id === rec.dimension_id && p.type === rec.type && p.content === rec.comment
    );
    if (preset && preset.use_count > 0) {
      preset.use_count -= 1;
      if (preset.source === "history" && preset.use_count <= 0) {
        store.commentPresets = store.commentPresets.filter((p) => p.id !== preset.id);
      }
    }
    return;
  }

  const db = await getDb();
  const rows = await db.select<
    { dimension_id: number; type: string; comment: string }[]
  >(
    `SELECT dimension_id, type, comment FROM student_behavior_records WHERE id = ?`,
    [recordId]
  );
  if (!rows.length) return;
  const rec = rows[0];
  await db.execute(`DELETE FROM student_behavior_records WHERE id = ?`, [recordId]);
  await db.execute(
    `UPDATE behavior_comment_presets SET use_count = use_count - 1
      WHERE dimension_id = ? AND type = ? AND content = ? AND use_count > 0`,
    [rec.dimension_id, rec.type, rec.comment]
  );
  await db.execute(
    `DELETE FROM behavior_comment_presets WHERE source = 'history' AND use_count <= 0`
  );
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

/* ------------------------------------------------------------------ */
/* 考试与成绩：批次（考试名 + 考试时间）→ 学生 × 科目成绩                  */
/* ------------------------------------------------------------------ */

/** 考试时间校验：YYYY-MM-DD（导入管道已归一化，这里兜底防脏数据入库） */
function assertExamDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("考试时间格式应为 YYYY-MM-DD");
}

/** 新建考试批次。返回新考试 id。 */
export async function createExam(input: ExamInput): Promise<number> {
  const name = input.name.trim();
  if (!name) throw new Error("考试名称不能为空");
  assertExamDate(input.exam_date);
  const examType = input.exam_type ?? inferExamType(name);

  if (!isTauri()) {
    const store = mem();
    const id = store.nextExamId++;
    const ts = now();
    store.exams.push({
      id,
      class_name: input.class_name,
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
    [input.class_name, name, input.exam_date, examType, input.note ?? null]
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
  assertExamDate(input.exam_date);

  const existing = await findExam(input.class_name, name, input.exam_date);
  if (existing) return { exam: existing, created: false };
  const id = await createExam(input);
  return {
    exam: {
      id,
      class_name: input.class_name,
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

/* ------------------------------------------------------------------ */
/* 课程表：一班一学期一张，格子（天 × 节）幂等 upsert                      */
/* ------------------------------------------------------------------ */

/** SQLite 行：periods / my_subjects 以 JSON 字符串落库，取出时解析 */
type TimetableRaw = Omit<Timetable, "periods" | "my_subjects"> & {
  periods_json: string | null;
  my_subjects: string | null;
};

function toTimetable(raw: TimetableRaw): Timetable {
  const { periods_json, my_subjects, ...rest } = raw;
  return {
    ...rest,
    periods: parsePeriodsJson(periods_json),
    my_subjects: parseMySubjectsJson(my_subjects),
  };
}

function assertSlotPosition(dayOfWeek: number, period: number): void {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 5) {
    throw new Error("课表只支持周一到周五（1~5）");
  }
  if (!Number.isInteger(period) || period < 1 || period > 12) {
    throw new Error("节次应为 1~12 的整数");
  }
}

function sortSlots<T extends Pick<TimetableSlot, "day_of_week" | "period">>(slots: T[]): T[] {
  return slots.sort((a, b) => a.day_of_week - b.day_of_week || a.period - b.period);
}

/** 班级某学期的课表（含全部格子）；没有课表返回 null */
export async function getTimetableWithSlots(
  className: string,
  semester: string
): Promise<(Timetable & { slots: TimetableSlot[] }) | null> {
  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.class_name === className && x.semester === semester);
    if (!t) return null;
    return {
      ...t,
      periods: t.periods ? t.periods.map((p) => ({ ...p })) : null,
      slots: sortSlots(store.timetableSlots.filter((s) => s.timetable_id === t.id).map((s) => ({ ...s }))),
    };
  }
  const db = await getDb();
  const heads = await db.select<TimetableRaw[]>(
    "SELECT * FROM timetables WHERE class_name = ? AND semester = ? LIMIT 1",
    [className, semester]
  );
  if (!heads[0]) return null;
  const slots = await db.select<TimetableSlot[]>(
    "SELECT * FROM timetable_slots WHERE timetable_id = ?",
    [heads[0].id]
  );
  return { ...toTimetable(heads[0]), slots: sortSlots(slots) };
}

/** 查或建班级某学期的课表（幂等）：重复导入/重复打开复用同一张 */
export async function findOrCreateTimetable(
  className: string,
  semester: string
): Promise<{ timetable: Timetable; created: boolean }> {
  const name = className.trim();
  if (!name) throw new Error("班级名不能为空");
  if (!/^\d{4}-\d{4}-[12]$/.test(semester)) throw new Error("学期号格式应为 YYYY-YYYY-1/2");

  const existing = await getTimetableWithSlots(name, semester);
  if (existing) {
    const { slots: _slots, ...timetable } = existing;
    return { timetable, created: false };
  }

  if (!isTauri()) {
    const store = mem();
    const timetable: Timetable = {
      id: store.nextTimetableId++,
      class_name: name,
      semester,
      note: null,
      periods: null,
      my_subjects: null,
      created_at: now(),
      updated_at: now(),
    };
    store.timetables.push(timetable);
    return { timetable: { ...timetable }, created: true };
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO timetables (class_name, semester) VALUES (?, ?)",
    [name, semester]
  );
  const rows = await db.select<TimetableRaw[]>("SELECT * FROM timetables WHERE id = ?", [
    Number(result.lastInsertId ?? 0),
  ]);
  return { timetable: toTimetable(rows[0]), created: true };
}

/**
 * 写一格课：subject 传空串 = 清空该格（删行）。
 * (timetable_id, day_of_week, period) 唯一，编辑天然幂等。
 */
export async function saveTimetableSlot(
  timetableId: number,
  dayOfWeek: number,
  period: number,
  subject: string,
  note: string | null = null
): Promise<void> {
  assertSlotPosition(dayOfWeek, period);
  const subj = subject.trim();
  const trimmedNote = note?.trim() ? note.trim() : null;

  if (!isTauri()) {
    const store = mem();
    const existing = store.timetableSlots.find(
      (s) => s.timetable_id === timetableId && s.day_of_week === dayOfWeek && s.period === period
    );
    if (!subj) {
      if (existing) {
        store.timetableSlots = store.timetableSlots.filter((s) => s !== existing);
      }
      return;
    }
    if (existing) {
      existing.subject = subj;
      existing.note = trimmedNote;
      existing.updated_at = now();
      return;
    }
    store.timetableSlots.push({
      id: store.nextTimetableSlotId++,
      timetable_id: timetableId,
      day_of_week: dayOfWeek,
      period,
      subject: subj,
      note: trimmedNote,
      updated_at: now(),
    });
    return;
  }

  const db = await getDb();
  if (!subj) {
    await db.execute(
      "DELETE FROM timetable_slots WHERE timetable_id = ? AND day_of_week = ? AND period = ?",
      [timetableId, dayOfWeek, period]
    );
    return;
  }
  await db.execute(
    `INSERT INTO timetable_slots (timetable_id, day_of_week, period, subject, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(timetable_id, day_of_week, period) DO UPDATE SET
       subject    = excluded.subject,
       note       = excluded.note,
       updated_at = datetime('now','localtime')`,
    [timetableId, dayOfWeek, period, subj, trimmedNote]
  );
}

/** 更新课表节次配置（节数 / 上下午 / 上下课时间），空数组视为恢复默认 */
export async function saveTimetablePeriods(
  timetableId: number,
  periods: TimetablePeriod[]
): Promise<void> {
  if (!Array.isArray(periods)) throw new Error("节次配置应为数组");
  const seen = new Set<number>();
  for (const p of periods) {
    if (!Number.isInteger(p.period) || p.period < 1 || p.period > 12) {
      throw new Error("节次应为 1~12 的整数");
    }
    if (seen.has(p.period)) throw new Error("节次序号不能重复");
    seen.add(p.period);
  }
  const json = periods.length ? JSON.stringify(periods) : null;

  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.id === timetableId);
    if (!t) throw new Error("课表不存在");
    t.periods = json ? (JSON.parse(json) as TimetablePeriod[]) : null;
    t.updated_at = now();
    return;
  }

  const db = await getDb();
  await db.execute(
    "UPDATE timetables SET periods_json = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [json, timetableId]
  );
}

/**
 * 写班级「我的科目」标记：subjects 传 null = 清除标记（该班回退按全局任教学科匹配）；
 * 传数组（含空数组）= 明确标记，空数组即「本班没有我的课」。trim / 去空 / 去重后落库。
 */
export async function saveTimetableMySubjects(
  timetableId: number,
  subjects: string[] | null
): Promise<void> {
  const normalized = subjects === null ? null : normalizeMySubjects(subjects);
  const json = normalized === null ? null : JSON.stringify(normalized);

  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.id === timetableId);
    if (!t) throw new Error("课表不存在");
    t.my_subjects = normalized;
    t.updated_at = now();
    return;
  }

  const db = await getDb();
  await db.execute(
    "UPDATE timetables SET my_subjects = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [json, timetableId]
  );
}

/** 我的课表素材：某学期全部班级的课表格子（联班级名、节次配置与我的科目标记） */
export async function listTimetableSlotsWithClass(semester: string): Promise<TimetableSlotWithClass[]> {
  if (!isTauri()) {
    const store = mem();
    const byId = new Map(store.timetables.map((t) => [t.id, t]));
    return sortSlots(
      store.timetableSlots
        .flatMap((s) => {
          const t = byId.get(s.timetable_id);
          if (!t || t.semester !== semester) return [];
          return [
            {
              ...s,
              class_name: t.class_name,
              periods: t.periods,
              my_subjects: t.my_subjects,
            },
          ];
        })
    );
  }
  const db = await getDb();
  const rows = await db.select<
    (TimetableSlot & { class_name: string; periods_json: string | null; my_subjects: string | null })[]
  >(
    `SELECT s.*, t.class_name, t.periods_json, t.my_subjects
       FROM timetable_slots s
       INNER JOIN timetables t ON s.timetable_id = t.id
      WHERE t.semester = ?`,
    [semester]
  );
  return sortSlots(
    rows.map(({ periods_json, my_subjects, ...s }) => ({
      ...s,
      periods: parsePeriodsJson(periods_json),
      my_subjects: parseMySubjectsJson(my_subjects),
    }))
  );
}

/** 学期内各班节次配置与「我的科目」标记（含没排过课的班）；「我的课表」行数与导入撞课预览的数据来源 */
export async function listTimetablePeriodsByClass(
  semester: string
): Promise<{ class_name: string; periods: TimetablePeriod[] | null; my_subjects: string[] | null }[]> {
  if (!isTauri()) {
    return mem()
      .timetables.filter((t) => t.semester === semester)
      .map((t) => ({ class_name: t.class_name, periods: t.periods, my_subjects: t.my_subjects }))
      .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
  }
  const db = await getDb();
  const rows = await db.select<{
    class_name: string;
    periods_json: string | null;
    my_subjects: string | null;
  }[]>("SELECT class_name, periods_json, my_subjects FROM timetables WHERE semester = ?", [
    semester,
  ]);
  return rows
    .map(({ class_name, periods_json, my_subjects }) => ({
      class_name,
      periods: parsePeriodsJson(periods_json),
      my_subjects: parseMySubjectsJson(my_subjects),
    }))
    .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
}

/** 清空某张课表的全部格子（导入「清空后导入」选项用）；返回删除格数 */
export async function clearTimetableSlots(timetableId: number): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const before = store.timetableSlots.length;
    store.timetableSlots = store.timetableSlots.filter((s) => s.timetable_id !== timetableId);
    return before - store.timetableSlots.length;
  }
  const db = await getDb();
  const result = await db.execute("DELETE FROM timetable_slots WHERE timetable_id = ?", [
    timetableId,
  ]);
  return result.rowsAffected;
}

/** 库内出现过的全部科目（去重），「任教学科」候选与导入识别共用 */
export async function listTimetableSubjects(): Promise<string[]> {
  if (!isTauri()) {
    const seen: string[] = [];
    for (const s of mem().timetableSlots) {
      const subj = s.subject.trim();
      if (subj && !seen.includes(subj)) seen.push(subj);
    }
    return seen.sort((a, b) => a.localeCompare(b, "zh"));
  }
  const db = await getDb();
  const rows = await db.select<{ subject: string }[]>(
    "SELECT DISTINCT subject FROM timetable_slots WHERE TRIM(subject) != ''"
  );
  return rows.map((r) => r.subject.trim()).sort((a, b) => a.localeCompare(b, "zh"));
}

/* ------------------------------------------------------------------ */
/* 调课例外：某班「某天某节」覆盖周课表（换课 / 停课 / 加课）                */
/* ------------------------------------------------------------------ */

function assertCalendarDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式应为 YYYY-MM-DD");
}

/** 保存一条调课例外：subject 传空串 = 停课；(timetable_id, date, period) 唯一，编辑天然幂等 */
export async function saveTimetableException(
  timetableId: number,
  exceptionDate: string,
  period: number,
  subject: string,
  note: string | null = null
): Promise<void> {
  assertCalendarDate(exceptionDate);
  if (!Number.isInteger(period) || period < 1 || period > 12) {
    throw new Error("节次应为 1~12 的整数");
  }
  const subj = subject.trim();
  const trimmedNote = note?.trim() ? note.trim() : null;

  if (!isTauri()) {
    const store = mem();
    const existing = store.timetableExceptions.find(
      (e) =>
        e.timetable_id === timetableId &&
        e.exception_date === exceptionDate &&
        e.period === period
    );
    if (existing) {
      existing.subject = subj;
      existing.note = trimmedNote;
      existing.updated_at = now();
      return;
    }
    store.timetableExceptions.push({
      id: store.nextTimetableExceptionId++,
      timetable_id: timetableId,
      exception_date: exceptionDate,
      period,
      subject: subj,
      note: trimmedNote,
      created_at: now(),
      updated_at: now(),
    });
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO timetable_exceptions (timetable_id, exception_date, period, subject, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(timetable_id, exception_date, period) DO UPDATE SET
       subject    = excluded.subject,
       note       = excluded.note,
       updated_at = datetime('now','localtime')`,
    [timetableId, exceptionDate, period, subj, trimmedNote]
  );
}

/** 删除一条调课例外 = 该天该节恢复周课表默认 */
export async function clearTimetableException(
  timetableId: number,
  exceptionDate: string,
  period: number
): Promise<void> {
  assertCalendarDate(exceptionDate);
  if (!isTauri()) {
    const store = mem();
    store.timetableExceptions = store.timetableExceptions.filter(
      (e) =>
        !(
          e.timetable_id === timetableId &&
          e.exception_date === exceptionDate &&
          e.period === period
        )
    );
    return;
  }
  const db = await getDb();
  await db.execute(
    "DELETE FROM timetable_exceptions WHERE timetable_id = ? AND exception_date = ? AND period = ?",
    [timetableId, exceptionDate, period]
  );
}

/** 某班课表在 [startDate, endDate] 内的调课例外（班级万年历按月查询用） */
export async function listTimetableExceptionsInRange(
  timetableId: number,
  startDate: string,
  endDate: string
): Promise<TimetableException[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .timetableExceptions.filter(
        (e) =>
          e.timetable_id === timetableId &&
          e.exception_date >= startDate &&
          e.exception_date <= endDate
      )
      .sort((a, b) => a.exception_date.localeCompare(b.exception_date) || a.period - b.period)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<TimetableException[]>(
    `SELECT * FROM timetable_exceptions
      WHERE timetable_id = ? AND exception_date >= ? AND exception_date <= ?
      ORDER BY exception_date ASC, period ASC`,
    [timetableId, startDate, endDate]
  );
}

/** 某学期全部班级在日期区间内的调课例外（联班级名，我的课表 / 首页 / Agent 用） */
export async function listTimetableExceptionsWithClass(
  semester: string,
  startDate: string,
  endDate: string
): Promise<TimetableExceptionWithClass[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    const store = mem();
    const byId = new Map(store.timetables.map((t) => [t.id, t]));
    return store.timetableExceptions
      .flatMap((e) => {
        const t = byId.get(e.timetable_id);
        if (!t || t.semester !== semester) return [];
        return [{ ...e, class_name: t.class_name }];
      })
      .filter((e) => e.exception_date >= startDate && e.exception_date <= endDate)
      .sort((a, b) => a.exception_date.localeCompare(b.exception_date) || a.period - b.period);
  }
  const db = await getDb();
  return db.select<TimetableExceptionWithClass[]>(
    `SELECT e.*, t.class_name
       FROM timetable_exceptions e
       INNER JOIN timetables t ON e.timetable_id = t.id
      WHERE t.semester = ? AND e.exception_date >= ? AND e.exception_date <= ?
      ORDER BY e.exception_date ASC, e.period ASC`,
    [semester, startDate, endDate]
  );
}

/* ------------------------------------------------------------------ */
/* 统一日程事件：备忘 / 待办 / 考试 / 作业；班级可空 = 教师个人事件          */
/* ------------------------------------------------------------------ */

const EVENT_TYPES: CalendarEventType[] = ["memo", "todo", "exam", "homework"];

/** 新增日程事件：className 传 null = 教师个人事件（只在教师维度展示）；period 传节次 = 落在课表具体格子，返回 id */
export async function addCalendarEvent(
  className: string | null,
  eventDate: string,
  content: string,
  type: CalendarEventType = "memo",
  period: number | null = null
): Promise<number> {
  const cls = className?.trim() || null;
  assertCalendarDate(eventDate);
  const text = content.trim();
  if (!text) throw new Error("日程内容不能为空");
  if (text.length > 200) throw new Error("日程内容请控制在 200 字以内");
  if (!EVENT_TYPES.includes(type)) throw new Error("日程类型不合法");
  if (period !== null && (!Number.isInteger(period) || period < 1 || period > 30)) {
    throw new Error("节次不合法");
  }

  if (!isTauri()) {
    const store = mem();
    const id = store.nextCalendarEventId++;
    store.calendarEvents.push({
      id,
      class_name: cls,
      event_date: eventDate,
      type,
      period,
      content: text,
      title: null,
      done: 0,
      created_at: now(),
      updated_at: now(),
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO calendar_events (class_name, event_date, type, period, content) VALUES (?, ?, ?, ?, ?)",
    [cls, eventDate, type, period, text]
  );
  return Number(result.lastInsertId ?? 0);
}

/** 某班在 [startDate, endDate] 闭区间内的日程事件（班级日历用，按日期升序） */
export async function listClassEventsInRange(
  className: string,
  startDate: string,
  endDate: string
): Promise<CalendarEvent[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .calendarEvents.filter(
        (e) => e.class_name === className && e.event_date >= startDate && e.event_date <= endDate
      )
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<CalendarEvent[]>(
    `SELECT * FROM calendar_events
      WHERE class_name = ? AND event_date >= ? AND event_date <= ?
      ORDER BY event_date ASC, id ASC`,
    [className, startDate, endDate]
  );
}

/**
 * 教师维度在日期区间内的全部日程事件（首页 / 我的课表 / Agent 用）：
 * 含班级事件与个人事件（class_name 为 null）——班主任关心自己所有班的事。
 */
export async function listTeacherEventsInRange(
  startDate: string,
  endDate: string
): Promise<CalendarEvent[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .calendarEvents.filter((e) => e.event_date >= startDate && e.event_date <= endDate)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<CalendarEvent[]>(
    `SELECT * FROM calendar_events
      WHERE event_date >= ? AND event_date <= ?
      ORDER BY event_date ASC, id ASC`,
    [startDate, endDate]
  );
}

/** 切换日程事件完成状态 */
export async function setCalendarEventDone(id: number, done: boolean): Promise<void> {
  if (!isTauri()) {
    const event = mem().calendarEvents.find((e) => e.id === id);
    if (event) {
      event.done = done ? 1 : 0;
      event.updated_at = now();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE calendar_events SET done = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [done ? 1 : 0, id]
  );
}

/** 删除一条日程事件 */
export async function deleteCalendarEvent(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.calendarEvents = store.calendarEvents.filter((e) => e.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM calendar_events WHERE id = ?", [id]);
}

/**
 * 写入日程事件的 AI 快速浏览标题（memo-ai 生成成功后调用，一次生成永久复用）。
 * 仅在已配置 AI 模型时会被调用；title 保持 NULL = 界面退回显示全文前几个字。
 */
export async function setCalendarEventTitle(id: number, title: string): Promise<void> {
  const text = title.trim().slice(0, 30);
  if (!text) return;
  if (!isTauri()) {
    const event = mem().calendarEvents.find((e) => e.id === id);
    if (event) {
      event.title = text;
      event.updated_at = now();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE calendar_events SET title = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [text, id]
  );
}
