//! 花名册文件读取：文本通道（CSV/TSV）+ 表格通道（xlsx/xls 等，calamine 解码）。
//!
//! 分工边界（docs/EXCEL_PARSING_EVALUATION.md）：Rust 只做「字节 → 二维字符串矩阵」
//! 的格式解码（含 Excel 日期序列等格式长尾），表头嗅探、姓名列识别等语义层全在前端
//! （src/lib/roster.ts）。与 photos.rs 读取用户挑选文件同一模式，
//! 不给前端开任意路径的文件读权限。
//!
//! 注意：两者都是前端管道的内部 IPC 命令，不是 Agent 能力面成员
//! （不 register_capability!，模型经 import_student_roster 工具间接使用）。

use std::{fs, path::PathBuf};
use calamine::Data;
use log::{error, info};

const VALID_EXTS: [&str; 3] = ["csv", "tsv", "txt"];
/// 表格通道支持的格式：open_workbook_auto 按扩展名/内容自动分发
const TABLE_EXTS: [&str; 5] = ["xlsx", "xlsm", "xlsb", "xls", "ods"];
/// 花名册是小文件，5MB 上限防御性拦截大文件塞进 IPC。
const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(serde::Serialize, Debug)]
pub struct RosterText {
  pub text: String,
  pub encoding: String,
}

/// 前端调用：读取用户选中的花名册文本文件（CSV/TSV/TXT）。
/// UTF-8 严格校验优先，失败回退 GBK（Excel 中文导出的常见编码）。
#[tauri::command]
pub fn roster_read_text(source: String) -> Result<RosterText, String> {
  let bytes = read_guarded(&source, &VALID_EXTS, "CSV/TSV/TXT（Excel 文件走表格解析通道）")?;
  let decoded = match std::str::from_utf8(&bytes) {
    Ok(text) => RosterText {
      text: text.trim_start_matches('\u{feff}').to_string(),
      encoding: "utf-8".into(),
    },
    Err(_) => {
      let (text, _encoding, had_errors) = encoding_rs::GBK.decode(&bytes);
      if had_errors {
        error!(target: "roster", "花名册解码失败：既不是 UTF-8 也不是 GBK（{}）", source);
        return Err("文件编码无法识别（仅支持 UTF-8 / GBK）".into());
      }
      RosterText {
        text: text.trim_start_matches('\u{feff}').to_string(),
        encoding: "gbk".into(),
      }
    }
  };
  info!(target: "roster", "已读取花名册 {source}（{}，{} 字节）", decoded.encoding, bytes.len());
  Ok(decoded)
}

/// 前端调用：把 Excel/ODS 表格的第一个非空工作表解码为二维字符串矩阵。
/// 日期单元格按样式识别并转 YYYY-MM-DD；数字保持整数形态（学号不能变浮点）。
#[tauri::command]
pub fn roster_read_table(source: String) -> Result<RosterGrid, String> {
  use calamine::{open_workbook_auto_from_rs, Data, Reader};

  let bytes = read_guarded(&source, &TABLE_EXTS, "XLSX/XLSM/XLSB/XLS/ODS（CSV/TSV 走文本通道）")?;
  let cursor = std::io::Cursor::new(bytes);
  let mut workbook = open_workbook_auto_from_rs(cursor).map_err(|e| {
    error!(target: "roster", "打开表格失败：{e}（源：{source}）");
    format!("无法打开表格文件：{e}")
  })?;

  // 取第一个有数据的工作表（≥2 行：表头/标题 + 数据）。说明页、只有一行
  // 标题的占位表不算数据；全库都没有 ≥2 行的表时退回第一个非空表，
  // 由前端报「没有可导入的数据行」。
  let mut fallback: Option<(String, calamine::Range<Data>)> = None;
  let mut picked: Option<(String, calamine::Range<Data>)> = None;
  for name in workbook.sheet_names().to_owned() {
    let range = workbook.worksheet_range(&name).map_err(|e| {
      error!(target: "roster", "读取工作表 {name} 失败：{e}（源：{source}）");
      format!("读取工作表 {name} 失败：{e}")
    })?;
    if range.height() == 0 {
      continue;
    }
    if range.height() >= 2 {
      picked = Some((name, range));
      break;
    }
    if fallback.is_none() {
      fallback = Some((name, range));
    }
  }
  let (sheet, range) = picked.or(fallback).ok_or_else(|| {
    error!(target: "roster", "表格没有可用工作表（源：{source}）");
    "表格里没有数据".to_string()
  })?;

  let rows = grid_from_range(&range);
  info!(target: "roster", "已读取表格 {source}（工作表 {sheet}，{} 行）", rows.len());
  Ok(RosterGrid { sheet, rows })
}

#[derive(serde::Serialize, Debug)]
pub struct RosterGrid {
  pub sheet: String,
  pub rows: Vec<Vec<String>>,
}

/// 读取前的公共守卫：扩展名白名单 + 文件存在 + 大小上限。
fn read_guarded(source: &str, exts: &[&str], supported: &str) -> Result<Vec<u8>, String> {
  let src = PathBuf::from(source);
  let ext = src
    .extension()
    .and_then(|e| e.to_str())
    .map(|s| s.to_ascii_lowercase())
    .unwrap_or_default();
  if !exts.contains(&ext.as_str()) {
    error!(target: "roster", "读取花名册被拒绝：不支持的格式 {ext}（源：{source}）");
    return Err(format!("不支持的花名册格式：{ext}（支持 {supported}）"));
  }
  if !src.is_file() {
    error!(target: "roster", "读取花名册被拒绝：文件不存在（{source}）");
    return Err("花名册文件不存在".into());
  }
  let metadata = fs::metadata(&src).map_err(|e| {
    error!(target: "roster", "读取花名册失败：无法获取文件信息 {e}（源：{source}）");
    format!("无法读取文件信息：{e}")
  })?;
  if metadata.len() > MAX_BYTES {
    error!(target: "roster", "读取花名册被拒绝：文件超过 5MB（{source}）");
    return Err("花名册文件过大（超过 5MB）".into());
  }
  fs::read(&src).map_err(|e| {
    error!(target: "roster", "读取花名册失败：{e}（源：{source}）");
    format!("读取花名册失败：{e}")
  })
}

/* ------------------------------------------------------------------ */
/* calamine 单元格 → 字符串                                             */
/* ------------------------------------------------------------------ */

fn grid_from_range(range: &calamine::Range<Data>) -> Vec<Vec<String>> {
  // 裁掉整列为空的尾部列，减小 IPC 载荷
  let mut width = 0usize;
  for row in range.rows() {
    for (i, cell) in row.iter().enumerate() {
      if !matches!(cell, Data::Empty) {
        width = width.max(i + 1);
      }
    }
  }

  range
    .rows()
    .filter(|row| row.iter().any(|cell| !matches!(cell, Data::Empty)))
    .map(|row| (0..width).map(|i| cell_to_string(&row[i])).collect())
    .collect()
}

fn cell_to_string(cell: &Data) -> String {
  match cell {
    Data::Empty => String::new(),
    Data::String(s) => s.clone(),
    Data::Int(i) => i.to_string(),
    // Excel 把整数存成浮点：学号 20240001 不能渲染成 20240001.0
    Data::Float(f) => float_to_string(*f),
    Data::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
    Data::DateTime(serial) => excel_serial_to_string(serial.as_f64()),
    Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    // 公式错误单元格（#DIV/0! 等）按空处理
    Data::Error(_) => String::new(),
  }
}

fn float_to_string(f: f64) -> String {
  if f.fract() == 0.0 && f.abs() < 9.0e15 {
    (f as i64).to_string()
  } else {
    format!("{f}")
  }
}

/// Excel 1900 日期系统序列号 → 「YYYY-MM-DD[ HH:MM:SS]」。
/// 序列 1 = 1900-01-01；60 是 Excel 虚构的 1900-02-29，映射到 1900-03-01。
/// 已知局限：1904 日期系统（老 Mac 工作簿）的偏移未处理，交由上层日期归一化兜底。
fn excel_serial_to_string(serial: f64) -> String {
  if !serial.is_finite() || serial < 1.0 {
    return String::new();
  }
  let days = serial.floor();
  let unix_days: i64 = if days <= 60.0 {
    // 序列 60（虚构的 1900-02-29）经此分支映射到 1900-03-01，与序列 61 重合
    days as i64 - 25568
  } else {
    days as i64 - 25569
  };
  let (year, month, day) = civil_from_days(unix_days);

  let fraction = serial - days;
  if fraction < 1e-9 {
    format!("{year:04}-{month:02}-{day:02}")
  } else {
    let secs = (fraction * 86_400.0).round() as i64;
    format!(
      "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
      secs / 3600,
      (secs % 3600) / 60,
      secs % 60
    )
  }
}

/// 天数（相对 1970-01-01，可为负）→ 公历年月日（Howard Hinnant 算法）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
  let z = days + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = (z - era * 146_097) as i64; // [0, 146096]
  let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
  let mp = (5 * doy + 2) / 153; // [0, 11]
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
  (y + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn excel_serial_converts_known_dates() {
    assert_eq!(excel_serial_to_string(1.0), "1900-01-01");
    assert_eq!(excel_serial_to_string(59.0), "1900-02-28");
    // 虚构的 1900-02-29（序列 60）与真实 61 都落在 1900-03-01
    assert_eq!(excel_serial_to_string(60.0), "1900-03-01");
    assert_eq!(excel_serial_to_string(61.0), "1900-03-01");
    // Unix 纪元锚点
    assert_eq!(excel_serial_to_string(25569.0), "1970-01-01");
    // 现代日期锚点
    assert_eq!(excel_serial_to_string(45658.0), "2025-01-01");
    assert_eq!(excel_serial_to_string(42867.0), "2017-05-12");
    // 带时间部分
    assert_eq!(excel_serial_to_string(25569.5), "1970-01-01 12:00:00");
    // 非法值
    assert_eq!(excel_serial_to_string(0.0), "");
    assert_eq!(excel_serial_to_string(f64::NAN), "");
  }

  #[test]
  fn floats_render_as_plain_numbers() {
    assert_eq!(float_to_string(20240001.0), "20240001");
    assert_eq!(float_to_string(13800128846.0), "13800128846");
    assert_eq!(float_to_string(3.14), "3.14");
    assert_eq!(cell_to_string(&Data::Float(20240001.0)), "20240001");
    assert_eq!(cell_to_string(&Data::Int(42)), "42");
    assert_eq!(cell_to_string(&Data::Bool(true)), "TRUE");
    assert_eq!(cell_to_string(&Data::Empty), "");
  }

  #[test]
  fn grid_trims_empty_columns_and_rows() {
    let cell = |r: u32, c: u32, v: Data| calamine::Cell::new((r, c), v);
    let range = calamine::Range::from_sparse(vec![
      cell(0, 0, Data::String("姓名".into())),
      cell(0, 1, Data::String("学号".into())),
      cell(0, 2, Data::Float(20240001.0)), // 第三列之后整列空
      cell(1, 0, Data::String("张三".into())),
    ]);
    let grid = grid_from_range(&range);
    assert_eq!(grid, vec![vec!["姓名", "学号", "20240001"], vec!["张三", "", ""]]);
  }

  /// 端到端：夹具由 scripts/gen-roster-xlsx-fixture.mjs 生成。首个工作表是只有
  /// 1 行标题的「说明」占位页（应被跳过），数据在第二个工作表「花名册」；
  /// 覆盖共享字符串 / inlineStr / 整数单元格 / 样式化日期四条解码路径。
  #[test]
  fn reads_sample_xlsx_end_to_end() {
    let path = concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/roster-sample.xlsx"
    );
    let grid = roster_read_table(path.to_string()).expect("读取 xlsx 夹具失败");
    assert_eq!(grid.sheet, "花名册");
    assert_eq!(
      grid.rows,
      vec![
        vec!["姓名", "学号", "出生日期", "监护人电话"],
        vec!["张三", "20240001", "2025-01-01", "13800128846"],
        vec!["李小红", "20240002", "2017-05-12", "13988772310"],
        vec!["王五", "", "", ""],
      ]
    );
  }

  #[test]
  fn rejects_unsupported_and_missing_files() {
    let err = roster_read_table("表格.docx".into()).unwrap_err();
    assert!(err.contains("不支持的花名册格式"));
    let err = roster_read_table("不存在的文件.xlsx".into()).unwrap_err();
    assert!(err.contains("不存在"));
  }
}
