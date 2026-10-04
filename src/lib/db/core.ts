/**
 * db 连接与结构（拆分自 db.ts，公共 API 经 src/lib/db.ts 门面转发）：
 * 单例连接 / 前端表结构契约 / 幂等建表 / 多语句事务原语。
 *
 * isTauri 特意在这里保留一份私有语义的实现并导出给 db/ 各域文件：
 * 读真实运行环境、不给 mock 入口 —— 单测恒走内存库；SQLite 通道的
 * 等价性靠 tests/schema-sync.test.ts 与按域 db 测试兜底。
 */
import Database from "@tauri-apps/plugin-sql";

/**
 * db 内部通道切换用：读真实运行环境（不给 mock 入口），
 * 单测里恒为 false ⇒ 全部走内存库；SQLite 通道等价性靠 schema-sync 与按域 db 测试兜底。
 */
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
    name        TEXT PRIMARY KEY,
    archived_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
  `CREATE TABLE IF NOT EXISTS student_term_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    semester   TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (student_id, semester),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_term_comments_student ON student_term_comments(student_id, semester)`,
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
  `CREATE TABLE IF NOT EXISTS student_homework_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL,
    homework_date TEXT NOT NULL,
    subject       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'done',
    score         REAL,
    comment       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_homework_student_date ON student_homework_records(student_id, homework_date)`,
  `CREATE TABLE IF NOT EXISTS student_eval_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL,
    range_start   TEXT NOT NULL,
    range_end     TEXT NOT NULL,
    semester      TEXT,
    title         TEXT NOT NULL DEFAULT '',
    content_md    TEXT NOT NULL DEFAULT '',
    short_comment TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'manual',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eval_reports_student ON student_eval_reports(student_id, range_start)`,
  /* 课堂模式（会话 × 活动 × 事件）：与 lib.rs v9 迁移文本同构 */
  `CREATE TABLE IF NOT EXISTS lesson_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name        TEXT NOT NULL,
    subject           TEXT NOT NULL DEFAULT '',
    lesson_date       TEXT NOT NULL,
    period            INTEGER,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    status            TEXT NOT NULL DEFAULT 'live',
    activity_set_json TEXT NOT NULL DEFAULT '[]',
    stats_json        TEXT,
    digest_md         TEXT,
    digest_source     TEXT,
    created_at        TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_sessions_slot
    ON lesson_sessions(class_name, lesson_date, period)`,
  `CREATE INDEX IF NOT EXISTS idx_lesson_sessions_live ON lesson_sessions(status) WHERE status = 'live'`,
  `CREATE TABLE IF NOT EXISTS lesson_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        INTEGER NOT NULL REFERENCES lesson_sessions(id) ON DELETE CASCADE,
    student_id        INTEGER REFERENCES students(id) ON DELETE CASCADE,
    activity          TEXT NOT NULL,
    kind              TEXT NOT NULL,
    payload           TEXT NOT NULL DEFAULT '{}',
    settled_record_id INTEGER,
    occurred_at       TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    revoked_at        TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lesson_events_session ON lesson_events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lesson_events_student_pick
    ON lesson_events(student_id, kind, occurred_at) WHERE revoked_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS seatings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_name TEXT NOT NULL,
    semester   TEXT NOT NULL,
    row_no     INTEGER NOT NULL,
    col_no     INTEGER NOT NULL,
    group_no   INTEGER NOT NULL DEFAULT 0,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_seatings_slot ON seatings(class_name, semester, row_no, col_no)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_seatings_student ON seatings(class_name, semester, student_id)`,
  `CREATE TABLE IF NOT EXISTS classroom_activity_sets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL DEFAULT '',
    activities_json TEXT NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  )`,
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
  try {
    // 班级归档时刻（2026-09-09）：NULL = 在用；有值 = 历史带过的班
    await db.execute("ALTER TABLE classes ADD COLUMN archived_at TEXT");
  } catch {
    /* 列已存在 */
  }
  await migrateLegacyCalendarMemos(db);
}

export function getDb(): Promise<Database> {
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

/**
 * 多语句写批：一次 execute 内联 BEGIN IMMEDIATE … COMMIT，全部语句原子生效。
 *
 * 为什么不做「跨 execute 的 BEGIN/COMMIT」：tauri-plugin-sql 底层是 sqlx 连接池
 * （Pool::connect 默认多连接），两次 execute 可能落在不同连接上，事务边界会失效；
 * 多表写必须把同批语句与参数扁平化后拼进同一次调用（与 appendLessonEvent 样板一致）。
 * 语句序列里引用其他语句新插入行的 id 时，用
 * `(SELECT id FROM <表> WHERE rowid = last_insert_rowid())` 内联回填。
 */
export async function executeBatch(db: Database, statements: string[], params: unknown[]): Promise<void> {
  await db.execute(`BEGIN IMMEDIATE;\n${statements.join(";\n")};\nCOMMIT;`, params);
}

