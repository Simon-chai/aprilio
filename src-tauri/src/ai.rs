//! AI 基础能力：基于 genai 的多供应商 LLM 聊天接入。
//!
//! 供应商 / 模型 / 密钥由前端设置页管理，每次调用随参数传入，
//! 后端不持久化任何配置，保持「本地优先、无隐藏状态」。

use genai::chat::{ChatMessage, ChatOptions, ChatRequest};
use genai::resolver::{AuthData, AuthResolver, Endpoint, ServiceTargetResolver};
use genai::ServiceTarget;
use genai::Client;
use log::{error, info};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AiMessage {
  pub role: String,
  pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct AiChatParams {
  /// openai / anthropic / gemini / deepseek / moonshot / zhipu / openrouter / ollama / custom
  pub provider: String,
  pub model: String,
  #[serde(default)]
  pub api_key: Option<String>,
  #[serde(default)]
  pub base_url: Option<String>,
  #[serde(default)]
  pub temperature: Option<f64>,
  #[serde(default)]
  pub system_prompt: Option<String>,
  pub messages: Vec<AiMessage>,
}

/// 供应商 → genai 模型命名空间。
/// genai 依据模型名前缀自动映射适配器（gpt*/claude*/gemini* 等），
/// 其余名字一律落到 Ollama，因此除 ollama 外都显式加 `adapter::` 前缀最稳。
fn namespaced_model(provider: &str, model: &str) -> String {
  let model = model.trim();
  // 用户已手写命名空间（如 "groq::llama-3.3-70b"），尊重原样
  if model.contains("::") {
    return model.to_string();
  }
  match provider {
    "openai" | "custom" => format!("openai::{model}"),
    "anthropic" => format!("anthropic::{model}"),
    "gemini" => format!("gemini::{model}"),
    "deepseek" => format!("deepseek::{model}"),
    "moonshot" => format!("moonshot::{model}"),
    "zhipu" => format!("zai::{model}"),
    "openrouter" => format!("openrouter::{model}"),
    // ollama 及其他：走 genai 默认映射
    _ => model.to_string(),
  }
}

fn build_client(api_key: Option<&str>, base_url: Option<&str>) -> Client {
  let mut builder = Client::builder();

  if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()).map(String::from) {
    builder = builder.with_auth_resolver(AuthResolver::from_resolver_fn(
      move |_model_iden| Ok(Some(AuthData::from_single(key))),
    ));
  }

  if let Some(url) = base_url.map(str::trim).filter(|u| !u.is_empty()).map(normalize_base_url) {
    builder = builder.with_service_target_resolver(ServiceTargetResolver::from_resolver_fn(
      move |mut target: ServiceTarget| {
        target.endpoint = Endpoint::from_owned(url.clone());
        Ok(target)
      },
    ));
  }

  builder.build()
}

/// 规范化自定义 Base URL：确保以 `/` 结尾。
///
/// genai 内部用 `Url::join("chat/completions")` 拼 API 路径，而 join 的语义是
/// 「替换 base 的最后一段路径」：`https://api.example.com/v1` join 后会变成
/// `https://api.example.com/chat/completions`，`/v1` 被吃掉。很多网关对未知路径
/// 返回 200 + 前端页面（而非 JSON），导致「返回内容不是 JSON」的迷惑报错。
/// 补上尾斜杠后 join 才是「追加」语义，官方默认 endpoint 也正是带尾斜杠的。
fn normalize_base_url(url: &str) -> String {
  if url.ends_with('/') {
    url.to_string()
  } else {
    format!("{url}/")
  }
}

/// 把后端错误压成适合展示给用户的一小段文字。
///
/// genai 的错误串可能携带整个响应体（比如网关风控时返回的整页 HTML），
/// 原样透传会在界面上刷出大段无关内容。完整错误已经由 error! 写入日志，
/// 这里只保留第一行并限制长度，供前端做友好化包装后展示。
fn shorten_error_message(err: &genai::Error) -> String {
  let text = err.to_string();
  let first_line = text.lines().next().unwrap_or("未知错误").trim();
  const MAX_LEN: usize = 300;
  if first_line.chars().count() <= MAX_LEN {
    first_line.to_string()
  } else {
    let truncated: String = first_line.chars().take(MAX_LEN).collect();
    format!("{truncated}…（详情见日志）")
  }
}

#[cfg(test)]
mod tests {
  use super::normalize_base_url;

  #[test]
  fn appends_missing_trailing_slash() {
    // genai 内部 Url::join 会替换 base 最后一段，缺尾斜杠时 /v1 会被吃掉
    assert_eq!(
      normalize_base_url("https://api.example.com/v1"),
      "https://api.example.com/v1/"
    );
  }

  #[test]
  fn keeps_existing_trailing_slash() {
    assert_eq!(
      normalize_base_url("https://api.example.com/v1/"),
      "https://api.example.com/v1/"
    );
  }

  #[test]
  fn handles_root_url() {
    assert_eq!(normalize_base_url("http://localhost:11434"), "http://localhost:11434/");
  }
}

/// 多轮聊天补全。返回助手回复文本；错误以可读字符串回传前端。
#[tauri::command]
pub async fn ai_chat(params: AiChatParams) -> Result<String, String> {
  let model = params.model.trim().to_string();
  if model.is_empty() {
    error!(target: "ai", "AI 请求被拒绝：模型名称为空（provider={})", params.provider);
    return Err("尚未配置模型名称，请到「数据与设置」填写。".to_string());
  }
  info!(
    target: "ai",
    "AI 请求开始：provider={} model={} turns={}",
    params.provider, model, params.messages.len()
  );

  let mut messages: Vec<ChatMessage> = Vec::with_capacity(params.messages.len() + 1);
  if let Some(system) = params
    .system_prompt
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
  {
    messages.push(ChatMessage::system(system));
  }
  for m in &params.messages {
    let content = m.content.trim();
    if content.is_empty() {
      continue;
    }
    match m.role.as_str() {
      "user" => messages.push(ChatMessage::user(content)),
      "assistant" => messages.push(ChatMessage::assistant(content)),
      _ => {}
    }
  }
  if messages.is_empty() {
    return Err("消息内容为空。".to_string());
  }

  let chat_req = ChatRequest::new(messages);
  let chat_opts = params.temperature.map(|t| ChatOptions::default().with_temperature(t));

  let client = build_client(params.api_key.as_deref(), params.base_url.as_deref());

  let res = client
    .exec_chat(
      &namespaced_model(&params.provider, &model),
      chat_req,
      chat_opts.as_ref(),
    )
    .await;

  match res {
    Ok(res) => {
      let text = res.into_first_text().unwrap_or_default();
      info!(target: "ai", "AI 请求成功：model={} 回复 {} 字符", model, text.chars().count());
      Ok(text)
    }
    Err(err) => {
      // 完整错误（可能含整页响应体）只进日志；回传前端的压缩版本由前端再包装。
      error!(target: "ai", "AI 请求失败：provider={} model={} {err}", params.provider, model);
      Err(shorten_error_message(&err))
    }
  }
}
