//! AI 基础能力：基于 genai 的多供应商 LLM 接入，支持工具调用（tool calling）。
//!
//! 本模块是「协议转换层」：把前端 Agent 循环传来的多轮消息与工具定义
//! 翻译成 genai 请求，把响应拆回文本 + tool_calls。供应商 / 模型 / 密钥由
//! 前端设置页管理，每次调用随参数传入，后端不持久化任何配置，
//! 保持「本地优先、无隐藏状态」。
//!
//! 循环本身在 TS 侧（src/agent/loop.ts）：工具执行体（路由跳转、数据查询、
//! 文档检索）都是前端能力，循环贴近工具执行，无需 Rust ↔ 前端往返。

use genai::chat::{
  ChatMessage, ChatOptions, ChatRequest, ChatRole, ContentPart, MessageContent, Tool, ToolCall,
  ToolName, ToolResponse,
};
use genai::resolver::{AuthData, AuthResolver, Endpoint, ServiceTargetResolver};
use genai::ServiceTarget;
use genai::Client;
use log::{error, info};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/* ------------------------------------------------------------------ */
/* 前端 ↔ Rust 的消息协议                                               */
/* ------------------------------------------------------------------ */

/// 单个工具调用（模型发起）。arguments 保持 JSON 值，由前端按工具 schema 解析。
#[derive(Debug, Deserialize, Serialize)]
pub struct AiToolCall {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub arguments: Value,
}

/// 多轮消息：与 TS 侧 AgentMessage（src/agent/types.ts）一一对应。
#[derive(Debug, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum AiMessage {
  User {
    content: String,
  },
  /// 助手消息；content 与 tool_calls 至少有一方非空
  Assistant {
    #[serde(default)]
    content: String,
    #[serde(default, rename = "toolCalls")]
    tool_calls: Vec<AiToolCall>,
  },
  /// 工具执行结果回喂
  Tool {
    #[serde(rename = "toolCallId")]
    tool_call_id: String,
    name: String,
    content: String,
  },
}

/// 工具定义（JSON Schema 形式），透传给 genai 的 Tool。
#[derive(Debug, Deserialize)]
pub struct AiToolDef {
  pub name: String,
  pub description: Option<String>,
  #[serde(default)]
  pub schema: Option<Value>,
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
  /// Agent 循环构造的系统提示词（角色 + 当前页面 + 工具准则）
  #[serde(default)]
  pub system_prompt: Option<String>,
  pub messages: Vec<AiMessage>,
  #[serde(default)]
  pub tools: Vec<AiToolDef>,
}

/// 回传给前端的结构：助手文本 + 本轮发起的工具调用。
#[derive(Debug, Serialize)]
pub struct AiChatResult {
  pub content: String,
  pub tool_calls: Vec<AiToolCall>,
}

/* ------------------------------------------------------------------ */
/* 协议转换（纯函数，单测覆盖）                                          */
/* ------------------------------------------------------------------ */

/// 前端消息 → genai 消息。空文本且无调用的 assistant 消息返回 None（跳过）。
fn convert_message(msg: AiMessage) -> Option<ChatMessage> {
  match msg {
    AiMessage::User { content } => {
      let content = content.trim();
      if content.is_empty() {
        None
      } else {
        Some(ChatMessage::user(content))
      }
    }
    AiMessage::Assistant { content, tool_calls } => {
      let text = content.trim().to_string();
      if text.is_empty() && tool_calls.is_empty() {
        return None;
      }
      if tool_calls.is_empty() {
        return Some(ChatMessage::assistant(text));
      }
      // 文本 + 工具调用混合时，拼成 ContentPart 序列保留完整上下文
      let calls: Vec<ToolCall> = tool_calls
        .into_iter()
        .map(|c| ToolCall {
          call_id: c.id,
          fn_name: c.name,
          fn_arguments: c.arguments,
          thought_signatures: None,
        })
        .collect();

      if text.is_empty() {
        return Some(ChatMessage::from(calls));
      }

      let mut parts = vec![ContentPart::Text(text)];
      parts.extend(calls.into_iter().map(ContentPart::ToolCall));
      let content: MessageContent = parts.into_iter().collect();
      Some(ChatMessage::new(ChatRole::Assistant, content))
    }
    AiMessage::Tool {
      tool_call_id,
      name,
      content,
    } => Some(ChatMessage::from(
      ToolResponse::new(tool_call_id, content).with_fn_name(name),
    )),
  }
}

/// 工具定义 → genai Tool（名称 / 描述 / JSON Schema 原样透传）。
fn convert_tool(def: AiToolDef) -> Tool {
  Tool {
    name: ToolName::Custom(def.name),
    description: def.description,
    schema: def.schema,
    strict: None,
    config: None,
  }
}

/* ------------------------------------------------------------------ */
/* 供应商接入（沿用原有逻辑）                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

/// 带 tool calling 的多轮聊天补全。
/// 返回助手文本与 tool_calls；工具的实际执行与循环推进由前端 Agent 框架负责。
#[tauri::command]
pub async fn ai_chat(params: AiChatParams) -> Result<AiChatResult, String> {
  let model = params.model.trim().to_string();
  if model.is_empty() {
    error!(target: "ai", "AI 请求被拒绝：模型名称为空（provider={})", params.provider);
    return Err("尚未配置模型名称，请到「数据与设置」填写。".to_string());
  }
  info!(
    target: "ai",
    "AI 请求开始：provider={} model={} turns={} tools={}",
    params.provider, model, params.messages.len(), params.tools.len()
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
  for m in params.messages {
    if let Some(msg) = convert_message(m) {
      messages.push(msg);
    }
  }
  if messages.is_empty() {
    return Err("消息内容为空。".to_string());
  }

  let mut chat_req = ChatRequest::new(messages);
  if !params.tools.is_empty() {
    chat_req = chat_req.with_tools(params.tools.into_iter().map(convert_tool));
  }

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
      // 先借用收集 tool_calls，再消费响应取文本
      let tool_calls: Vec<AiToolCall> = res
        .tool_calls()
        .into_iter()
        .map(|c| AiToolCall {
          id: c.call_id.clone(),
          name: c.fn_name.clone(),
          arguments: c.fn_arguments.clone(),
        })
        .collect();
      let content = res.into_first_text().unwrap_or_default();

      info!(
        target: "ai",
        "AI 请求成功：model={} 回复 {} 字符 tool_calls={}",
        model, content.chars().count(), tool_calls.len()
      );
      Ok(AiChatResult { content, tool_calls })
    }
    Err(err) => {
      // 完整错误（可能含整页响应体）只进日志；回传前端的压缩版本由前端再包装。
      error!(target: "ai", "AI 请求失败：provider={} model={} {err}", params.provider, model);
      Err(shorten_error_message(&err))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{convert_message, convert_tool, normalize_base_url, AiMessage, AiToolCall, AiToolDef};
  use genai::chat::ChatRole;
  use serde_json::json;

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

  /// 模拟前端发来的消息序列（serde tag = "role"）
  #[test]
  fn deserializes_agent_message_sequence() {
    let payload = json!([
      { "role": "user", "content": "打开学生列表" },
      { "role": "assistant", "content": "", "toolCalls": [
        { "id": "call-1", "name": "navigate", "arguments": { "target": "students" } }
      ]},
      { "role": "tool", "toolCallId": "call-1", "name": "navigate", "content": "已打开「学生档案」页面。" },
      { "role": "assistant", "content": "已为你打开学生档案。" }
    ]);

    let msgs: Vec<AiMessage> = serde_json::from_value(payload).expect("反序列化应成功");
    assert_eq!(msgs.len(), 4);

    let converted: Vec<_> = msgs.into_iter().filter_map(convert_message).collect();
    assert_eq!(converted.len(), 4);
    assert!(matches!(converted[0].role, ChatRole::User));
    assert!(matches!(converted[1].role, ChatRole::Assistant));
    assert!(matches!(converted[2].role, ChatRole::Tool));
    assert!(matches!(converted[3].role, ChatRole::Assistant));
  }

  /// 混合内容：assistant 文本 + tool_calls 应拼成 Text + ToolCall parts
  #[test]
  fn assistant_message_keeps_text_alongside_tool_calls() {
    let msg: AiMessage = serde_json::from_value(json!({
      "role": "assistant",
      "content": "我来查一下",
      "toolCalls": [
        { "id": "call-1", "name": "query_data", "arguments": { "entity": "stats" } }
      ]
    }))
    .expect("反序列化应成功");

    let converted = convert_message(msg).expect("非空消息应转换成功");
    assert!(matches!(converted.role, ChatRole::Assistant));
    assert_eq!(converted.content.joined_texts().as_deref(), Some("我来查一下"));
    let calls = converted.content.tool_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].fn_name, "query_data");
  }

  /// 空文本且无调用的 assistant 消息应被跳过
  #[test]
  fn skips_empty_assistant_message() {
    let msg: AiMessage = serde_json::from_value(json!({
      "role": "assistant",
      "content": "",
      "toolCalls": []
    }))
    .expect("反序列化应成功");
    assert!(convert_message(msg).is_none());
  }

  /// 工具定义透传：名称、描述、JSON Schema 原样进入 genai Tool
  #[test]
  fn converts_tool_definition() {
    let def: AiToolDef = serde_json::from_value(json!({
      "name": "navigate",
      "description": "打开或切换应用内的某个页面。",
      "schema": {
        "type": "object",
        "properties": { "target": { "type": "string", "enum": ["home", "students"] } },
        "required": ["target"]
      }
    }))
    .expect("反序列化应成功");

    let tool = convert_tool(def);
    assert!(matches!(tool.name, genai::chat::ToolName::Custom(_)));
    if let genai::chat::ToolName::Custom(name) = tool.name {
      assert_eq!(name, "navigate");
    }
    assert_eq!(tool.description.as_deref(), Some("打开或切换应用内的某个页面。"));
    let schema = tool.schema.expect("schema 应透传");
    assert_eq!(schema["properties"]["target"]["enum"][1], "students");
  }

  /// tool 消息（工具结果）应带上 call_id 与函数名
  #[test]
  fn tool_message_carries_call_id_and_fn_name() {
    let msg: AiMessage = serde_json::from_value(json!({
      "role": "tool",
      "toolCallId": "call-9",
      "name": "find_docs",
      "content": "找到 2 个片段"
    }))
    .expect("反序列化应成功");

    let converted = convert_message(msg).expect("非空消息应转换成功");
    assert!(matches!(converted.role, ChatRole::Tool));
    let responses = converted.content.tool_responses();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].call_id, "call-9");
    assert_eq!(responses[0].fn_name.as_deref(), Some("find_docs"));
  }

  /// 序列化往返：AiChatResult 能转回前端需要的 JSON
  #[test]
  fn result_serializes_to_frontend_shape() {
    let result = super::AiChatResult {
      content: "已打开".to_string(),
      tool_calls: vec![AiToolCall {
        id: "c1".to_string(),
        name: "navigate".to_string(),
        arguments: json!({ "target": "home" }),
      }],
    };
    let value = serde_json::to_value(&result).expect("序列化应成功");
    assert_eq!(value["tool_calls"][0]["name"], "navigate");
    assert_eq!(value["tool_calls"][0]["arguments"]["target"], "home");
  }
}
