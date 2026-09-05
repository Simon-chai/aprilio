//! AI 基础能力：基于 rig-core 的多供应商 LLM 接入，支持工具调用（tool calling）。
//!
//! 本模块是「协议转换层」：把前端 Agent 循环传来的多轮消息与工具定义
//! 翻译成 rig 的 CompletionRequest，把响应拆回文本 + tool_calls。
//! 供应商 / 模型 / 密钥由前端设置页管理，每次调用随参数传入，后端不持久化任何配置，
//! 保持「本地优先、无隐藏状态」。
//!
//! 循环本身在 TS 侧（src/agent/loop.ts）：工具执行体（路由跳转、数据查询、
//! 文档检索）都是前端能力，循环贴近工具执行，无需 Rust ↔ 前端往返。
//!
//! 两条命令共用同一套供应商映射（`dispatch_provider!` 宏是唯一事实源）：
//! - `ai_chat`：一次性返回完整结果；
//! - `ai_chat_stream`：助手文本经 `tauri::ipc::Channel` 逐段推送（事件 `delta`），
//!   最终结果仍随命令返回值一次性给出；工具调用不逐段推，直接随返回值给全量。
//!
//! 供应商映射（docs/AGENT_FRAMEWORK_EVALUATION.md §2）：
//! - anthropic / gemini / ollama → rig 原生 provider
//! - openai / deepseek / moonshot / zhipu / openrouter / custom → rig 的
//!   OpenAI 兼容 Chat Completions 客户端（CompletionsClient），各官方端点见
//!   `default_endpoint_for`；带自定义 base_url 时一律走兼容通道。

use futures::StreamExt;
use rig_core::client::CompletionClient;
use rig_core::completion::message::{ToolCall, ToolFunction, Text};
use rig_core::completion::{
  AssistantContent, CompletionModel, CompletionRequest, CompletionResponse, Message, ToolDefinition,
};
use rig_core::providers::{anthropic, gemini, ollama, openai};
use rig_core::streaming::StreamedAssistantContent;
use log::{error, info};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;

/* ------------------------------------------------------------------ */
/* 前端 ↔ Rust 的消息协议（与 genai 时期保持不变）                        */
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

/// 工具定义（JSON Schema 形式），透传给 rig 的 ToolDefinition。
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

/// 流式过程事件：助手文本增量。最终结果仍由命令返回值承载。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
  Delta { text: String },
}

/* ------------------------------------------------------------------ */
/* 协议转换（纯函数，单测覆盖）                                          */
/* ------------------------------------------------------------------ */

/// 前端消息 → rig 消息。空文本且无调用的 assistant 消息返回 None（跳过）。
fn convert_message(msg: AiMessage) -> Option<Message> {
  match msg {
    AiMessage::User { content } => {
      let content = content.trim();
      if content.is_empty() {
        None
      } else {
        Some(Message::user(content))
      }
    }
    AiMessage::Assistant { content, tool_calls } => {
      let text = content.trim().to_string();
      if text.is_empty() && tool_calls.is_empty() {
        return None;
      }
      if tool_calls.is_empty() {
        return Some(Message::assistant(text));
      }
      // 文本 + 工具调用混合时，按序保留完整上下文
      let mut parts: Vec<AssistantContent> = Vec::with_capacity(1 + tool_calls.len());
      if !text.is_empty() {
        parts.push(AssistantContent::Text(Text::new(text)));
      }
      for c in tool_calls {
        parts.push(AssistantContent::ToolCall(ToolCall::from_wire(
          c.id,
          ToolFunction {
            name: c.name,
            arguments: c.arguments,
          },
        )));
      }
      Some(Message::Assistant { id: None, content: parts })
    }
    AiMessage::Tool {
      tool_call_id,
      name,
      content,
    } => Some(Message::tool_result(tool_call_id, name, content)),
  }
}

/// 工具定义 → rig ToolDefinition（名称 / 描述 / JSON Schema 原样透传）。
fn convert_tool(def: AiToolDef) -> ToolDefinition {
  ToolDefinition {
    name: def.name,
    description: def.description.unwrap_or_default(),
    parameters: def.schema.unwrap_or_else(|| serde_json::json!({ "type": "object", "properties": {} })),
  }
}

/// rig ToolCall → 前端协议。id 取 wire 形态（与 tool 消息回喂时的 call_id 对齐）。
fn tool_call_to_ai(c: ToolCall) -> AiToolCall {
  AiToolCall {
    id: c.wire_call_id().to_string(),
    name: c.function.name,
    arguments: c.function.arguments,
  }
}

/* ------------------------------------------------------------------ */
/* 供应商接入                                                           */
/* ------------------------------------------------------------------ */

/// OpenAI 兼容供应商 → 官方端点（TS 未传 base_url 时使用）。
/// 这些供应商都暴露 Chat Completions 兼容接口，统一走 rig 的 CompletionsClient。
fn default_endpoint_for(provider: &str) -> Option<&'static str> {
  match provider {
    "deepseek" => Some("https://api.deepseek.com"),
    "moonshot" => Some("https://api.moonshot.cn/v1"),
    "zhipu" => Some("https://open.bigmodel.cn/api/paas/v4"),
    "openrouter" => Some("https://openrouter.ai/api/v1"),
    _ => None,
  }
}

/// 规范化自定义 Base URL：确保以 `/` 结尾。
///
/// 兼容网关按 `base + path` 拼 URL 时，缺尾斜杠会把 base 的最后一段吃掉
/// （`/v1` join `chat/completions` 变成 `/chat/completions`），导致
/// 「返回内容不是 JSON」的迷惑报错。补上尾斜杠才是「追加」语义。
fn normalize_base_url(url: &str) -> String {
  if url.ends_with('/') {
    url.to_string()
  } else {
    format!("{url}/")
  }
}

/// 把后端错误压成适合展示给用户的一小段文字。
///
/// 供应商错误串可能携带整个响应体（比如网关风控时返回的整页 HTML），
/// 原样透传会在界面上刷出大段无关内容。完整错误已经由 error! 写入日志，
/// 这里只保留第一行并限制长度，供前端做友好化包装后展示。
fn shorten_error_message(err: impl std::fmt::Display) -> String {
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

/// 从 rig 归一化响应中提取文本与 tool_calls。
fn extract_choice(res: CompletionResponse) -> AiChatResult {
  let mut content = String::new();
  let mut tool_calls: Vec<AiToolCall> = Vec::new();
  for item in res.choice {
    match item {
      AssistantContent::Text(t) => content.push_str(&t.text),
      AssistantContent::ToolCall(c) => tool_calls.push(tool_call_to_ai(c)),
      _ => {}
    }
  }
  AiChatResult { content, tool_calls }
}

/// 执行模式：一次性返回，或逐段推给前端 Channel。
#[derive(Clone, Copy)]
enum ExecMode<'a> {
  Once,
  Stream(&'a Channel<AiStreamEvent>),
}

/// 泛型执行：不同 provider 的模型类型不同（CompletionModel 非动态兼容），
/// 每个分支各调一次，共用这段提取逻辑。流式模式下文本增量逐段 send 给 Channel。
async fn exec_model<M: CompletionModel>(
  model: &M,
  req: CompletionRequest,
  provider: &str,
  model_name: &str,
  mode: ExecMode<'_>,
) -> Result<AiChatResult, String> {
  let result = match mode {
    ExecMode::Once => match model.completion(req).await {
      Ok(res) => {
        let r = extract_choice(res);
        info!(
          target: "ai",
          "AI 请求成功：provider={} model={} 回复 {} 字符 tool_calls={}",
          provider, model_name, r.content.chars().count(), r.tool_calls.len()
        );
        r
      }
      Err(err) => {
        error!(target: "ai", "AI 请求失败：provider={} model={} {err}", provider, model_name);
        return Err(shorten_error_message(err));
      }
    },
    ExecMode::Stream(channel) => match model.stream(req).await {
      Ok(mut stream) => {
        let mut content = String::new();
        let mut tool_calls: Vec<AiToolCall> = Vec::new();
        while let Some(item) = stream.next().await {
          match item {
            Ok(StreamedAssistantContent::Text(t)) => {
              content.push_str(&t.text);
              // 推送失败（窗口关闭等）只放弃流式展示，不影响最终结果
              if let Err(e) = channel.send(AiStreamEvent::Delta { text: t.text }) {
                log::warn!(target: "ai", "流式增量推送失败（继续聚合）：{e}");
              }
            }
            Ok(StreamedAssistantContent::ToolCall { tool_call, .. }) => {
              tool_calls.push(tool_call_to_ai(tool_call));
            }
            Ok(_) => {}
            Err(err) => {
              error!(target: "ai", "AI 流式请求失败：provider={} model={} {err}", provider, model_name);
              return Err(shorten_error_message(err));
            }
          }
        }
        info!(
          target: "ai",
          "AI 流式请求成功：provider={} model={} 回复 {} 字符 tool_calls={}",
          provider, model_name, content.chars().count(), tool_calls.len()
        );
        AiChatResult { content, tool_calls }
      }
      Err(err) => {
        error!(target: "ai", "AI 流式请求发起失败：provider={} model={} {err}", provider, model_name);
        return Err(shorten_error_message(err));
      }
    },
  };
  Ok(result)
}

fn require_key(api_key: &Option<String>, provider: &str) -> Result<String, String> {
  api_key
    .as_deref()
    .map(str::trim)
    .filter(|k| !k.is_empty())
    .map(String::from)
    .ok_or_else(|| format!("供应商 {provider} 需要 API Key，请到「数据与设置」填写。"))
}

/* ------------------------------------------------------------------ */
/* 请求构造 + 供应商分发（两条命令的唯一事实源）                          */
/* ------------------------------------------------------------------ */

/// 校验参数并构造 rig CompletionRequest。返回（provider, model_name, api_key, endpoint, request）。
fn prepare_request(
  params: AiChatParams,
) -> Result<(String, String, Option<String>, Option<String>, CompletionRequest), String> {
  let AiChatParams {
    provider,
    model,
    api_key,
    base_url,
    temperature,
    system_prompt,
    messages,
    tools,
  } = params;

  let model_name = model.trim().to_string();
  if model_name.is_empty() {
    error!(target: "ai", "AI 请求被拒绝：模型名称为空（provider={})", provider);
    return Err("尚未配置模型名称，请到「数据与设置」填写。".to_string());
  }
  info!(
    target: "ai",
    "AI 请求开始：provider={} model={} turns={} tools={}",
    provider, model_name, messages.len(), tools.len()
  );

  let mut chat_history: Vec<Message> = Vec::with_capacity(messages.len() + 1);
  if let Some(system) = system_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
    chat_history.push(Message::system(system));
  }
  for m in messages {
    if let Some(msg) = convert_message(m) {
      chat_history.push(msg);
    }
  }
  if chat_history.is_empty() {
    return Err("消息内容为空。".to_string());
  }

  let req = CompletionRequest {
    model: None,
    preamble: None, // 系统指令走 chat_history 首条 System 消息（rig 0.42 推荐形态）
    chat_history,
    documents: vec![],
    tools: tools.into_iter().map(convert_tool).collect(),
    temperature,
    max_tokens: None,
    tool_choice: None,
    additional_params: None,
    output_schema: None,
    record_telemetry_content: false,
  };

  let endpoint = base_url
    .as_deref()
    .map(str::trim)
    .filter(|u| !u.is_empty())
    .map(normalize_base_url);

  Ok((provider, model_name, api_key, endpoint, req))
}

/// 供应商映射宏：分支里构造各自 client 并以 `($model, $req, $provider, $model_name, $mode)`
/// 调用执行器。新增 OpenAI 兼容供应商时在这里加端点即可同时覆盖两条命令。
macro_rules! dispatch_provider {
  ($provider:expr, $api_key:expr, $endpoint:expr, $model_name:expr, $req:expr, $mode:expr) => {
    match $provider.as_str() {
      "anthropic" => {
        let key = require_key(&$api_key, &$provider)?;
        let mut b = anthropic::Client::builder().api_key(key);
        if let Some(url) = &$endpoint {
          b = b.base_url(url);
        }
        let client = b.build().map_err(|e| e.to_string())?;
        exec_model(&client.completion_model(&$model_name), $req, &$provider, &$model_name, $mode).await
      }
      "gemini" => {
        let key = require_key(&$api_key, &$provider)?;
        let mut b = gemini::Client::builder().api_key(key);
        if let Some(url) = &$endpoint {
          b = b.base_url(url);
        }
        let client = b.build().map_err(|e| e.to_string())?;
        exec_model(&client.completion_model(&$model_name), $req, &$provider, &$model_name, $mode).await
      }
      "ollama" => {
        // 本地模型：无密钥（OllamaApiKey 接受 Nothing），兼容端点即 Ollama 服务地址
        let mut b = ollama::Client::builder().api_key(rig_core::client::Nothing);
        if let Some(url) = &$endpoint {
          b = b.base_url(url);
        }
        let client = b.build().map_err(|e| e.to_string())?;
        exec_model(&client.completion_model(&$model_name), $req, &$provider, &$model_name, $mode).await
      }
      // openai / deepseek / moonshot / zhipu / openrouter / custom：
      // 全部是 OpenAI 兼容 Chat Completions，统一走 CompletionsClient。
      _ => {
        let key = require_key(&$api_key, &$provider)?;
        let url = match $endpoint {
          Some(url) => url,
          None => default_endpoint_for(&$provider)
            .map(str::to_string)
            .ok_or_else(|| format!("供应商 {} 需要填写 Base URL。", $provider))?,
        };
        let client = openai::CompletionsClient::builder()
          .api_key(key)
          .base_url(url)
          .build()
          .map_err(|e| e.to_string())?;
        exec_model(&client.completion_model(&$model_name), $req, &$provider, &$model_name, $mode).await
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

/// 带 tool calling 的多轮聊天补全（一次性）。
/// 返回助手文本与 tool_calls；工具的实际执行与循环推进由前端 Agent 框架负责。
#[tauri::command]
pub async fn ai_chat(params: AiChatParams) -> Result<AiChatResult, String> {
  let (provider, model_name, api_key, endpoint, req) = prepare_request(params)?;
  dispatch_provider!(provider, api_key, endpoint, model_name, req, ExecMode::Once)
}

/// 流式版聊天补全：助手文本增量经 `on_delta` Channel 逐段推给前端，
/// 最终结果（全文 + tool_calls）仍随命令返回值一次性给出。
#[tauri::command]
pub async fn ai_chat_stream(
  params: AiChatParams,
  on_delta: Channel<AiStreamEvent>,
) -> Result<AiChatResult, String> {
  let (provider, model_name, api_key, endpoint, req) = prepare_request(params)?;
  dispatch_provider!(provider, api_key, endpoint, model_name, req, ExecMode::Stream(&on_delta))
}

#[cfg(test)]
mod tests {
  use super::{
    convert_message, convert_tool, default_endpoint_for, normalize_base_url, tool_call_to_ai,
    AiMessage, AiStreamEvent, AiToolCall, AiToolDef,
  };
  use rig_core::completion::message::{AssistantContent, ToolCall, ToolFunction, UserContent};
  use rig_core::completion::Message;
  use serde_json::json;

  #[test]
  fn appends_missing_trailing_slash() {
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

  #[test]
  fn maps_compatible_providers_to_official_endpoints() {
    assert_eq!(default_endpoint_for("deepseek"), Some("https://api.deepseek.com"));
    assert_eq!(default_endpoint_for("moonshot"), Some("https://api.moonshot.cn/v1"));
    assert_eq!(default_endpoint_for("zhipu"), Some("https://open.bigmodel.cn/api/paas/v4"));
    assert_eq!(default_endpoint_for("openrouter"), Some("https://openrouter.ai/api/v1"));
    // openai 有默认端点、未知供应商不猜
    assert_eq!(default_endpoint_for("openai"), None);
    assert_eq!(default_endpoint_for("something-else"), None);
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
    assert!(matches!(converted[0], Message::User { .. }));
    assert!(matches!(converted[1], Message::Assistant { .. }));
    assert!(matches!(converted[2], Message::User { .. })); // tool result 以 User 消息承载
    assert!(matches!(converted[3], Message::Assistant { .. }));
  }

  /// 混合内容：assistant 文本 + tool_calls 应按序保留 Text 与 ToolCall
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
    let Message::Assistant { content, .. } = converted else {
      panic!("应为 assistant 消息");
    };
    assert_eq!(content.len(), 2);
    assert!(matches!(content[0], AssistantContent::Text(_)));
    match &content[1] {
      AssistantContent::ToolCall(call) => {
        assert_eq!(call.function.name, "query_data");
        assert_eq!(call.function.arguments["entity"], "stats");
        assert_eq!(call.wire_call_id(), "call-1");
      }
      other => panic!("应为 ToolCall，得到 {other:?}"),
    }
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

  /// 工具定义透传：名称、描述、JSON Schema 原样进入 rig ToolDefinition
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
    assert_eq!(tool.name, "navigate");
    assert_eq!(tool.description, "打开或切换应用内的某个页面。");
    assert_eq!(tool.parameters["properties"]["target"]["enum"][1], "students");
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
    let Message::User { content } = converted else {
      panic!("tool result 应转换为 User 消息");
    };
    assert_eq!(content.len(), 1);
    match &content[0] {
      UserContent::ToolResult(result) => {
        assert_eq!(result.wire_call_id(), "call-9");
        assert_eq!(result.name, "find_docs");
      }
      other => panic!("应为 ToolResult，得到 {other:?}"),
    }
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

  /// 流式事件带 delta 标签，前端按 type 分派
  #[test]
  fn stream_event_serializes_with_delta_tag() {
    let value = serde_json::to_value(AiStreamEvent::Delta { text: "你好".into() }).expect("序列化应成功");
    assert_eq!(value["type"], "delta");
    assert_eq!(value["text"], "你好");
  }

  /// rig ToolCall → 前端协议：id 取 wire 形态、arguments 原样保留
  #[test]
  fn converts_tool_call_to_frontend_shape() {
    let call = ToolCall::from_wire(
      "call-7".to_string(),
      ToolFunction { name: "find_docs".into(), arguments: json!({ "keywords": "日志" }) },
    );
    let ai = tool_call_to_ai(call);
    assert_eq!(ai.id, "call-7");
    assert_eq!(ai.name, "find_docs");
    assert_eq!(ai.arguments["keywords"], "日志");
  }
}
