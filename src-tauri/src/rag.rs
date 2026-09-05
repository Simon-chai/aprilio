//! 语义检索（RAG 第一阶段）：Ollama embedding + SQLite 向量存储。
//!
//! 选型说明（对 ROADMAP「LanceDB + Ollama embedding」的落地调整）：
//! LanceDB 0.38 会拖入 datafusion/arrow 全家桶（+150 crates、安装包 +25MB 级），
//! 与「安装包 ~10MB 量级」的约束冲突。MVP 数据量（百~千级档案/照片）下，
//! SQLite BLOB 存 L2 归一化向量 + Rust 暴力余弦完全够用（10k×768 查询 <1ms）；
//! `vector` 列的 BLOB 形状与 LanceDB 的向量列等价，数据量上来时只需换
//! 存储层实现，工具协议与索引流程不变。
//!
//! 隐私：embedding 文本默认只发往本机 Ollama（base_url 缺省 localhost）；
//! 把 base_url 指向远端等于把档案文本送出本机，调用方应明确知晓。
//!
//! embeddings 表由本模块管辖（幂等建表），不进 tauri-plugin-sql 的迁移序列——
//! 它是派生数据（可随时重建），与业务表的生命周期不同。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use crate::db;

/// 默认 embedding 模型：bge-m3（多语言，中文友好；Ollama `ollama pull bge-m3`）
pub const DEFAULT_EMBED_MODEL: &str = "bge-m3";
/// 默认 Ollama 服务地址
pub const DEFAULT_OLLAMA_URL: &str = "http://localhost:11434";
/// 每批送去做 embedding 的文本数
const EMBED_BATCH: usize = 16;

/* ------------------------------------------------------------------ */
/* 向量数学（纯函数，单测覆盖）                                          */
/* ------------------------------------------------------------------ */

/// f32 向量 → little-endian BLOB
fn vector_to_blob(v: &[f32]) -> Vec<u8> {
  v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// BLOB → f32 向量
fn blob_to_vector(bytes: &[u8]) -> Vec<f32> {
  bytes
    .chunks_exact(4)
    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
    .collect()
}

/// L2 归一化（原位）。零向量保持零向量。
fn normalize(v: &mut [f32]) {
  let norm = v.iter().map(|f| f * f).sum::<f32>().sqrt();
  if norm > f32::EPSILON {
    for f in v.iter_mut() {
      *f /= norm;
    }
  }
}

/// 点积。两向量都已归一化时等于余弦相似度。长度不一致返回 None。
fn dot(a: &[f32], b: &[f32]) -> Option<f32> {
  if a.len() != b.len() {
    return None;
  }
  Some(a.iter().zip(b.iter()).map(|(x, y)| x * y).sum())
}

/* ------------------------------------------------------------------ */
/* 索引素材                                                             */
/* ------------------------------------------------------------------ */

/// 一条待索引/已索引的内容
#[derive(Debug)]
struct IndexItem {
  source: &'static str, // "student" | "photo"
  source_id: i64,
  text: String,
}

/// 从业务表读索引素材（学生档案 + 照片说明）
async fn load_index_items(pool: &sqlx::SqlitePool) -> Result<Vec<IndexItem>, String> {
  let mut items = Vec::new();

  let students = sqlx::query(
    "SELECT id, name, gender, student_no, grade_class, note FROM students WHERE status = 'active'",
  )
  .fetch_all(pool)
  .await
  .map_err(|e| format!("读取学生失败：{e}"))?;
  for r in &students {
    let text = format!(
      "学生档案：姓名 {}；性别 {}；学号 {}；班级 {}；备注 {}",
      r.get::<String, _>("name"),
      r.get::<String, _>("gender"),
      db::opt_str(r, "student_no").unwrap_or_else(|| "无".into()),
      db::opt_str(r, "grade_class").unwrap_or_else(|| "未分班".into()),
      db::opt_str(r, "note").unwrap_or_else(|| "无".into()),
    );
    items.push(IndexItem { source: "student", source_id: r.get("id"), text });
  }

  let photos = sqlx::query(
    r#"
    SELECT p.id, p.file_name, p.caption, p.taken_at, s.name AS student_name
    FROM photos p JOIN students s ON s.id = p.student_id
    "#,
  )
  .fetch_all(pool)
  .await
  .map_err(|e| format!("读取照片失败：{e}"))?;
  for r in &photos {
    let text = format!(
      "照片记录：文件 {}；学生 {}；说明 {}；拍摄时间 {}",
      r.get::<String, _>("file_name"),
      r.get::<String, _>("student_name"),
      db::opt_str(r, "caption").unwrap_or_else(|| "无".into()),
      db::opt_str(r, "taken_at").unwrap_or_else(|| "未知".into()),
    );
    items.push(IndexItem { source: "photo", source_id: r.get("id"), text });
  }

  Ok(items)
}

/* ------------------------------------------------------------------ */
/* Ollama embedding                                                     */
/* ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct EmbedResponse {
  embeddings: Vec<Vec<f32>>,
}

/// 批量计算 embedding。失败时带上批次上下文便于定位。
async fn embed_texts(base_url: &str, model: &str, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
  if texts.is_empty() {
    return Ok(Vec::new());
  }
  let url = format!("{}/api/embed", base_url.trim_end_matches('/'));
  let client = reqwest::Client::new();
  let resp = client
    .post(&url)
    .json(&json!({ "model": model, "input": texts }))
    .send()
    .await
    .map_err(|e| format!("连接 Ollama 失败（{url}）：{e}。请确认已启动 ollama serve 并拉取模型。"))?;
  if !resp.status().is_success() {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let brief = body.lines().next().unwrap_or("").chars().take(200).collect::<String>();
    return Err(format!("Ollama embedding 请求失败（HTTP {status}）：{brief}"));
  }
  let parsed: EmbedResponse = resp.json().await.map_err(|e| format!("Ollama 响应解析失败：{e}"))?;
  if parsed.embeddings.len() != texts.len() {
    return Err(format!(
      "Ollama 返回 {} 条 embedding，与输入 {} 条不一致",
      parsed.embeddings.len(),
      texts.len()
    ));
  }
  Ok(parsed.embeddings)
}

/* ------------------------------------------------------------------ */
/* 重建索引                                                             */
/* ------------------------------------------------------------------ */

/// 幂等建表（本模块管辖，业务迁移序列之外）
async fn ensure_table(pool: &sqlx::SqlitePool) -> Result<(), String> {
  sqlx::query(
    r#"
    CREATE TABLE IF NOT EXISTS embeddings (
      source     TEXT NOT NULL,
      source_id  INTEGER NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vector     BLOB NOT NULL,
      text       TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (source, source_id, model)
    )
    "#,
  )
  .execute(pool)
  .await
  .map_err(|e| format!("创建 embeddings 表失败：{e}"))?;
  Ok(())
}

/// 重建索引入口：成败统一落日志（失败含耗时；条目数等细节由 inner 记录）。
pub async fn reindex_standalone(
  model: Option<String>,
  base_url: Option<String>,
) -> Result<Value, String> {
  let started = std::time::Instant::now();
  match reindex_inner(model, base_url).await {
    Ok(value) => {
      log::info!(
        target: "rag",
        "索引重建完成（耗时 {}ms）：indexed={} model={} dim={}",
        started.elapsed().as_millis(),
        value.get("indexed").and_then(Value::as_i64).unwrap_or(0),
        value.get("model").and_then(Value::as_str).unwrap_or("?"),
        value.get("dim").and_then(Value::as_i64).unwrap_or(0)
      );
      Ok(value)
    }
    Err(e) => {
      log::error!(target: "rag", "索引重建失败（耗时 {}ms）：{e}", started.elapsed().as_millis());
      Err(e)
    }
  }
}

async fn reindex_inner(model: Option<String>, base_url: Option<String>) -> Result<Value, String> {
  let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_EMBED_MODEL.into());
  let base = base_url.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_OLLAMA_URL.into());

  let pool = db::open_pool(false).await?;
  ensure_table(&pool).await?;

  let items = load_index_items(&pool).await?;
  log::info!(target: "rag", "索引重建开始：model={model} 条目={}", items.len());
  if items.is_empty() {
    sqlx::query("DELETE FROM embeddings WHERE model = ?")
      .bind(&model)
      .execute(&pool)
      .await
      .map_err(|e| format!("清空旧索引失败：{e}"))?;
    return Ok(json!({ "indexed": 0, "model": model, "dim": 0 }));
  }

  // 分批请求 embedding
  let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(items.len());
  for batch in items.chunks(EMBED_BATCH) {
    let texts: Vec<String> = batch.iter().map(|i| i.text.clone()).collect();
    let mut emb = embed_texts(&base, &model, &texts).await?;
    vectors.append(&mut emb);
  }
  let dim = vectors.first().map(|v| v.len()).unwrap_or(0);
  if dim == 0 {
    return Err("Ollama 返回了空向量，请检查 embedding 模型是否可用。".into());
  }
  for (v, item) in vectors.iter().zip(&items) {
    if v.len() != dim {
      return Err(format!(
        "embedding 维度不一致（{} vs {dim}），源：{}/{}",
        v.len(),
        item.source,
        item.source_id
      ));
    }
  }

  // 整体替换该模型的向量（事务：删旧 + 插新）
  let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败：{e}"))?;
  sqlx::query("DELETE FROM embeddings WHERE model = ?")
    .bind(&model)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("清空旧索引失败：{e}"))?;
  for (item, vector) in items.iter().zip(&vectors) {
    let mut normalized = vector.clone();
    normalize(&mut normalized);
    sqlx::query("INSERT OR REPLACE INTO embeddings (source, source_id, model, dim, vector, text) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(item.source)
      .bind(item.source_id)
      .bind(&model)
      .bind(dim as i64)
      .bind(vector_to_blob(&normalized))
      .bind(&item.text)
      .execute(&mut *tx)
      .await
      .map_err(|e| format!("写入向量失败（{}/{}）：{e}", item.source, item.source_id))?;
  }
  tx.commit().await.map_err(|e| format!("提交索引失败：{e}"))?;

  Ok(json!({ "indexed": items.len(), "model": model, "dim": dim }))
}

/* ------------------------------------------------------------------ */
/* 语义搜索                                                             */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
struct SearchHit {
  source: String,
  source_id: i64,
  score: f64,
  text: String,
  name: Option<String>,
  detail: Option<String>,
}

/// 语义搜索入口：失败统一 error! 落盘；成功（常规查询操作）记 debug 级。
/// 注意日志不记 query 全文（可能含学生姓名等隐私），只记字符数。
pub async fn semantic_search_standalone(
  query: String,
  top_k: Option<u32>,
  model: Option<String>,
  base_url: Option<String>,
) -> Result<Value, String> {
  let started = std::time::Instant::now();
  match semantic_search_inner(query, top_k, model, base_url).await {
    Ok(value) => {
      log::debug!(
        target: "rag",
        "语义搜索完成（耗时 {}ms）：query {} 字符 命中={} model={}",
        started.elapsed().as_millis(),
        value.get("query_len").and_then(Value::as_i64).unwrap_or(0),
        value.get("count").and_then(Value::as_i64).unwrap_or(0),
        value.get("model").and_then(Value::as_str).unwrap_or("?")
      );
      Ok(value)
    }
    Err(e) => {
      log::error!(target: "rag", "语义搜索失败（耗时 {}ms）：{e}", started.elapsed().as_millis());
      Err(e)
    }
  }
}

async fn semantic_search_inner(
  query: String,
  top_k: Option<u32>,
  model: Option<String>,
  base_url: Option<String>,
) -> Result<Value, String> {
  let query = query.trim().to_string();
  if query.is_empty() {
    return Err("查询内容为空。".into());
  }
  let model = model.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| DEFAULT_EMBED_MODEL.into());
  let base = base_url.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_OLLAMA_URL.into());
  let top_k = top_k.unwrap_or(5).clamp(1, 20) as usize;
  let query_len = query.chars().count();

  let pool = db::open_pool(true).await?;
  // 只读连接也能查表是否存在
  let exists: i64 = sqlx::query(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'",
  )
  .fetch_one(&pool)
  .await
  .map_err(|e| format!("检查索引表失败：{e}"))?
  .get("n");
  if exists == 0 {
    return Err("尚未建立语义索引，请先在应用内执行「重建语义索引」。".into());
  }

  // 查询向量（归一化）
  let mut qvec = embed_texts(&base, &model, &[query])
    .await?
    .into_iter()
    .next()
    .ok_or("Ollama 未返回查询向量")?;
  normalize(&mut qvec);

  // 库内向量（带可读信息的 LEFT JOIN）
  let rows = sqlx::query(
    r#"
    SELECT e.source, e.source_id, e.text, e.vector,
           s.name AS student_name, s.grade_class AS grade_class,
           p.file_name AS file_name, p.caption AS caption, ps.name AS photo_student
    FROM embeddings e
    LEFT JOIN students s ON e.source = 'student' AND s.id = e.source_id
    LEFT JOIN photos p   ON e.source = 'photo'   AND p.id = e.source_id
    LEFT JOIN students ps ON ps.id = p.student_id
    WHERE e.model = ?
    "#,
  )
  .bind(&model)
  .fetch_all(&pool)
  .await
  .map_err(|e| format!("读取向量失败：{e}"))?;

  let mut hits: Vec<SearchHit> = Vec::new();
  for r in &rows {
    let stored = blob_to_vector(&r.get::<Vec<u8>, _>("vector"));
    let Some(score) = dot(&qvec, &stored) else {
      continue; // 维度不符（换过模型未重建索引）的旧向量跳过
    };
    let source = r.get::<String, _>("source");
    let detail = match source.as_str() {
      "student" => db::opt_str(r, "grade_class"),
      "photo" => db::opt_str(r, "file_name"),
      _ => None,
    };
    hits.push(SearchHit {
      source,
      source_id: r.get("source_id"),
      score: (score as f64 * 10000.0).round() / 10000.0,
      text: r.get("text"),
      name: db::opt_str(r, "student_name").or_else(|| db::opt_str(r, "photo_student")),
      detail,
    });
  }
  hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
  hits.truncate(top_k);

  Ok(json!({ "count": hits.len(), "model": model, "query_len": query_len, "results": hits }))
}

/* ------------------------------------------------------------------ */
/* Tauri 命令 + 能力注册                                                */
/* ------------------------------------------------------------------ */

/// 前端调用：重建语义索引。参数均为可选（缺省 bge-m3 + 本机 Ollama）。
#[tauri::command]
pub async fn rag_reindex(model: Option<String>, base_url: Option<String>) -> Result<Value, String> {
  reindex_standalone(model, base_url).await
}

/// 前端调用：语义搜索。
#[tauri::command]
pub async fn semantic_search(
  query: String,
  top_k: Option<u32>,
  model: Option<String>,
  base_url: Option<String>,
) -> Result<Value, String> {
  semantic_search_standalone(query, top_k, model, base_url).await
}

// 两项均为只读/派生数据操作，不走确认门（dangerous=false）。
// schema 参数名与命令参数一致（桥接层直接透传，见 capabilities.rs 约定）。
crate::register_capability! {
  name: "semantic_search",
  label: "语义搜索",
  description: "对学生档案与照片说明做语义检索，适合模糊、口语化的查找（如「之前记过爱踢球的孩子们」）。需要先重建过索引。",
  command: "semantic_search",
  dangerous: false,
  parameters: r#"{
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "自然语言查询" },
      "top_k": { "type": "integer", "description": "返回条数，默认 5" },
      "model": { "type": "string", "description": "embedding 模型，默认 bge-m3" }
    },
    "required": ["query"]
  }"#
}

crate::register_capability! {
  name: "rag_reindex",
  label: "重建语义索引",
  description: "为全部在读学生档案与照片说明重建语义索引（embedding 只发往本机 Ollama）。",
  command: "rag_reindex",
  dangerous: false,
  parameters: r#"{
    "type": "object",
    "properties": {
      "model": { "type": "string", "description": "embedding 模型，默认 bge-m3" }
    },
    "required": []
  }"#
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn blob_roundtrip_preserves_values() {
    let v = vec![0.25_f32, -1.5, 3.0, 0.0, f32::MIN];
    let bytes = vector_to_blob(&v);
    assert_eq!(bytes.len(), v.len() * 4);
    assert_eq!(blob_to_vector(&bytes), v);
  }

  #[test]
  fn blob_trailing_bytes_are_ignored() {
    let v = vec![1.0_f32];
    let mut bytes = vector_to_blob(&v);
    bytes.push(0xFF); // 截断/损坏的尾部不影响整向量解析
    assert_eq!(blob_to_vector(&bytes), vec![1.0_f32]);
  }

  #[test]
  fn normalize_makes_unit_vector() {
    let mut v = vec![3.0_f32, 4.0];
    normalize(&mut v);
    let norm = v.iter().map(|f| f * f).sum::<f32>().sqrt();
    assert!((norm - 1.0).abs() < 1e-6);
  }

  #[test]
  fn normalize_zero_vector_is_safe() {
    let mut v = vec![0.0_f32; 4];
    normalize(&mut v);
    assert!(v.iter().all(|f| f == &0.0));
  }

  #[test]
  fn dot_is_cosine_for_normalized_vectors() {
    let mut a = vec![1.0_f32, 0.0];
    let mut b = vec![1.0_f32, 1.0];
    normalize(&mut a);
    normalize(&mut b);
    let cos45 = dot(&a, &b).expect("同维度应有值");
    assert!((cos45 - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    assert!(dot(&a, &[1.0, 2.0, 3.0]).is_none()); // 维度不符
  }

  #[test]
  fn cosine_ranks_identical_direction_highest() {
    let mut query = vec![1.0_f32, 2.0, 2.0];
    normalize(&mut query);
    let mut same = query.clone();
    let mut other = vec![2.0_f32, 1.0, 1.0];
    normalize(&mut other);
    normalize(&mut same);
    let s_same = dot(&query, &same).expect("应有值");
    let s_other = dot(&query, &other).expect("应有值");
    assert!(s_same > s_other);
  }
}
