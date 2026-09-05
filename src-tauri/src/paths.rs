//! 应用数据目录定位（Tauri 之外的独立进程可用）。
//!
//! tauri 的 `app_config_dir` = `dirs::config_dir()` + identifier
//! （Windows：`%APPDATA%/com.tauri.dev`），tauri-plugin-sql 的 `sqlite:aprilio.db`
//! 即落在这里。MCP 子进程（mcp_server.rs）与 RAG（rag.rs）用同一套解析，
//! 保证与插件打开的是同一个文件。photos 同在 app_data_dir 下（photos.rs 约定）。
//!
//! 环境变量 `APRILIO_APP_DIR` 可整体覆盖（测试 / 便携部署用）。

use std::path::PathBuf;

/// 与 src-tauri/tauri.conf.json 的 identifier 保持一致（改配置时同步改这里）
pub const APP_IDENTIFIER: &str = "com.tauri.dev";

/// 应用数据根目录（含 identifier 一层）
pub fn app_data_dir() -> Result<PathBuf, String> {
  if let Ok(override_dir) = std::env::var("APRILIO_APP_DIR") {
    let trimmed = override_dir.trim();
    if !trimmed.is_empty() {
      return Ok(PathBuf::from(trimmed));
    }
  }
  dirs::config_dir()
    .map(|base| base.join(APP_IDENTIFIER))
    .ok_or_else(|| "无法定位应用数据目录（%APPDATA%）。".to_string())
}

/// SQLite 数据库文件（tauri-plugin-sql 的 `sqlite:aprilio.db`）
pub fn db_path() -> Result<PathBuf, String> {
  Ok(app_data_dir()?.join("aprilio.db"))
}

/// 照片存储目录（photos.rs 的 `app_data_dir/photos`）
pub fn photos_dir() -> Result<PathBuf, String> {
  Ok(app_data_dir()?.join("photos"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn override_env_takes_precedence() {
    // 串行测试共享进程环境：先设后清，避免影响其他用例
    std::env::set_var("APRILIO_APP_DIR", "D:/aprilio-test-dir");
    let dir = app_data_dir().expect("覆盖模式下应成功");
    std::env::remove_var("APRILIO_APP_DIR");
    assert!(dir.to_string_lossy().contains("aprilio-test-dir"));
  }

  #[test]
  fn default_layout_contains_db_and_photos() {
    let base = app_data_dir().expect("默认模式应成功");
    // 目录本身允许不存在（未启动过应用），这里只验证路径拼接关系
    assert!(base.join("aprilio.db").ends_with("aprilio.db"));
    assert!(base.join("photos").ends_with("photos"));
    assert!(base.to_string_lossy().contains(APP_IDENTIFIER));
  }
}
