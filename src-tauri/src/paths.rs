//! 应用数据目录定位（Tauri 之外的独立进程可用）。
//!
//! tauri 的 `app_config_dir` = `dirs::config_dir()` + identifier
//! （Windows：`%APPDATA%/<identifier>`），tauri-plugin-sql 的 `sqlite:aprilio.db`
//! 即落在这里。MCP 子进程（mcp_server.rs）与 RAG（rag.rs）用同一套解析，
//! 保证与插件打开的是同一个文件。photos 同在 app_data_dir 下（photos.rs 约定）。
//!
//! 环境变量 `APRILIO_APP_DIR` 可整体覆盖（测试 / 便携部署用）。
//!
//! v1.0.0 打包前 identifier 由占位值 `com.tauri.dev` 换成正式值（安装包要求全局唯一）：
//! 首次启动会把旧 identifier 目录下的整份数据（数据库 / 照片 / 背景 / 日志）接管过来，
//! 升级后老数据不丢，见 `adopt_legacy_data_dir`。

use std::fs;
use std::path::{Path, PathBuf};

/// 与 src-tauri/tauri.conf.json 的 identifier 保持一致（改配置时同步改这里）
pub const APP_IDENTIFIER: &str = "io.github.simonchai.aprilio";

/// 历史 identifier（旧版本地调试库所在目录）：首次启动自动接管其数据
pub const LEGACY_IDENTIFIERS: &[&str] = &["com.tauri.dev"];

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

/// Agent 记忆文件（memory.rs 的 `agent_memory_*` 命令读写的就
/// 是这一份）：从对话中沉淀的用户偏好，助手对话时注入上下文
pub fn agent_memory_path() -> Result<PathBuf, String> {
  Ok(app_data_dir()?.join("agent-memory.md"))
}

/// 首次启动接管旧 identifier 的数据目录（identifier 换过之后保证老数据不丢）：
/// `%APPDATA%/<旧>` → `%APPDATA%/<当前>`（数据库 / photos / backgrounds），
/// `%LOCALAPPDATA%/<旧>` → `%LOCALAPPDATA%/<当前>`（日志）一并搬迁。
///
/// 仅在「当前目录还没有 aprilio.db」且「旧目录有 aprilio.db」时整份拷贝，
/// 目标已有同名文件不覆盖；**必须在任何插件初始化 / 路径解析之前调用**。
/// 返回实际接管的旧 identifier（未发生迁移返回 None）。
pub fn adopt_legacy_data_dir() -> Option<String> {
  // 便携 / 测试模式：路径已被 APRILIO_APP_DIR 覆盖，不触碰真实数据
  if std::env::var("APRILIO_APP_DIR")
    .map(|v| !v.trim().is_empty())
    .unwrap_or(false)
  {
    return None;
  }
  let base = dirs::config_dir()?;
  let target = app_data_dir().ok()?;
  if target.join("aprilio.db").exists() {
    return None;
  }
  for legacy in LEGACY_IDENTIFIERS {
    let source = base.join(legacy);
    if !source.join("aprilio.db").exists() {
      continue;
    }
    copy_dir_into(&source, &target);
    if let Some(local) = dirs::data_local_dir() {
      copy_dir_into(&local.join(legacy), &local.join(APP_IDENTIFIER));
    }
    // 此刻日志系统尚未初始化（本函数必须在插件之前调用），过程信息走 stderr
    eprintln!("[aprilio-init] 已接管旧数据目录「{legacy}」→「{APP_IDENTIFIER}」");
    return Some((*legacy).to_string());
  }
  None
}

/// 目录整份拷贝（递归）：目标已存在的同名文件不覆盖，单文件失败只报 stderr 不中断
fn copy_dir_into(source: &Path, target: &Path) {
  if !source.is_dir() {
    return;
  }
  if let Err(e) = fs::create_dir_all(target) {
    eprintln!("[aprilio-init] 创建目录失败 {}：{e}", target.display());
    return;
  }
  let entries = match fs::read_dir(source) {
    Ok(entries) => entries,
    Err(e) => {
      eprintln!("[aprilio-init] 读取目录失败 {}：{e}", source.display());
      return;
    }
  };
  for entry in entries.flatten() {
    let from = entry.path();
    let to = target.join(entry.file_name());
    if from.is_dir() {
      copy_dir_into(&from, &to);
    } else if !to.exists() {
      if let Err(e) = fs::copy(&from, &to) {
        eprintln!("[aprilio-init] 复制失败 {}：{e}", from.display());
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// 进程环境变量是测试间共享资源：涉及 APRILIO_APP_DIR 的用例必须串行
  static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

  #[test]
  fn override_env_takes_precedence() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("APRILIO_APP_DIR", "D:/aprilio-test-dir");
    let dir = app_data_dir().expect("覆盖模式下应成功");
    std::env::remove_var("APRILIO_APP_DIR");
    assert!(dir.to_string_lossy().contains("aprilio-test-dir"));
  }

  #[test]
  fn default_layout_contains_db_and_photos() {
    // 与覆盖用例互斥，避免读到别的用例临时设置的 APRILIO_APP_DIR
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let base = app_data_dir().expect("默认模式应成功");
    // 目录本身允许不存在（未启动过应用），这里只验证路径拼接关系
    assert!(base.join("aprilio.db").ends_with("aprilio.db"));
    assert!(base.join("photos").ends_with("photos"));
    assert!(base.join("agent-memory.md").ends_with("agent-memory.md"));
    assert!(base.to_string_lossy().contains(APP_IDENTIFIER));
  }

  #[test]
  fn copy_dir_into_copies_recursively_and_keeps_existing_files() {
    let base = std::env::temp_dir().join(format!("aprilio-adopt-test-{}", std::process::id()));
    let source = base.join("legacy");
    let target = base.join("current");
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(source.join("photos")).expect("建测试目录");
    fs::write(source.join("aprilio.db"), b"old-db").expect("写源库");
    fs::write(source.join("photos/p1.png"), b"img").expect("写源照片");
    fs::create_dir_all(&target).expect("建目标目录");
    fs::write(target.join("aprilio.db"), b"new-db").expect("写目标库");

    copy_dir_into(&source, &target);

    // 已有文件不覆盖，缺失的文件与子目录整份补齐
    assert_eq!(fs::read(target.join("aprilio.db")).unwrap(), b"new-db");
    assert_eq!(fs::read(target.join("photos/p1.png")).unwrap(), b"img");
    let _ = fs::remove_dir_all(&base);
  }
}
