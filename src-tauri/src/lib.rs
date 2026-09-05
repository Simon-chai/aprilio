mod ai;
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

/// 前端（src/lib/db.ts）约定使用的表结构与初始数据。
fn migrations() -> Vec<Migration> {
  vec![Migration {
    version: 1,
    description: "create_initial_tables",
    sql: r#"
      CREATE TABLE IF NOT EXISTS students (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL DEFAULT '',
        gender         TEXT NOT NULL DEFAULT 'male',
        birth_date     TEXT,
        student_no     TEXT,
        grade_class    TEXT,
        enroll_date    TEXT,
        guardian_name  TEXT,
        guardian_phone TEXT,
        address        TEXT,
        status         TEXT NOT NULL DEFAULT 'active',
        note           TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS photos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        file_name  TEXT NOT NULL,
        caption    TEXT,
        taken_at   TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS profile (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL DEFAULT '',
        title      TEXT NOT NULL DEFAULT '',
        motto      TEXT NOT NULL DEFAULT '',
        avatar     TEXT NOT NULL DEFAULT '',
        hero       TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      INSERT INTO profile (id) VALUES (1) ON CONFLICT(id) DO NOTHING;
    "#,
    kind: MigrationKind::Up,
  }, Migration {
    version: 2,
    description: "add_class_photos_support",
    sql: r#"
      ALTER TABLE photos ADD COLUMN grade_class TEXT;
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
      rag::rag_reindex,
      rag::semantic_search,
      roster::roster_read_text,
      roster::roster_read_table
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
