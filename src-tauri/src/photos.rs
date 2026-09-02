use std::{fs, path::PathBuf};
use log::{error, info};
use tauri::{AppHandle, Manager};

const VALID_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// 返回并确保存在「应用数据目录/photos」，作为照片的统一存储目录。
fn photos_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| {
      error!(target: "photos", "无法定位应用数据目录：{e}");
      format!("无法定位应用数据目录：{e}")
    })?
    .join("photos");
  fs::create_dir_all(&dir).map_err(|e| {
    error!(target: "photos", "无法创建照片目录 {}：{e}", dir.display());
    format!("无法创建照片目录：{e}")
  })?;
  Ok(dir)
}

/// 前端调用：获取照片目录路径（正斜杠形式）。
#[tauri::command]
pub fn photos_dir(app: AppHandle) -> Result<String, String> {
  photos_dir_path(&app).map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// 前端调用：把用户选中的图片文件导入照片目录，返回落盘后的文件名。
#[tauri::command]
pub fn import_photo(app: AppHandle, source: String) -> Result<String, String> {
  let dir = photos_dir_path(&app)?;
  let src = PathBuf::from(&source);
  let ext = src
    .extension()
    .and_then(|e| e.to_str())
    .map(|s| s.to_ascii_lowercase())
    .unwrap_or_default();
  if !VALID_EXTS.contains(&ext.as_str()) {
    error!(target: "photos", "导入照片被拒绝：不支持的格式 {ext}（源：{}）", src.display());
    return Err(format!("不支持的图片格式：{ext}"));
  }
  if !src.is_file() {
    error!(target: "photos", "导入照片被拒绝：源文件不存在（{}）", src.display());
    return Err("源图片文件不存在".into());
  }

  let nanos = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let file_name = format!("img_{nanos}.{ext}");
  fs::copy(&src, dir.join(&file_name)).map_err(|e| {
    error!(target: "photos", "导入照片失败：{e}（源：{} → {}）", src.display(), dir.join(&file_name).display());
    format!("导入照片失败：{e}")
  })?;
  info!(target: "photos", "已导入照片 {file_name}（源：{}）", src.display());
  Ok(file_name)
}

/// 前端调用：从照片目录删除文件。
#[tauri::command]
pub fn delete_photo_file(app: AppHandle, file_name: String) -> Result<(), String> {
  // 仅允许 base 文件名，防止路径穿越。
  let safe = PathBuf::from(&file_name)
    .file_name()
    .and_then(|n| n.to_str())
    .map(String::from)
    .ok_or_else(|| "非法的文件名".to_string())?;
  let path = photos_dir_path(&app)?.join(safe);
  if path.is_file() {
    fs::remove_file(&path).map_err(|e| {
      error!(target: "photos", "删除照片失败：{e}（文件：{file_name}）");
      format!("删除照片失败：{e}")
    })?;
    info!(target: "photos", "已删除照片 {file_name}");
  }
  Ok(())
}
