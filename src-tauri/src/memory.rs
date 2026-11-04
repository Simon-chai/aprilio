//! Agent 记忆文件（`app_data_dir/agent-memory.md`，路径解析在 paths.rs）。
//!
//! 应用在后台从用户与 AI 助手的对话中沉淀使用偏好（对功能的叫法、操作习惯、
//! 回答风格要求），落成一份用户可见可编辑的 Markdown 记忆文件，每次对话作为
//! 上下文注入助手主提示词。只存「偏好」不存业务数据（学生姓名、成绩等由
//! 整理提示词负责挡掉）；文件删除后应用会在下次启动时重建模板。
//!
//! 三个命令都不需要 AppHandle：路径解析走 paths.rs（与 MCP / RAG 同一套），
//! 测试可用 APRILIO_APP_DIR 覆盖数据目录。

use log::{error, info};

/// 单文件大小上限：64 KB，超过拒绝写入（自动更新失控膨胀的保险丝）
const MAX_BYTES: usize = 64 * 1024;

/// 前端调用：读取记忆文件全文；文件不存在返回空串（与「空文件」不作区分，
/// 由前端负责播种模板）。
#[tauri::command]
pub fn agent_memory_read() -> Result<String, String> {
  let path = crate::paths::agent_memory_path()?;
  match std::fs::read_to_string(&path) {
    Ok(content) => Ok(content),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => {
      error!(target: "memory", "读取记忆文件失败 {}：{e}", path.display());
      Err(format!("读取记忆文件失败：{e}"))
    }
  }
}

/// 前端调用：整文件覆盖写入记忆内容。
#[tauri::command]
pub fn agent_memory_write(content: String) -> Result<(), String> {
  let path = crate::paths::agent_memory_path()?;
  if content.len() > MAX_BYTES {
    let msg = format!("记忆内容超过上限（{} KB），已拒绝写入。", MAX_BYTES / 1024);
    error!(target: "memory", "{msg}");
    return Err(msg);
  }
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?;
  }
  std::fs::write(&path, content.as_bytes()).map_err(|e| {
    error!(target: "memory", "写入记忆文件失败 {}：{e}", path.display());
    format!("写入记忆文件失败：{e}")
  })?;
  info!(target: "memory", "记忆文件已更新（{} 字节）", content.len());
  Ok(())
}

/// 前端调用：记忆文件完整路径（设置页展示用，正斜杠形式）。
#[tauri::command]
pub fn agent_memory_path() -> Result<String, String> {
  let path = crate::paths::agent_memory_path()?;
  Ok(path.to_string_lossy().replace('\\', "/"))
}
