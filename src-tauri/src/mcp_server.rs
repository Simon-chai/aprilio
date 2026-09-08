//! 应用内 MCP server —— `aprilio mcp serve`（stdio 传输，不开端口）。
//!
//! 外部 Agent 客户端（Goose、Claude Desktop 等）把本应用当作 MCP server 接入，
//! 即可用指令操作应用数据——这是「用指令完成操作」的外部轨道
//! （docs/AGENT_FRAMEWORK_EVALUATION.md §3）。
//!
//! 工具面（首批只读，与 TS 能力容器同源但不共享执行体）：
//! - `photos_dir`：照片目录路径（与 inventory 能力 photos_dir 同义，独立进程内直接解析）；
//! - `list_students` / `get_stats` / `list_photos`：只读 SQL 查询（脱敏投影——
//!   不返回监护人电话、住址、生日等敏感字段；完整读取留在 GUI 内）；
//! - `list_exams` / `get_exam_scores`：考试成绩只读查询（考试批次 + 成绩明细）；
//! - `semantic_search`：P4 的语义检索（inventory 注册，读写两轨共用）。
//!
//! 写操作刻意不暴露：按方案要求需先落地「数据脱敏开关 + GUI 内审批」双前置。
//!
//! stdout 只跑 MCP 协议，任何日志走 stderr。

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::model::{
  CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorCode, Implementation,
  JsonObject, ListToolsResult, ServerInfo, TextContent, Tool, ToolAnnotations, ToolsCapability,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use sqlx::Row;

use crate::db;

/// 本 server 暴露的工具名（对账 inventory，防止新增能力遗漏）
const MCP_TOOL_NAMES: &[&str] = &[
  "photos_dir",
  "list_students",
  "get_stats",
  "list_photos",
  "list_exams",
  "get_exam_scores",
  "semantic_search",
];

pub struct AprilioMcpServer;

impl AprilioMcpServer {
  pub fn new() -> Self {
    Self
  }

  fn tool_list() -> Vec<Tool> {
    let schema = |v: Value| Arc::new(v.as_object().cloned().unwrap_or_default());
    // rmcp 模型类型均为 #[non_exhaustive]：只能 ::default() 后按字段赋值
    let tool = |name: &'static str, title: &str, description: &str, input_schema: Value| {
      let mut t = Tool::default();
      t.name = Cow::Borrowed(name);
      t.title = Some(title.to_string());
      t.description = Some(Cow::Owned(description.to_string()));
      t.input_schema = schema(input_schema);
      t.annotations = Some(read_only());
      t
    };
    vec![
      tool(
        "photos_dir",
        "照片目录",
        "获取 aprilio 照片在本机的存储目录路径。",
        json!({ "type": "object", "properties": {}, "required": [] }),
      ),
      tool(
        "list_students",
        "学生名单查询",
        "查询在读学生（脱敏投影：姓名/性别/班级/学籍状态/备注，不含联系方式与住址）。支持关键词与班级过滤。",
        json!({
          "type": "object",
          "properties": {
            "keyword": { "type": "string", "description": "按姓名/学号/备注模糊匹配，缺省查全部" },
            "grade_class": { "type": "string", "description": "按班级过滤，如「三年二班」" },
            "limit": { "type": "integer", "description": "返回条数上限，默认 20，最大 100" }
          },
          "required": []
        }),
      ),
      tool(
        "get_stats",
        "数据统计",
        "在读学生总数、班级分布、照片总数等汇总统计。",
        json!({ "type": "object", "properties": {}, "required": [] }),
      ),
      tool(
        "list_photos",
        "照片列表",
        "按学生查询照片记录（文件名/说明/拍摄时间）。student_id 缺省时返回最近 50 条。",
        json!({
          "type": "object",
          "properties": {
            "student_id": { "type": "integer", "description": "学生 ID（list_students 返回的 id）" }
          },
          "required": []
        }),
      ),
      tool(
        "list_exams",
        "考试批次查询",
        "查询考试批次（班级/考试名/考试时间 + 科目数/成绩数/学生数）。支持班级与考试名过滤。",
        json!({
          "type": "object",
          "properties": {
            "class_name": { "type": "string", "description": "按班级过滤，如「四年级一班」" },
            "keyword": { "type": "string", "description": "按考试名/班级模糊匹配" },
            "limit": { "type": "integer", "description": "返回条数上限，默认 20，最大 100" }
          },
          "required": []
        }),
      ),
      tool(
        "get_exam_scores",
        "成绩明细查询",
        "查询成绩明细（学生/科目/分数或等级，联考试与班级）。可用考试 ID、学生 ID、科目、班级过滤。",
        json!({
          "type": "object",
          "properties": {
            "exam_id": { "type": "integer", "description": "考试批次 ID（list_exams 返回的 id）" },
            "student_id": { "type": "integer", "description": "学生 ID（list_students 返回的 id）" },
            "subject": { "type": "string", "description": "科目，如「语文」" },
            "class_name": { "type": "string", "description": "按班级过滤" },
            "limit": { "type": "integer", "description": "返回条数上限，默认 200，最大 500" }
          },
          "required": []
        }),
      ),
      tool(
        "semantic_search",
        "语义搜索",
        "对学生档案与照片说明做语义检索（Ollama embedding）。适合模糊/口语化查找；需要先在应用内重建过索引。",
        json!({
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "自然语言查询" },
            "top_k": { "type": "integer", "description": "返回条数，默认 5" },
            "model": { "type": "string", "description": "embedding 模型，默认 bge-m3（须与建索引时一致）" }
          },
          "required": ["query"]
        }),
      ),
    ]
  }

  /// 工具名 → 执行体。返回 Ok(Value)（成功）或 Err(String)（工具级错误，is_error=true 回传）。
  async fn execute(&self, name: &str, args: &JsonObject) -> Result<Value, String> {
    match name {
      "photos_dir" => {
        let dir = crate::paths::photos_dir()?;
        Ok(json!({ "path": dir.to_string_lossy().replace('\\', "/") }))
      }
      "list_students" => {
        let keyword = str_arg(args, "keyword");
        let grade_class = str_arg(args, "grade_class");
        let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 100);
        list_students_standalone(keyword, grade_class, limit).await
      }
      "get_stats" => get_stats_standalone().await,
      "list_photos" => {
        let student_id = int_arg(args, "student_id");
        list_photos_standalone(student_id, 50).await
      }
      "list_exams" => {
        let class_name = str_arg(args, "class_name");
        let keyword = str_arg(args, "keyword");
        let limit = int_arg(args, "limit").unwrap_or(20).clamp(1, 100);
        list_exams_standalone(class_name, keyword, limit).await
      }
      "get_exam_scores" => {
        let exam_id = int_arg(args, "exam_id");
        let student_id = int_arg(args, "student_id");
        let subject = str_arg(args, "subject");
        let class_name = str_arg(args, "class_name");
        let limit = int_arg(args, "limit").unwrap_or(200).clamp(1, 500);
        get_exam_scores_standalone(exam_id, student_id, subject, class_name, limit).await
      }
      "semantic_search" => {
        let query = str_arg(args, "query").ok_or("缺少参数 query")?;
        let top_k = int_arg(args, "top_k").unwrap_or(5).clamp(1, 20);
        let model = str_arg(args, "model");
        crate::rag::semantic_search_standalone(query, Some(top_k as u32), model, None).await
      }
      _ => unreachable!("call_tool 已过滤未知工具"),
    }
  }
}

impl Default for AprilioMcpServer {
  fn default() -> Self {
    Self::new()
  }
}

impl ServerHandler for AprilioMcpServer {
  fn get_info(&self) -> ServerInfo {
    let mut implementation = Implementation::default();
    implementation.name = "aprilio".into();
    implementation.title = Some("aprilio 学生档案".into());
    implementation.version = env!("CARGO_PKG_VERSION").into();
    implementation.description = Some("本地优先的学生信息与照片记录应用（只读 MCP 工具面）。".into());

    let mut info = ServerInfo::default();
    info.capabilities.tools = Some(ToolsCapability::default());
    info.server_info = implementation;
    info.instructions = Some(
      "只读工具面：先 list_students/get_stats 了解数据，再用 list_photos/list_exams/get_exam_scores/semantic_search 深入。写操作请到应用 GUI.".into(),
    );
    info
  }

  async fn list_tools(
    &self,
    _request: Option<rmcp::model::PaginatedRequestParams>,
    _context: RequestContext<RoleServer>,
  ) -> Result<ListToolsResult, McpError> {
    let mut result = ListToolsResult::default();
    result.tools = Self::tool_list();
    Ok(result)
  }

  async fn call_tool(
    &self,
    request: CallToolRequestParams,
    _context: RequestContext<RoleServer>,
  ) -> Result<CallToolResponse, McpError> {
    let name = request.name.as_ref().to_string();
    if !MCP_TOOL_NAMES.contains(&name.as_str()) {
      // 未知工具按协议错误返回（MCP 规范建议），客户端可见 METHOD_NOT_FOUND
      return Err(McpError::new(
        ErrorCode::METHOD_NOT_FOUND,
        format!("未知工具：{name}"),
        None,
      ));
    }
    let args = request.arguments.clone().unwrap_or_default();
    // MCP 模式没有 plugin-log 接收端（log:: 宏空转），诊断统一走 stderr（客户端可见）。
    // 只记工具名/成败/耗时，不记参数全文——避免学生隐私进入客户端日志。
    let started = std::time::Instant::now();
    match self.execute(&name, &args).await {
      Ok(value) => {
        eprintln!(
          "[aprilio-mcp] 工具完成 {name}（耗时 {}ms）",
          started.elapsed().as_millis()
        );
        let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into());
        let mut result = CallToolResult::success(vec![ContentBlock::Text(TextContent::new(text))]);
        result.structured_content = Some(value);
        Ok(result.into())
      }
      Err(message) => {
        eprintln!(
          "[aprilio-mcp] 工具失败 {name}（耗时 {}ms）：{message}",
          started.elapsed().as_millis()
        );
        Ok(CallToolResult::error(vec![ContentBlock::Text(TextContent::new(message))]).into())
      }
    }
  }
}

/// 工具标注：全部只读、非破坏
fn read_only() -> ToolAnnotations {
  let mut annotations = ToolAnnotations::default();
  annotations.read_only_hint = Some(true);
  annotations.destructive_hint = Some(false);
  annotations
}

/* ------------------------------------------------------------------ */
/* 参数提取                                                             */
/* ------------------------------------------------------------------ */

fn str_arg(args: &JsonObject, key: &str) -> Option<String> {
  args.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

fn int_arg(args: &JsonObject, key: &str) -> Option<i64> {
  args.get(key).and_then(Value::as_i64)
}

/* ------------------------------------------------------------------ */
/* 只读查询（独立实现，供 MCP 进程使用；与 TS 侧 query_data 的投影口径一致） */
/* ------------------------------------------------------------------ */

pub(crate) async fn list_students_standalone(
  keyword: Option<String>,
  grade_class: Option<String>,
  limit: i64,
) -> Result<Value, String> {
  let pool = db::open_pool(true).await?;
  // 空参数用「%」全匹配占位，避免拼动态 SQL
  let kw = format!("%{}%", keyword.unwrap_or_default().trim());
  let class = format!("%{}%", grade_class.unwrap_or_default().trim());
  let rows = sqlx::query(
    r#"
    SELECT id, name, gender, grade_class, student_no, status, note, created_at
    FROM students
    WHERE status = 'active'
      AND (name LIKE ?1 OR student_no LIKE ?1 OR note LIKE ?1)
      AND (grade_class LIKE ?2)
    ORDER BY id DESC
    LIMIT ?3
    "#,
  )
  .bind(&kw)
  .bind(&class)
  .bind(limit)
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("查询学生失败：{e}"))?;

  let students: Vec<Value> = rows
    .iter()
    .map(|r| {
      json!({
        "id": r.get::<i64, _>("id"),
        "name": r.get::<String, _>("name"),
        "gender": r.get::<String, _>("gender"),
        "grade_class": db::opt_str(r, "grade_class"),
        "student_no": db::opt_str(r, "student_no"),
        "status": r.get::<String, _>("status"),
        "note": db::opt_str(r, "note"),
        "created_at": r.get::<String, _>("created_at"),
      })
    })
    .collect();
  Ok(json!({ "count": students.len(), "students": students }))
}

pub(crate) async fn get_stats_standalone() -> Result<Value, String> {
  let pool = db::open_pool(true).await?;

  let total: i64 = sqlx::query("SELECT COUNT(*) AS n FROM students WHERE status = 'active'")
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("统计学生失败：{e}"))?
    .get("n");

  let class_rows = sqlx::query(
    "SELECT grade_class, COUNT(*) AS n FROM students WHERE status = 'active' GROUP BY grade_class ORDER BY n DESC",
  )
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("统计班级失败：{e}"))?;

  let photos: i64 = sqlx::query("SELECT COUNT(*) AS n FROM photos")
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("统计照片失败：{e}"))?
    .get("n");

  let by_class: Vec<Value> = class_rows
    .iter()
    .map(|r| {
      json!({
        "grade_class": db::opt_str(r, "grade_class").unwrap_or_else(|| "未分班".into()),
        "count": r.get::<i64, _>("n"),
      })
    })
    .collect();

  Ok(json!({ "active_students": total, "students_by_class": by_class, "photos": photos }))
}

pub(crate) async fn list_photos_standalone(student_id: Option<i64>, limit: i64) -> Result<Value, String> {
  let pool = db::open_pool(true).await?;
  let rows = sqlx::query(
    r#"
    SELECT p.id, p.student_id, s.name AS student_name, p.file_name, p.caption, p.taken_at, p.created_at
    FROM photos p
    JOIN students s ON s.id = p.student_id
    WHERE (?1 IS NULL OR p.student_id = ?1)
    ORDER BY p.id DESC
    LIMIT ?2
    "#,
  )
  .bind(student_id)
  .bind(limit)
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("查询照片失败：{e}"))?;

  let photos: Vec<Value> = rows
    .iter()
    .map(|r| {
      json!({
        "id": r.get::<i64, _>("id"),
        "student_id": r.get::<i64, _>("student_id"),
        "student_name": r.get::<String, _>("student_name"),
        "file_name": r.get::<String, _>("file_name"),
        "caption": db::opt_str(r, "caption"),
        "taken_at": db::opt_str(r, "taken_at"),
        "created_at": r.get::<String, _>("created_at"),
      })
    })
    .collect();
  Ok(json!({ "count": photos.len(), "photos": photos }))
}

/// 考试批次列表（含成绩统计），支持班级与考试名/班级关键词过滤
pub(crate) async fn list_exams_standalone(
  class_name: Option<String>,
  keyword: Option<String>,
  limit: i64,
) -> Result<Value, String> {
  let pool = db::open_pool(true).await?;
  let class = class_name.unwrap_or_default();
  let kw = keyword.unwrap_or_default();
  let rows = sqlx::query(
    r#"
    SELECT e.id, e.class_name, e.name, e.exam_date,
           (SELECT COUNT(DISTINCT subject)    FROM exam_scores sc WHERE sc.exam_id = e.id) AS subject_count,
           (SELECT COUNT(*)                   FROM exam_scores sc WHERE sc.exam_id = e.id) AS score_count,
           (SELECT COUNT(DISTINCT student_id) FROM exam_scores sc WHERE sc.exam_id = e.id) AS student_count
    FROM exams e
    WHERE (?1 = '' OR e.class_name = ?1)
      AND (?2 = '' OR e.name LIKE '%' || ?2 || '%' OR e.class_name LIKE '%' || ?2 || '%')
    ORDER BY e.exam_date DESC, e.id DESC
    LIMIT ?3
    "#,
  )
  .bind(&class)
  .bind(&kw)
  .bind(limit)
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("查询考试批次失败：{e}"))?;

  let exams: Vec<Value> = rows
    .iter()
    .map(|r| {
      json!({
        "id": r.get::<i64, _>("id"),
        "class_name": r.get::<String, _>("class_name"),
        "name": r.get::<String, _>("name"),
        "exam_date": r.get::<String, _>("exam_date"),
        "subject_count": r.get::<i64, _>("subject_count"),
        "score_count": r.get::<i64, _>("score_count"),
        "student_count": r.get::<i64, _>("student_count"),
      })
    })
    .collect();
  Ok(json!({ "count": exams.len(), "exams": exams }))
}

/// 成绩明细（联考试与学生），可按考试/学生/科目/班级过滤
pub(crate) async fn get_exam_scores_standalone(
  exam_id: Option<i64>,
  student_id: Option<i64>,
  subject: Option<String>,
  class_name: Option<String>,
  limit: i64,
) -> Result<Value, String> {
  let pool = db::open_pool(true).await?;
  let subject = subject.unwrap_or_default();
  let class = class_name.unwrap_or_default();
  let rows = sqlx::query(
    r#"
    SELECT sc.id, sc.exam_id, e.name AS exam_name, e.exam_date, e.class_name,
           sc.student_id, s.name AS student_name, s.student_no,
           sc.subject, sc.score, sc.grade
    FROM exam_scores sc
    JOIN exams e ON e.id = sc.exam_id
    JOIN students s ON s.id = sc.student_id
    WHERE (?1 IS NULL OR sc.exam_id = ?1)
      AND (?2 IS NULL OR sc.student_id = ?2)
      AND (?3 = '' OR sc.subject = ?3)
      AND (?4 = '' OR e.class_name = ?4)
    ORDER BY sc.exam_id DESC, s.name ASC, sc.id ASC
    LIMIT ?5
    "#,
  )
  .bind(exam_id)
  .bind(student_id)
  .bind(&subject)
  .bind(&class)
  .bind(limit)
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("查询成绩失败：{e}"))?;

  let scores: Vec<Value> = rows
    .iter()
    .map(|r| {
      json!({
        "id": r.get::<i64, _>("id"),
        "exam_id": r.get::<i64, _>("exam_id"),
        "exam_name": r.get::<String, _>("exam_name"),
        "exam_date": r.get::<String, _>("exam_date"),
        "class_name": r.get::<String, _>("class_name"),
        "student_id": r.get::<i64, _>("student_id"),
        "student_name": r.get::<String, _>("student_name"),
        "student_no": db::opt_str(r, "student_no"),
        "subject": r.get::<String, _>("subject"),
        "score": r.try_get::<Option<f64>, _>("score").unwrap_or(None),
        "grade": db::opt_str(r, "grade"),
      })
    })
    .collect();
  Ok(json!({ "count": scores.len(), "scores": scores }))
}

/* ------------------------------------------------------------------ */
/* 进程入口                                                             */
/* ------------------------------------------------------------------ */

/// 与 inventory 对账：只读能力若未在 MCP 暴露，启动时提示（stderr）
fn audit_capabilities() {
  for cap in inventory::iter::<crate::capabilities::RustCapability>() {
    if !cap.dangerous && !MCP_TOOL_NAMES.contains(&cap.name) {
      eprintln!(
        "[aprilio-mcp] 提示：Rust 只读能力「{}」未在 MCP server 暴露（如需开放请在 mcp_server.rs 增加执行体）",
        cap.name
      );
    }
  }
}

/// MCP 模式进程入口：占用 stdio 直到客户端断开。返回进程退出码。
pub fn run_blocking() -> i32 {
  audit_capabilities();
  let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
    Ok(rt) => rt,
    Err(e) => {
      eprintln!("[aprilio-mcp] 运行时启动失败：{e}");
      return 1;
    }
  };
  match rt.block_on(serve_stdio()) {
    Ok(()) => {
      eprintln!("[aprilio-mcp] 会话结束");
      0
    }
    Err(e) => {
      eprintln!("[aprilio-mcp] {e}");
      1
    }
  }
}

async fn serve_stdio() -> Result<(), String> {
  let server = AprilioMcpServer::new();
  let running = server
    .serve(rmcp::transport::io::stdio())
    .await
    .map_err(|e| format!("MCP 服务启动失败：{e}"))?;
  running
    .waiting()
    .await
    .map_err(|e| format!("MCP 服务异常退出：{e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn tool_list_covers_audit_names() {
    let tools = AprilioMcpServer::tool_list();
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    assert_eq!(names, MCP_TOOL_NAMES.to_vec());
    for t in &tools {
      // 全部只读标注 + schema 是合法 object
      let ann = t.annotations.as_ref().expect("应带 annotations");
      assert_eq!(ann.read_only_hint, Some(true));
      assert_eq!(t.input_schema.get("type").and_then(Value::as_str), Some("object"));
      assert!(t.description.is_some());
    }
  }

  #[test]
  fn extracts_string_and_int_args() {
    let args: JsonObject = serde_json::from_value(json!({ "keyword": " 林 ", "limit": 30, "empty": "" }))
      .expect("反序列化应成功");
    assert_eq!(str_arg(&args, "keyword"), Some(" 林 ".into()));
    assert_eq!(str_arg(&args, "empty"), None); // 空串视为缺省
    assert_eq!(str_arg(&args, "missing"), None);
    assert_eq!(int_arg(&args, "limit"), Some(30));
    assert_eq!(int_arg(&args, "keyword"), None); // 类型不符视为缺省
  }

  #[test]
  fn unknown_tool_names_are_rejected_by_whitelist() {
    // call_tool 的白名单判断与 tool_list 同源，这里验证对账表覆盖
    assert!(MCP_TOOL_NAMES.contains(&"list_students"));
    assert!(MCP_TOOL_NAMES.contains(&"list_exams"));
    assert!(MCP_TOOL_NAMES.contains(&"get_exam_scores"));
    assert!(!MCP_TOOL_NAMES.contains(&"import_photo")); // 写操作永不暴露
    assert!(!MCP_TOOL_NAMES.contains(&"delete_photo_file"));
  }
}
