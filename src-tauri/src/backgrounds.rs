//! 背景图缓存目录（`app_data_dir/backgrounds`）。
//!
//! 首页大图 / 头像 / 课表背景的统一管线是「取原图字节 → 前端裁剪 → dataURL 写盘」：
//! - `download_background`：下载网络图片，**返回字节**（base64），不落盘；
//! - `read_image_bytes`：读本地图片文件，返回字节（base64），不落盘；
//! - `save_background_data_url`：把前端裁剪产出的 dataURL 校验后写盘（`bg_<纳秒>.<ext>`）；
//! - `delete_background_file`：删除缓存文件。
//!
//! 只有裁剪确认后的最终图才落盘；原图不驻留磁盘，换背景可重新取景（URL 记在索引 origin_url 里）。

use std::{
  fs,
  path::PathBuf,
  time::{SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use log::{error, info};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 允许的图片扩展名 / MIME（校验与扩展名推导共用）
const VALID_TYPES: [(&str, &str); 5] = [
  ("png", "image/png"),
  ("jpg", "image/jpeg"),
  ("webp", "image/webp"),
  ("gif", "image/gif"),
  ("bmp", "image/bmp"),
];
/// 单张图片字节上限：12 MB（下载 / 本地读取 / dataURL 写盘共用）
const MAX_BYTES: usize = 12 * 1024 * 1024;

/// 原图字节：mime 用于前端拼 dataURL，base64 直接进裁剪组件
#[derive(Serialize)]
pub struct ImageBytes {
  pub mime: String,
  pub base64: String,
}

fn backgrounds_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| {
      error!(target: "photos", "无法定位应用数据目录：{e}");
      format!("无法定位应用数据目录：{e}")
    })?
    .join("backgrounds");
  fs::create_dir_all(&dir).map_err(|e| {
    error!(target: "photos", "无法创建背景图目录 {}：{e}", dir.display());
    format!("无法创建背景图目录：{e}")
  })?;
  Ok(dir)
}

/// 统一的文件名生成：`bg_<纳秒时间戳>.<扩展名>`
fn new_file_name(ext: &str) -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  format!("bg_{nanos}.{ext}")
}

fn mime_to_ext(mime: &str) -> Option<&'static str> {
  VALID_TYPES
    .iter()
    .find(|(_, m)| *m == mime)
    .map(|(e, _)| *e)
}

fn ext_to_mime(ext: &str) -> Option<&'static str> {
  VALID_TYPES
    .iter()
    .find(|(e, _)| *e == ext)
    .map(|(_, m)| *m)
}

/// 按文件头判断真实图片类型；光看 URL 后缀不可靠，以内容为准。
fn ext_from_magic(bytes: &[u8]) -> Option<&'static str> {
  if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
    return Some("png");
  }
  if bytes.starts_with(b"\xFF\xD8\xFF") {
    return Some("jpg");
  }
  if bytes.starts_with(b"GIF8") {
    return Some("gif");
  }
  if bytes.starts_with(b"BM") {
    return Some("bmp");
  }
  // RIFF....WEBP
  if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
    return Some("webp");
  }
  None
}

/// 把图片字节包装成 ImageBytes；类型以文件头为准（推导不出再退 mime 参数）。
fn image_bytes(bytes: &[u8], fallback_mime: &str) -> Result<ImageBytes, String> {
  let ext = ext_from_magic(bytes)
    .or_else(|| mime_to_ext(fallback_mime))
    .ok_or_else(|| "不是受支持的图片（png/jpg/webp/gif/bmp）".to_string())?;
  let mime = ext_to_mime(ext).unwrap_or(fallback_mime);
  Ok(ImageBytes {
    mime: mime.to_string(),
    base64: base64::engine::general_purpose::STANDARD.encode(bytes),
  })
}

/// 前端调用：背景图缓存目录路径（正斜杠形式）。
#[tauri::command]
pub fn backgrounds_dir(app: AppHandle) -> Result<String, String> {
  backgrounds_dir_path(&app).map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// 前端调用：下载网络图片，返回图片字节（不落盘）。
///
/// 只接受 http/https；Content-Length 与响应体双重限流，类型以文件头为准。
#[tauri::command]
pub async fn download_background(_app: AppHandle, url: String) -> Result<ImageBytes, String> {
  let trimmed = url.trim().to_string();
  if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
    return Err("只支持 http/https 开头的图片链接".into());
  }

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| format!("初始化下载器失败：{e}"))?;

  let resp = client
    .get(&trimmed)
    .header(reqwest::header::USER_AGENT, "aprilio/0.1")
    .send()
    .await
    .map_err(|e| {
      error!(target: "photos", "下载背景图失败：{e}（{trimmed}）");
      format!("下载图片失败：{e}")
    })?;

  if !resp.status().is_success() {
    let status = resp.status();
    error!(target: "photos", "下载背景图被拒绝：HTTP {status}（{trimmed}）");
    return Err(format!("图片下载失败：服务器返回 HTTP {status}"));
  }

  if let Some(len) = resp.content_length() {
    if len > MAX_BYTES as u64 {
      return Err("图片过大（超过 12MB），请换一张".into());
    }
  }

  let content_type = resp
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("application/octet-stream")
    .to_string();

  let bytes = resp
    .bytes()
    .await
    .map_err(|e| format!("读取图片数据失败：{e}"))?;
  if bytes.len() > MAX_BYTES {
    return Err("图片过大（超过 12MB），请换一张".into());
  }

  image_bytes(&bytes, &content_type)
}

/// 前端调用：读本地图片文件，返回图片字节（不落盘；落盘由裁剪确认后的
/// save_background_data_url 一步完成，不产生中间文件）。
#[tauri::command]
pub fn read_image_bytes(_app: AppHandle, source: String) -> Result<ImageBytes, String> {
  let src = PathBuf::from(&source);
  let ext = src
    .extension()
    .and_then(|e| e.to_str())
    .map(|s| s.to_ascii_lowercase())
    .unwrap_or_default();
  if !VALID_TYPES.iter().any(|(e, _)| *e == ext) {
    error!(target: "photos", "读取图片被拒绝：不支持的格式 {ext}（源：{}）", src.display());
    return Err(format!("不支持的图片格式：{ext}"));
  }
  if !src.is_file() {
    error!(target: "photos", "读取图片被拒绝：源文件不存在（{}）", src.display());
    return Err("源图片文件不存在".into());
  }

  let bytes = fs::read(&src).map_err(|e| {
    error!(target: "photos", "读取图片失败：{e}（{}）", src.display());
    format!("读取图片失败：{e}")
  })?;
  if bytes.len() > MAX_BYTES {
    return Err("图片过大（超过 12MB），请换一张".into());
  }

  let mime = ext_to_mime(&ext).unwrap_or("application/octet-stream");
  image_bytes(&bytes, mime)
}

/// 前端调用：把裁剪产出的 dataURL 校验后写盘，返回落盘文件名。
///
/// dataURL 形如 `data:image/png;base64,xxx`；mime 限白名单，解码后再按文件头复核，
/// 防止把非图片内容写进缓存目录。
#[tauri::command]
pub fn save_background_data_url(app: AppHandle, data_url: String) -> Result<String, String> {
  let (mime, payload) = data_url
    .strip_prefix("data:")
    .and_then(|rest| rest.split_once(";base64,"))
    .ok_or_else(|| "dataURL 格式不合法".to_string())?;

  let ext = mime_to_ext(mime)
    .ok_or_else(|| format!("不支持的图片类型：{mime}"))?;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(payload)
    .map_err(|e| format!("图片数据解码失败：{e}"))?;
  if bytes.is_empty() {
    return Err("图片数据为空".into());
  }
  if bytes.len() > MAX_BYTES {
    return Err("图片过大（超过 12MB），请重新裁剪".into());
  }
  // 文件头复核：mime 声称是图片还不够
  if ext_from_magic(&bytes).is_none() {
    error!(target: "photos", "背景图写盘被拒绝：文件头不是图片");
    return Err("内容不是有效的图片".into());
  }

  let dir = backgrounds_dir_path(&app)?;
  let file_name = new_file_name(ext);
  fs::write(dir.join(&file_name), &bytes).map_err(|e| {
    error!(target: "photos", "写入背景图失败：{e}（{}）", dir.join(&file_name).display());
    format!("保存图片失败：{e}")
  })?;
  info!(target: "photos", "已保存背景图 {file_name}（{} KB）", bytes.len() / 1024);
  Ok(file_name)
}

/// 前端调用：从背景图目录删除文件。
#[tauri::command]
pub fn delete_background_file(app: AppHandle, file_name: String) -> Result<(), String> {
  // 仅允许 base 文件名，防止路径穿越
  let safe = PathBuf::from(&file_name)
    .file_name()
    .and_then(|n| n.to_str())
    .map(String::from)
    .ok_or_else(|| "非法的文件名".to_string())?;
  let path = backgrounds_dir_path(&app)?.join(safe);
  if path.is_file() {
    fs::remove_file(&path).map_err(|e| {
      error!(target: "photos", "删除背景图失败：{e}（文件：{file_name}）");
      format!("删除背景图失败：{e}")
    })?;
    info!(target: "photos", "已删除背景图 {file_name}");
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn detects_image_type_from_magic_bytes() {
    assert_eq!(ext_from_magic(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
    assert_eq!(ext_from_magic(b"\xFF\xD8\xFF\xE0"), Some("jpg"));
    assert_eq!(ext_from_magic(b"GIF89a"), Some("gif"));
    assert_eq!(ext_from_magic(b"BMxxxx"), Some("bmp"));
    assert_eq!(ext_from_magic(b"RIFF\x00\x00\x00\x00WEBPxxx"), Some("webp"));
    assert_eq!(ext_from_magic(b"<html><body>404</body></html>"), None);
  }

  #[test]
  fn wraps_bytes_with_magic_sniffed_mime() {
    let wrapped = image_bytes(b"\x89PNG\r\n\x1a\nrest", "application/octet-stream").unwrap();
    assert_eq!(wrapped.mime, "image/png");
    assert!(!wrapped.base64.is_empty());

    // 魔数认不出时退 content-type；都认不出则报错
    let fallback = image_bytes(b"???unknown???", "image/webp").unwrap();
    assert_eq!(fallback.mime, "image/webp");
    assert!(image_bytes(b"<html>404</html>", "text/html").is_err());
  }

  #[test]
  fn parses_data_url_prefix_and_rejects_unknown_mime() {
    let ok = "data:image/png;base64,iVBORw0KGgo=";
    let (mime, payload) = ok
      .strip_prefix("data:")
      .and_then(|rest| rest.split_once(";base64,"))
      .unwrap();
    assert_eq!(mime, "image/png");
    assert_eq!(payload, "iVBORw0KGgo=");
    assert!(mime_to_ext("text/html").is_none());
    assert!(mime_to_ext("image/png").is_some());
  }
}
