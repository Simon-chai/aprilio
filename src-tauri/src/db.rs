//! SQLite 直连（sqlx，与 tauri-plugin-sql 同一版本与同一文件）。
//!
//! - MCP 子进程：只读连接（read_only=true，进程内无法写入）；
//! - RAG：读写连接（重建索引时写 embeddings 表）。
//! 默认 5s busy_timeout，容忍与运行中应用的短暂锁竞争。

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::time::Duration;

/// 打开应用数据库连接池。read_only=true 时连接级别禁止写入。
pub(crate) async fn open_pool(read_only: bool) -> Result<SqlitePool, String> {
  let path = crate::paths::db_path()?;
  if !path.exists() {
    return Err(format!(
      "未找到数据库文件（{}）。请先启动 aprilio 完成初始化。",
      path.display()
    ));
  }
  let mut opts = SqliteConnectOptions::new()
    .filename(&path)
    .busy_timeout(Duration::from_secs(5));
  if read_only {
    opts = opts.read_only(true);
  }
  SqlitePoolOptions::new()
    .max_connections(2)
    .connect_with(opts)
    .await
    .map_err(|e| format!("打开数据库失败：{e}"))
}

/// 从行里取可空的字符串（NULL → None）
pub(crate) fn opt_str(row: &sqlx::sqlite::SqliteRow, col: &str) -> Option<String> {
  row.try_get::<Option<String>, _>(col).unwrap_or(None)
}

/// 导出给测试用（保持 Row 引用不被 clippy 抱怨）
#[allow(dead_code)]
pub(crate) fn row_debug(row: &sqlx::sqlite::SqliteRow) -> String {
  format!("columns: {}", row.columns().len())
}
