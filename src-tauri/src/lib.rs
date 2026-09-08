mod ai;
mod backgrounds;
mod capabilities;
mod db;
pub mod mcp_server;
mod paths;
mod photos;
mod rag;
mod roster;

use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_sql::{Migration, MigrationKind};

const DB_URL: &str = "sqlite:aprilio.db";

/// 前端（src/lib/db.ts）约定使用的表结构。
/// 版本号只增不复用：本地调试库历史上曾用 v2 建过成绩表（后来并入 v1），
/// 重用版本号会被已应用的记录跳过。v1 = 收敛后的全量建表（新库直接到位）；
/// v2 与历史库对齐（幂等空转）；v3 给早于课表功能的调试库幂等补齐课表/万年历表。
/// 任教学科列与全部表结构另有前端 ensureSchema（src/lib/db.ts）启动时幂等兜底，双保险防「no such table」。
fn migrations() -> Vec<Migration> {
  vec![Migration {
    version: 1,
    description: "create_initial_tables",
    sql: r#"
      -- 学生档案（身份证号选填；监护人独立成表，不再内联姓名/电话列）
      CREATE TABLE IF NOT EXISTS students (
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
      );

      -- 监护人：支持多位；occupation / tags 服务风格标注（tags 存 JSON 数组字符串）
      CREATE TABLE IF NOT EXISTS guardians (
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
      );

      CREATE INDEX IF NOT EXISTS idx_guardians_student_id ON guardians(student_id);

      -- 图片记录：student_id 为空且 grade_class 有值 = 班级公共照片
      CREATE TABLE IF NOT EXISTS photos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id  INTEGER,
        grade_class TEXT,
        file_name   TEXT NOT NULL,
        caption     TEXT,
        taken_at    TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );

      -- 显式班级（列表页班级卡片的权威来源，学生/照片上的班级名聚合为补充）
      CREATE TABLE IF NOT EXISTS classes (
        name       TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS profile (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        title       TEXT NOT NULL DEFAULT '',
        motto       TEXT NOT NULL DEFAULT '',
        avatar      TEXT NOT NULL DEFAULT '',
        hero        TEXT NOT NULL DEFAULT '',
        my_subjects TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      INSERT INTO profile (id) VALUES (1) ON CONFLICT(id) DO NOTHING;

      -- 日常表现：维度字典 → 事实流水 → 评语沉淀（三层范式）
      CREATE TABLE IF NOT EXISTS behavior_dimensions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        category    TEXT NOT NULL DEFAULT 'study',
        code        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        icon        TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_system   INTEGER NOT NULL DEFAULT 1,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      INSERT OR IGNORE INTO behavior_dimensions (id, category, code, name, icon, sort_order, is_system) VALUES
        (1, 'study',    'homework',  '作业情况',         'BookOpen',     1, 1),
        (2, 'study',    'exam',      '单元/期中期末成绩', 'GraduationCap', 2, 1),
        (3, 'behavior', 'classroom', '课堂表现',         'MessageSquare', 3, 1),
        (4, 'behavior', 'labor',     '劳动情况',         'Sparkles',      4, 1);

      -- 表现事实流水：维度名/分类做快照，防字典更名影响历史
      CREATE TABLE IF NOT EXISTS student_behavior_records (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id          INTEGER NOT NULL,
        dimension_id        INTEGER NOT NULL,
        dimension_name_snap TEXT NOT NULL,
        category_snap       TEXT NOT NULL,
        type                TEXT NOT NULL DEFAULT 'praise',  -- 评价倾向：'praise' | 'improve' | 'neutral'
        comment             TEXT NOT NULL,
        recorded_date       TEXT NOT NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_behavior_student_date ON student_behavior_records(student_id, recorded_date);
      CREATE INDEX IF NOT EXISTS idx_behavior_recorded_date ON student_behavior_records(recorded_date);
      CREATE INDEX IF NOT EXISTS idx_behavior_dimension ON student_behavior_records(dimension_id);

      -- 评语知识沉淀：use_count 驱动「常用」排序
      CREATE TABLE IF NOT EXISTS behavior_comment_presets (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        dimension_id INTEGER NOT NULL,
        type         TEXT NOT NULL DEFAULT 'praise',
        content      TEXT NOT NULL,
        use_count    INTEGER NOT NULL DEFAULT 1,
        source       TEXT NOT NULL DEFAULT 'system',
        last_used_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (dimension_id) REFERENCES behavior_dimensions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_comment_presets_dim_type ON behavior_comment_presets(dimension_id, type, use_count DESC);

      INSERT INTO behavior_comment_presets (dimension_id, type, content, source) VALUES
        (1, 'praise',  '书写工整规范，解题步骤完整清晰', 'system'),
        (1, 'praise',  '按时独立完成作业，正确率极高', 'system'),
        (1, 'improve', '作业未按时提交，需及时补交', 'system'),
        (1, 'improve', '错题漏题较多，未进行及时订正', 'system'),
        (1, 'neutral', '作业按时完成，整体表现平稳', 'system'),
        (2, 'praise',  '测试成绩名列前茅，基础扎实知识掌握牢固', 'system'),
        (2, 'praise',  '较上次有显著进步，难题突破能力提升', 'system'),
        (2, 'improve', '基础计算失误较多，需加强审题与验算习惯', 'system'),
        (2, 'improve', '重点知识点有脱节，需针对性复习补漏', 'system'),
        (2, 'neutral', '成绩处于班级平均水平，保持学习节奏', 'system'),
        (3, 'praise',  '课堂听讲专注，积极举手发言发表独到见解', 'system'),
        (3, 'praise',  '互动热烈，能主动带动小组讨论探索', 'system'),
        (3, 'improve', '课堂听讲容易走神，需要老师多次提醒注意集中', 'system'),
        (3, 'improve', '自控力较弱，有做小动作或讲话现象', 'system'),
        (3, 'neutral', '课堂表现平稳，能按时完成课堂任务', 'system'),
        (4, 'praise',  '主动承担卫生大扫除，擦黑板和整理卫生角非常细致', 'system'),
        (4, 'praise',  '值日尽职尽责，主动帮助其他同学整理桌椅', 'system'),
        (4, 'improve', '值日敷衍草率，未完成清洁任务提前离开', 'system'),
        (4, 'improve', '缺乏公共卫生意识，桌面及周围杂物未整理', 'system'),
        (4, 'neutral', '按安排完成值日任务', 'system');

      -- 回收站：删除的班级 / 学生整体快照，7 天后由前端启动与打开回收站时清理
      CREATE TABLE IF NOT EXISTS recycle_bin (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,              -- 'class' | 'student'
        label       TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        payload     TEXT NOT NULL,              -- 快照 JSON
        deleted_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON recycle_bin(deleted_at);

      -- 考试批次：一次考试 = 一批成绩（考试名 + 考试时间），班级沿用 grade_class 文本口径
      -- exam_type：大考 major / 小考 minor（旧库由前端 ensureSchema 幂等补列）
      CREATE TABLE IF NOT EXISTS exams (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name  TEXT NOT NULL,
        name        TEXT NOT NULL,
        exam_date   TEXT NOT NULL,               -- YYYY-MM-DD
        exam_type   TEXT NOT NULL DEFAULT 'minor',
        note        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_exams_class_date ON exams(class_name, exam_date);

      -- 成绩：考试 × 学生 × 科目 唯一（导入天然幂等）；数字分存 score，等级/缺考等文字存 grade
      CREATE TABLE IF NOT EXISTS exam_scores (
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
      );

      CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id);
      CREATE INDEX IF NOT EXISTS idx_exam_scores_student ON exam_scores(student_id);

      -- 课表：一班一学期一张（班级沿用 grade_class 文本口径），换学期建新表不覆盖旧表
      CREATE TABLE IF NOT EXISTS timetables (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name   TEXT NOT NULL,
        semester     TEXT NOT NULL,              -- 学期号，如 2026-2027-1
        note         TEXT,
        periods_json TEXT,                       -- 节次配置 JSON；NULL = 默认节次
        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (class_name, semester)
      );

      CREATE INDEX IF NOT EXISTS idx_timetables_class ON timetables(class_name, semester);

      -- 课表格子：一行 = 一节课（空格子不落行）；同一（天, 节）唯一，编辑天然幂等
      CREATE TABLE IF NOT EXISTS timetable_slots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        timetable_id INTEGER NOT NULL,
        day_of_week  INTEGER NOT NULL,           -- 1=周一 … 5=周五
        period       INTEGER NOT NULL,           -- 节次从 1 起
        subject      TEXT NOT NULL DEFAULT '',
        note         TEXT,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (timetable_id, day_of_week, period),
        FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_timetable_slots_timetable ON timetable_slots(timetable_id);

      -- 万年历备忘：班级维度（与课表同口径）；课程上日历之前的轻量日程
      CREATE TABLE IF NOT EXISTS calendar_memos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name TEXT NOT NULL,
        memo_date  TEXT NOT NULL,               -- YYYY-MM-DD
        content    TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,  -- 0=待办 1=已完成
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_memos_class_date ON calendar_memos(class_name, memo_date);
    "#,
    kind: MigrationKind::Up,
  },
  Migration {
    version: 2,
    description: "create_exam_score_tables",
    // 与历史调试库已应用的 v2 同名对齐（成绩表现已在 v1 中），幂等空转
    sql: r#"
      CREATE TABLE IF NOT EXISTS exams (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name  TEXT NOT NULL,
        name        TEXT NOT NULL,
        exam_date   TEXT NOT NULL,
        exam_type   TEXT NOT NULL DEFAULT 'minor',
        note        TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_exams_class_date ON exams(class_name, exam_date);

      CREATE TABLE IF NOT EXISTS exam_scores (
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
      );

      CREATE INDEX IF NOT EXISTS idx_exam_scores_exam ON exam_scores(exam_id);
      CREATE INDEX IF NOT EXISTS idx_exam_scores_student ON exam_scores(student_id);
    "#,
    kind: MigrationKind::Up,
  },
  Migration {
    version: 3,
    description: "add_timetable_and_calendar_memos",
    // 早于课表功能的调试库在此补齐。只做幂等建表：不能在这里 ALTER 加列——
    // 被 ensureSchema（src/lib/db.ts）先补过列的库会因 duplicate column 使迁移整体失败。
    // 列的兜底由 ensureSchema 的 try-ALTER 负责。
    sql: r#"
      CREATE TABLE IF NOT EXISTS timetables (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name   TEXT NOT NULL,
        semester     TEXT NOT NULL,
        note         TEXT,
        periods_json TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (class_name, semester)
      );

      CREATE INDEX IF NOT EXISTS idx_timetables_class ON timetables(class_name, semester);

      CREATE TABLE IF NOT EXISTS timetable_slots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        timetable_id INTEGER NOT NULL,
        day_of_week  INTEGER NOT NULL,
        period       INTEGER NOT NULL,
        subject      TEXT NOT NULL DEFAULT '',
        note         TEXT,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (timetable_id, day_of_week, period),
        FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_timetable_slots_timetable ON timetable_slots(timetable_id);

      CREATE TABLE IF NOT EXISTS calendar_memos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name TEXT NOT NULL,
        memo_date  TEXT NOT NULL,
        content    TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_memos_class_date ON calendar_memos(class_name, memo_date);
    "#,
    kind: MigrationKind::Up,
  },
  Migration {
    version: 4,
    description: "add_timetable_exceptions_and_calendar_events",
    // 课表二轮升级：① timetable_exceptions 承载调课/停课/加课（周课表仍是唯一事实源，
    //   例外只覆盖「某天某节」）；② calendar_memos 升级为 calendar_events（班级可空 =
    //   教师个人事件，type 区分备忘/待办/考试/作业），旧备忘数据原样迁入（type='memo'）。
    // v1/v3 均保证 calendar_memos 存在，INSERT..SELECT 在任何迁移路径上都成立。
    sql: r#"
      CREATE TABLE IF NOT EXISTS timetable_exceptions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        timetable_id   INTEGER NOT NULL,
        exception_date TEXT NOT NULL,             -- YYYY-MM-DD，星期几由日期推导
        period         INTEGER NOT NULL,           -- 节次从 1 起
        subject        TEXT NOT NULL DEFAULT '',   -- 空串 = 该节停课
        note           TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (timetable_id, exception_date, period),
        FOREIGN KEY (timetable_id) REFERENCES timetables(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_timetable_exceptions_date ON timetable_exceptions(exception_date);

      CREATE TABLE IF NOT EXISTS calendar_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        class_name TEXT,                          -- NULL = 教师个人事件
        event_date TEXT NOT NULL,                 -- YYYY-MM-DD
        type       TEXT NOT NULL DEFAULT 'memo',  -- memo | todo | exam | homework
        content    TEXT NOT NULL,
        done       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date);
      CREATE INDEX IF NOT EXISTS idx_calendar_events_class_date ON calendar_events(class_name, event_date);

      INSERT INTO calendar_events (class_name, event_date, type, content, done, created_at, updated_at)
        SELECT class_name, memo_date, 'memo', content, done, created_at, updated_at FROM calendar_memos;

      DROP TABLE calendar_memos;
    "#,
    kind: MigrationKind::Up,
  },
  Migration {
    version: 5,
    description: "add_calendar_events_title",
    // 日程事件 AI 快速浏览标题：已配置 AI 模型时由前端生成后回写，一次生成永久复用；
    // NULL = 未生成（未配置模型 / 生成失败），界面退回显示全文前几个字。
    sql: r#"
      ALTER TABLE calendar_events ADD COLUMN title TEXT;
    "#,
    kind: MigrationKind::Up,
  },
  Migration {
    version: 6,
    description: "add_timetables_my_subjects_profile_timetable_bg",
    // 班级「我的科目」标记（JSON 数组；NULL = 未标记回退全局任教学科，[] = 明确标记本班没有我的课）
    // + 首页课表面板背景图（文件名 / dataURL，空为无图）。
    // 注意：students.id_card 这类「v1 建表已含、旧代库缺失」的列不能走迁移补列
    // （新库重放会 duplicate column），由前端 ensureSchema 幂等兜底。
    sql: r#"
      ALTER TABLE timetables ADD COLUMN my_subjects TEXT;
      ALTER TABLE profile ADD COLUMN timetable_bg TEXT;
    "#,
    kind: MigrationKind::Up,
  }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 调试构建记录 Debug 级，正式构建记录 Info 级。
  let log_level = if cfg!(debug_assertions) {
    log::LevelFilter::Debug
  } else {
    log::LevelFilter::Info
  };

  tauri::Builder::default()
    .plugin(
      // 日志始终启用：终端 + 文件双写。
      // 文件位置（Windows）：%APPDATA%/<identifier>/logs/app.log
      tauri_plugin_log::Builder::new()
        .level(log_level)
        .targets([
          Target::new(TargetKind::Stdout),
          Target::new(TargetKind::LogDir { file_name: None }),
        ])
        .build(),
    )
    .setup(|_app| {
      log::info!("aprilio 启动（debug={}）", cfg!(debug_assertions));
      // Rust 执行面能力装载打点 + 与 invoke_handler 对账（漂移即报错）
      capabilities::log_inventory();
      // 把 panic 也记入日志文件，便于排查崩溃。
      std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
      }));
      Ok(())
    })
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations(DB_URL, migrations())
        .build(),
    )
    .invoke_handler(tauri::generate_handler![
      ai::ai_chat,
      ai::ai_chat_stream,
      capabilities::agent_capabilities,
      photos::photos_dir,
      photos::import_photo,
      photos::delete_photo_file,
      backgrounds::backgrounds_dir,
      backgrounds::download_background,
      backgrounds::read_image_bytes,
      backgrounds::save_background_data_url,
      backgrounds::delete_background_file,
      rag::rag_reindex,
      rag::semantic_search,
      roster::roster_read_text,
      roster::roster_read_table
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
