//! Rust 执行面能力注册 —— `inventory` 散装注册（对应 Spring 的组件扫描）。
//!
//! 新增 Rust 能力 = 新增一个 `register_capability!` 调用（通常写在实现该命令的
//! 模块里，随模块就地声明），链接期自动收集，无需改动本文件以外的注册代码。
//!
//! 启动时：
//! 1. `agent_capabilities` 命令把清单上报给前端 TS 容器（manifest.ts 合并）；
//! 2. `log_inventory` 与 invoke_handler 对账（声明了能力但没注册命令 → 启动即报错，
//!    防止「工具存在但不可达」的漂移）。
//!
//! 工具参数 schema 的字段名必须与 Tauri 命令的参数名一致（桥接层直接透传）。

use serde::Serialize;
use serde_json::Value;

/// 单条 Rust 能力（inventory 收集单元）。
///
/// `parameters` 存 JSON Schema 的**字符串字面量**：inventory 的收集单元是 static，
/// `serde_json::json!` 非常量无法在 static 求值，上报时（`agent_capabilities`）再解析。
pub struct RustCapability {
  pub name: &'static str,
  pub label: &'static str,
  pub description: &'static str,
  pub parameters: &'static str,
  pub command: &'static str,
  /// 写操作标记：true 时前端走确认门（与 TS 容器的 dangerous 对齐）
  pub dangerous: bool,
}

inventory::collect!(RustCapability);

/// 声明一条 Rust 能力。parameters 传 JSON Schema 的 raw 字符串（r#"…"#）。
#[macro_export]
macro_rules! register_capability {
  (
    name: $name:expr,
    label: $label:expr,
    description: $desc:expr,
    command: $command:expr,
    dangerous: $dangerous:expr,
    parameters: $params:expr $(,)?
  ) => {
    inventory::submit! {
      $crate::capabilities::RustCapability {
        name: $name,
        label: $label,
        description: $desc,
        parameters: $params,
        command: $command,
        dangerous: $dangerous,
      }
    }
  };
}

/// 上报给前端的描述（与 src/agent/types.ts 的 RustCapabilityReport 对齐）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustCapabilityReport {
  pub name: String,
  pub label: String,
  pub description: String,
  pub parameters: Value,
  pub command: String,
  pub tags: Vec<String>,
}

impl From<&RustCapability> for RustCapabilityReport {
  fn from(c: &RustCapability) -> Self {
    let parameters = serde_json::from_str(c.parameters).unwrap_or_else(|e| {
      log::error!(
        target: "capabilities",
        "能力 {} 的 parameters 不是合法 JSON Schema：{e}",
        c.name
      );
      Value::Object(Default::default())
    });
    Self {
      name: c.name.to_string(),
      label: c.label.to_string(),
      description: c.description.to_string(),
      parameters,
      command: c.command.to_string(),
      tags: if c.dangerous {
        vec!["rust".into(), "write".into()]
      } else {
        vec!["rust".into()]
      },
    }
  }
}

/// 前端命令：上报全部 Rust 执行面能力。
#[tauri::command]
pub fn agent_capabilities() -> Vec<RustCapabilityReport> {
  inventory::iter::<RustCapability>()
    .into_iter()
    .map(Into::into)
    .collect()
}

/// 与 invoke_handler 对账：这里列出的命令 = lib.rs `generate_handler!` 的白名单。
/// 新注册能力时若忘了在 generate_handler 里挂命令，启动即报错。
const KNOWN_COMMANDS: &[&str] = &[
  "ai_chat",
  "photos_dir",
  "import_photo",
  "delete_photo_file",
  "agent_capabilities",
  "rag_reindex",
  "semantic_search",
];

/// 启动时对账 + 打点（lib.rs setup 调用）。
pub fn log_inventory() {
  let caps: Vec<&RustCapability> = inventory::iter::<RustCapability>().collect();
  for c in &caps {
    if !KNOWN_COMMANDS.contains(&c.command) {
      log::error!(
        target: "capabilities",
        "能力 {} 声明的命令 {} 不在 invoke_handler 白名单中，工具将不可达",
        c.name, c.command
      );
    }
  }
  let names: Vec<&str> = caps.iter().map(|c| c.name).collect();
  log::info!(target: "capabilities", "Rust 执行面能力已装载：{} 项 [{}]", caps.len(), names.join("、"));
}

/* ------------------------------------------------------------------ */
/* 首批注册：photos 命令（photos.rs 的三个命令）                          */
/* ------------------------------------------------------------------ */

register_capability! {
  name: "photos_dir",
  label: "照片目录",
  description: "获取照片在本机的存储目录路径。",
  command: "photos_dir",
  dangerous: false,
  parameters: r#"{ "type": "object", "properties": {}, "required": [] }"#
}

register_capability! {
  name: "import_photo",
  label: "导入照片文件",
  description: "把指定路径的图片文件复制进照片目录，返回落盘后的文件名。支持 png/jpg/jpeg/webp/gif/bmp。",
  command: "import_photo",
  dangerous: true,
  parameters: r#"{
    "type": "object",
    "properties": {
      "source": { "type": "string", "description": "源图片文件的完整路径" },
      "confirm": { "type": "boolean", "description": "写操作确认标记：用户明确同意后传 true" }
    },
    "required": ["source"]
  }"#
}

register_capability! {
  name: "delete_photo_file",
  label: "删除照片文件",
  description: "从照片目录删除指定文件名的图片文件（只删文件，不动数据库记录）。",
  command: "delete_photo_file",
  dangerous: true,
  parameters: r#"{
    "type": "object",
    "properties": {
      "file_name": { "type": "string", "description": "照片目录内的文件名（不含路径）" },
      "confirm": { "type": "boolean", "description": "写操作确认标记：用户明确同意后传 true" }
    },
    "required": ["file_name"]
  }"#
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn collects_registered_capabilities() {
    let caps: Vec<&RustCapability> = inventory::iter::<RustCapability>().collect();
    let names: Vec<&str> = caps.iter().map(|c| c.name).collect();
    assert!(names.contains(&"photos_dir"));
    assert!(names.contains(&"import_photo"));
    assert!(names.contains(&"delete_photo_file"));
  }

  #[test]
  fn all_declared_commands_are_in_the_whitelist() {
    for c in inventory::iter::<RustCapability>() {
      assert!(
        KNOWN_COMMANDS.contains(&c.command),
        "能力 {} 的命令 {} 未列入 KNOWN_COMMANDS",
        c.name,
        c.command
      );
    }
  }

  #[test]
  fn reports_carry_rust_tag_and_dangerous_flag() {
    let reports: Vec<RustCapabilityReport> = inventory::iter::<RustCapability>()
      .into_iter()
      .map(Into::into)
      .collect();
    let dir = reports.iter().find(|r| r.name == "photos_dir").expect("photos_dir");
    assert_eq!(dir.tags, vec!["rust"]);
    let import = reports.iter().find(|r| r.name == "import_photo").expect("import_photo");
    assert!(import.tags.contains(&"write".to_string()));
  }

  /// parameters 字符串必须都是合法 JSON（写错 schema 会在上报时才暴露，测试期拦住）
  #[test]
  fn all_parameter_schemas_are_valid_json() {
    for c in inventory::iter::<RustCapability>() {
      let parsed: Result<Value, _> = serde_json::from_str(c.parameters);
      assert!(parsed.is_ok(), "能力 {} 的 parameters 不是合法 JSON", c.name);
    }
  }
}
