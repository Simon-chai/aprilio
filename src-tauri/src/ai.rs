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
//! 三条命令共用同一套供应商映射（`build_client` 是唯一事实源）：
//! - `ai_chat`：一次性返回完整结果；
//! - `ai_chat_stream`：助手文本经 `tauri::ipc::Channel` 逐段推送（事件 `delta`），
//!   最终结果仍随命令返回值一次性给出；工具调用不逐段推，直接随返回值给全量。
//! - `ai_list_models`：拉取供应商支持的模型列表（设置页「一键拉取」），
//!   走 rig 的 ModelListingClient（OpenAI 兼容 = GET {base}/models）。
//!
//! 供应商映射（docs/AGENT_FRAMEWORK_EVALUATION.md §2）：
//! - anthropic / gemini / ollama → rig 原生 provider
//! - openai / deepseek / moonshot / zhipu / openrouter / custom → rig 的
//!   OpenAI 兼容 Chat Completions 客户端（CompletionsClient），各官方端点见
//!   `default_endpoint_for`；带自定义 base_url 时一律走兼容通道。
//!   该通道统一带「网关响应宽容层」后端（GatewayCompatClient）：部分网关在 200
//!   成功体里把 `message.role` 写成空串，会让 rig 的严格解码把成功误判成失败。

use bytes::Bytes;
use futures::StreamExt;
use rig_core::client::{CompletionClient, ModelListingClient};
use rig_core::completion::message::{ToolCall, ToolFunction, Text};
use rig_core::completion::{
  AssistantContent, CompletionModel, CompletionRequest, CompletionResponse, Message, ToolDefinition,
};
use rig_core::http_client::{
  Error as HttpError, HttpClientExt, LazyBody, MultipartForm, Request as HttpRequest,
  Response as HttpResponse, StreamingResponse,
};
use rig_core::providers::{anthropic, gemini, ollama, openai};
use rig_core::streaming::StreamedAssistantContent;
use rig_core::wasm_compat::WasmCompatSend;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
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
/* 网关响应宽容层（OpenAI 兼容通道的兼容垫片）                            */
/* ------------------------------------------------------------------ */

/// 把网关返回的成功体归一化成 rig 能解析的形状；无需改动时返回 None。
///
/// 背景（实测故障，2026-10-01）：部分 OpenAI 兼容网关在 **200 成功体**里把
/// `choices[*].message.role` 写成空串 `""`。rig 0.42 的
/// `openai::completion::Message` 是 `#[serde(tag = "role")]` 的严格枚举，空串不在
/// 变体表内 → 整个响应体反序列化失败；而 rig 的响应信封 `ApiResponse<T>` 是
/// untagged 的「成功或错误」，解码失败会静默回落到「错误」分支 → 一个内容完好的
/// 成功响应被报成 `ProviderResponseError: status 200 OK: {...}`，排查时极具误导性
/// （HTTP 层其实完全成功，模型回复就在 body 里）。
///
/// 归一化只做一件最小的事：`message.role` 缺失或为空串时补成 `"assistant"`。
/// 响应体里的回复角色语义上只能是 assistant（工具调用会被网关显式写成 `"tool"`），
/// 所以不会篡改任何有效信息。其余情况一律不碰，避免掩盖真正的协议问题：
/// - `role` 是其它非空值（真不匹配，应照原样报错）；
/// - 顶层带 `error` / `errors` 键（网关的错误信封，绝不能改写）；
/// - 不是 JSON 对象、或没有 `choices` 数组（交给 rig 原有的报错链路）。
fn normalize_gateway_body(raw: &[u8]) -> Option<Vec<u8>> {
  let mut body: Value = serde_json::from_slice(raw).ok()?;
  let obj = body.as_object_mut()?;
  if obj.contains_key("error") || obj.contains_key("errors") {
    return None;
  }
  let choices = obj.get_mut("choices")?.as_array_mut()?;

  let mut patched = false;
  for choice in choices.iter_mut() {
    let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
      continue;
    };
    let needs_role = match message.get("role") {
      None | Some(Value::Null) => true,
      Some(Value::String(role)) => role.trim().is_empty(),
      Some(_) => false,
    };
    if needs_role {
      message.insert("role".to_string(), Value::String("assistant".to_string()));
      patched = true;
    }
  }
  if !patched {
    return None;
  }
  serde_json::to_vec(&body).ok()
}

/// reqwest 错误 → rig 传输错误（与 rig 自带实现的映射一致；rig 的
/// `instance_error` 是 crate 私有，这里按同样语义自己包一层）。
fn transport_error<E: std::error::Error + Send + Sync + 'static>(error: E) -> HttpError {
  HttpError::Instance(Box::new(error))
}

/// 带响应归一化的 HTTP 后端：包一层 `reqwest::Client`，只在非流式路径上把
/// 网关的成功体过一遍 `normalize_gateway_body`。
///
/// 为什么改传输层而不是改别处：rig 0.42 的严格解码在 provider 内部完成，外部无从
/// 干预；`HttpClientExt` 是 rig 官方留出的后端替换点，且
/// docs/AGENT_FRAMEWORK_EVALUATION.md §2.4 明确把这类 pre-1.0 摩擦收在 ai.rs 的
/// 适配层里（升级 rig 时只需重看这里，不动业务代码）。
///
/// 流式路径（`send_streaming`）与 multipart 原样转发：流式 delta 结构里没有 role
/// 字段，本来就不受该问题影响，保持字节级透传以免引入新的行为差异。
#[derive(Clone, Debug, Default)]
struct GatewayCompatClient {
  inner: reqwest::Client,
}

impl HttpClientExt for GatewayCompatClient {
  fn send<T, U>(
    &self,
    req: HttpRequest<T>,
  ) -> impl Future<Output = std::result::Result<HttpResponse<LazyBody<U>>, HttpError>>
       + WasmCompatSend
       + 'static
  where
    T: Into<Bytes> + WasmCompatSend,
    U: From<Bytes> + WasmCompatSend + 'static,
  {
    let (parts, body) = req.into_parts();
    let request = self
      .inner
      .request(parts.method, parts.uri.to_string())
      .headers(parts.headers)
      .body(body.into());

    async move {
      let response = request.send().await.map_err(transport_error)?;
      let status = response.status();
      let headers = response.headers().clone();

      if !status.is_success() {
        // 与 rig 自带实现一致：非成功状态在传输层就报错，并带上响应头
        // （供应商 request-id 契约、429 的 Retry-After 都靠它）
        let body = response
          .text()
          .await
          .unwrap_or_else(|error| format!("failed to read error response body: {error}"));
        return Err(HttpError::InvalidStatusCodeWithDetails {
          status,
          body,
          headers: Box::new(headers),
        });
      }

      let mut builder = HttpResponse::builder().status(status);
      if let Some(target) = builder.headers_mut() {
        *target = headers;
      }

      let lazy: LazyBody<U> = Box::pin(async move {
        let raw = response.bytes().await.map_err(transport_error)?;
        match normalize_gateway_body(&raw) {
          Some(fixed) => {
            warn!(
              target: "ai",
              "网关成功响应缺少有效 role，已按 assistant 归一化后交给 rig 解析"
            );
            Ok(U::from(Bytes::from(fixed)))
          }
          // 无需改动时原样透传，保持字节级一致
          None => Ok(U::from(raw)),
        }
      });

      builder.body(lazy).map_err(HttpError::Protocol)
    }
  }

  fn send_multipart<U>(
    &self,
    req: HttpRequest<MultipartForm>,
  ) -> impl Future<Output = std::result::Result<HttpResponse<LazyBody<U>>, HttpError>>
       + WasmCompatSend
       + 'static
  where
    U: From<Bytes> + WasmCompatSend + 'static,
  {
    self.inner.send_multipart(req)
  }

  fn send_streaming<T>(
    &self,
    req: HttpRequest<T>,
  ) -> impl Future<Output = std::result::Result<StreamingResponse, HttpError>> + WasmCompatSend
  where
    T: Into<Bytes> + WasmCompatSend,
  {
    self.inner.send_streaming(req)
  }
}

/* ------------------------------------------------------------------ */
/* 供应商客户端构造（聊天 / 流式 / 模型列表三条命令的唯一事实源）           */
/* ------------------------------------------------------------------ */

/// 收拢后的供应商客户端。rig 各家 client 类型互不相同（CompletionModel 非动态
/// 兼容），枚举 + match 是「构造一次、多条命令共用」的最小方案。
#[derive(Debug)]
enum ProviderClient {
  Anthropic(anthropic::Client),
  Gemini(gemini::Client),
  Ollama(ollama::Client),
  /// OpenAI 兼容 Chat Completions（openai / deepseek / moonshot / zhipu / openrouter / custom）
  /// 传输层走 GatewayCompatClient：网关成功体里 role 为空串时先归一化（见该类型文档）
  OpenAiCompat(openai::CompletionsClient<GatewayCompatClient>),
}

/// 供应商 → rig client。新增供应商时在这里加分支即可同时覆盖三条命令。
fn build_client(
  provider: &str,
  api_key: &Option<String>,
  endpoint: Option<String>,
) -> Result<ProviderClient, String> {
  match provider {
    "anthropic" => {
      let key = require_key(api_key, provider)?;
      let mut b = anthropic::Client::builder().api_key(key);
      if let Some(url) = &endpoint {
        b = b.base_url(url);
      }
      Ok(ProviderClient::Anthropic(b.build().map_err(|e| e.to_string())?))
    }
    "gemini" => {
      let key = require_key(api_key, provider)?;
      let mut b = gemini::Client::builder().api_key(key);
      if let Some(url) = &endpoint {
        b = b.base_url(url);
      }
      Ok(ProviderClient::Gemini(b.build().map_err(|e| e.to_string())?))
    }
    "ollama" => {
      // 本地模型：无密钥（OllamaApiKey 接受 Nothing），兼容端点即 Ollama 服务地址
      let mut b = ollama::Client::builder().api_key(rig_core::client::Nothing);
      if let Some(url) = &endpoint {
        b = b.base_url(url);
      }
      Ok(ProviderClient::Ollama(b.build().map_err(|e| e.to_string())?))
    }
    // openai / deepseek / moonshot / zhipu / openrouter / custom：
    // 全部是 OpenAI 兼容 Chat Completions，统一走 CompletionsClient。
    _ => {
      let key = require_key(api_key, provider)?;
      // 端点取值：显式地址 > 官方兼容端点 > rig 内置 OpenAI 默认地址（openai 留空即官方）。
      // 其余兼容供应商没有内置端点，留空时在构造期就给出明确报错。
      let url = match endpoint {
        Some(url) => Some(url),
        None if provider == "openai" => None,
        None => Some(
          default_endpoint_for(provider)
            .map(str::to_string)
            .ok_or_else(|| format!("供应商 {provider} 需要填写 Base URL。"))?,
        ),
      };
      let mut b = openai::CompletionsClient::builder().api_key(key);
      if let Some(url) = url {
        b = b.base_url(url);
      }
      // 显式挂上宽容层后端（不挂则用 rig 默认 reqwest，空 role 会触发误报）
      let client = b
        .http_client(GatewayCompatClient::default())
        .build()
        .map_err(|e| e.to_string())?;
      Ok(ProviderClient::OpenAiCompat(client))
    }
  }
}

/* ------------------------------------------------------------------ */
/* 命令                                                                 */
/* ------------------------------------------------------------------ */

/// 带 tool calling 的多轮聊天补全（一次性）。
/// 返回助手文本与 tool_calls；工具的实际执行与循环推进由前端 Agent 框架负责。
#[tauri::command]
pub async fn ai_chat(params: AiChatParams) -> Result<AiChatResult, String> {
  let (provider, model_name, api_key, endpoint, req) = prepare_request(params)?;
  let mode = ExecMode::Once;
  match build_client(&provider, &api_key, endpoint)? {
    ProviderClient::Anthropic(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::Gemini(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::Ollama(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::OpenAiCompat(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
  }
}

/// 流式版聊天补全：助手文本增量经 `on_delta` Channel 逐段推给前端，
/// 最终结果（全文 + tool_calls）仍随命令返回值一次性给出。
#[tauri::command]
pub async fn ai_chat_stream(
  params: AiChatParams,
  on_delta: Channel<AiStreamEvent>,
) -> Result<AiChatResult, String> {
  let (provider, model_name, api_key, endpoint, req) = prepare_request(params)?;
  let mode = ExecMode::Stream(&on_delta);
  match build_client(&provider, &api_key, endpoint)? {
    ProviderClient::Anthropic(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::Gemini(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::Ollama(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
    ProviderClient::OpenAiCompat(c) => {
      exec_model(&c.completion_model(&model_name), req, &provider, &model_name, mode).await
    }
  }
}

/* ------------------------------------------------------------------ */
/* 模型列表拉取（设置页「一键拉取」）                                     */
/* ------------------------------------------------------------------ */

/// 模型列表条目：id 是设置页要填的「模型 ID」，name 是供应商给的可读名（可缺省）。
#[derive(Debug, Serialize)]
pub struct AiModelOption {
  pub id: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub name: Option<String>,
}

/// 拉取模型列表的参数：provider + 可选密钥 / 自定义地址（与 AiChatParams 对齐）。
#[derive(Debug, Deserialize)]
pub struct AiListModelsParams {
  pub provider: String,
  #[serde(default)]
  pub api_key: Option<String>,
  #[serde(default)]
  pub base_url: Option<String>,
}

/// 所有供应商 client 都实现了 ModelListingClient，统一走这段提取逻辑。
async fn fetch_model_options<C: ModelListingClient>(client: &C) -> Result<Vec<AiModelOption>, String> {
  let list = client.list_models().await.map_err(shorten_error_message)?;
  let mut items: Vec<AiModelOption> = list
    .data
    .into_iter()
    .map(|m| AiModelOption { id: m.id, name: m.name })
    .collect();
  // 按 id 排序，列表长（如 OpenRouter 数百个）时也好找
  items.sort_by(|a, b| a.id.cmp(&b.id));
  Ok(items)
}

/// 拉取供应商支持的模型列表。密钥 / 地址随参数传入（用设置页当前表单值即可，无需先保存）。
#[tauri::command]
pub async fn ai_list_models(params: AiListModelsParams) -> Result<Vec<AiModelOption>, String> {
  let provider = params.provider.trim().to_string();
  let endpoint = params
    .base_url
    .as_deref()
    .map(str::trim)
    .filter(|u| !u.is_empty())
    .map(normalize_base_url);
  info!(target: "ai", "拉取模型列表开始：provider={}", provider);

  let client = build_client(&provider, &params.api_key, endpoint)?;
  let models = match &client {
    ProviderClient::Anthropic(c) => fetch_model_options(c).await,
    ProviderClient::Gemini(c) => fetch_model_options(c).await,
    ProviderClient::Ollama(c) => fetch_model_options(c).await,
    ProviderClient::OpenAiCompat(c) => fetch_model_options(c).await,
  };
  match &models {
    Ok(list) => info!(target: "ai", "拉取模型列表成功：provider={} 共 {} 个", provider, list.len()),
    Err(err) => error!(target: "ai", "拉取模型列表失败：provider={} {err}", provider),
  }
  models
}

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
    error!(target: "ai", "AI 请求被拒绝：模型 ID 为空（provider={})", provider);
    return Err("尚未配置模型 ID，请到「数据与设置」填写。".to_string());
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

#[cfg(test)]
mod tests {
  use super::{
    build_client, convert_message, convert_tool, default_endpoint_for, exec_model,
    fetch_model_options, normalize_base_url, normalize_gateway_body, tool_call_to_ai, AiChatParams,
    AiMessage, AiStreamEvent, AiToolCall, AiToolDef, ExecMode,
  };
  use rig_core::client::{CompletionClient, ModelListingClient};
  use rig_core::completion::message::{AssistantContent, ToolCall, ToolFunction, UserContent};
  use rig_core::completion::{CompletionRequest, Message};
  use rig_core::model::{Model, ModelList};
  use rig_core::providers::openai;
  use serde_json::{json, Value};

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

  /// build_client：各供应商映射到正确的 client 类型（不发请求，只验证构造）
  #[test]
  fn builds_expected_client_variant_per_provider() {
    use super::ProviderClient;
    let key = || Some("k".to_string());
    assert!(matches!(build_client("ollama", &None, None).unwrap(), ProviderClient::Ollama(_)));
    assert!(matches!(
      build_client("openai", &key(), None).unwrap(),
      ProviderClient::OpenAiCompat(_)
    ));
    assert!(matches!(
      build_client("deepseek", &key(), None).unwrap(),
      ProviderClient::OpenAiCompat(_)
    ));
    assert!(matches!(
      build_client("custom", &key(), Some("https://gw.example/v1".into())).unwrap(),
      ProviderClient::OpenAiCompat(_)
    ));
    assert!(matches!(
      build_client("anthropic", &key(), None).unwrap(),
      ProviderClient::Anthropic(_)
    ));
    assert!(matches!(
      build_client("gemini", &key(), None).unwrap(),
      ProviderClient::Gemini(_)
    ));
  }

  /// build_client：需密钥供应商缺密钥、未知供应商缺地址都要在构造期报错
  #[test]
  fn build_client_rejects_missing_key_or_endpoint() {
    let err = build_client("openai", &None, None).unwrap_err();
    assert!(err.contains("API Key"), "{err}");
    let err = build_client("something-else", &Some("k".to_string()), None).unwrap_err();
    assert!(err.contains("Base URL"), "{err}");
  }

  /// fetch_model_options：按 id 升序输出，供应商给的 name 原样带上
  #[tokio::test]
  async fn fetch_model_options_sorts_by_id() {
    struct Stub;
    impl ModelListingClient for Stub {
      async fn list_models(&self) -> Result<ModelList, rig_core::model::ModelListingError> {
        Ok(ModelList::new(vec![Model::from_id("b-model"), Model::from_id("a-model")]))
      }
    }
    let opts = fetch_model_options(&Stub).await.unwrap();
    let ids: Vec<&str> = opts.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, vec!["a-model", "b-model"]);
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

  /* ---------------------------------------------------------------- */
  /* 网关响应宽容层（2026-10-01「设置 AI 保存未通过」故障的回归覆盖）        */
  /* ---------------------------------------------------------------- */

  /// 故障当时的真实响应体（网关日志原样摘录）：200 成功、内容完好，
  /// 但 `choices[0].message.role` 是空串。
  const GATEWAY_BODY_EMPTY_ROLE: &str = r#"{"id":"cmb-97af7f5fbdaf11f1bfc05e1ce659e06f","model":"deepseek-v4.1-flash","object":"chat.completion","created":1790869728,"choices":[{"index":0,"message":{"role":"","content":"Pong! 🏓\n\nWhat can I help you with today?"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":15,"total_tokens":20,"prompt_tokens_details":{"cached_tokens":0,"text_tokens":0,"audio_tokens":0,"image_tokens":0},"completion_tokens_details":{"text_tokens":0,"audio_tokens":0,"image_tokens":0,"reasoning_tokens":0},"input_tokens":0,"output_tokens":0,"input_tokens_details":null,"claude_cache_creation_5_m_tokens":0,"claude_cache_creation_1_h_tokens":0,"credit":0}}"#;

  /// 空 role 归一化后必须能被 rig 的响应类型解析（这正是故障卡住的那一步）
  #[test]
  fn normalizes_empty_role_into_rig_parseable_body() {
    use rig_core::providers::openai::completion::CompletionResponse as Wire;

    // 归一化前：rig 严格解码必然失败（否则这个故障就不存在了）
    assert!(
      serde_json::from_str::<Wire>(GATEWAY_BODY_EMPTY_ROLE).is_err(),
      "前提校验：原样应当解析失败"
    );

    let fixed = normalize_gateway_body(GATEWAY_BODY_EMPTY_ROLE.as_bytes()).expect("应发生归一化");
    let wire: Wire = serde_json::from_slice(&fixed).expect("归一化后应能被 rig 解析");
    // 内容一字未动
    assert_eq!(wire.id, "cmb-97af7f5fbdaf11f1bfc05e1ce659e06f");
    assert_eq!(wire.model, "deepseek-v4.1-flash");
  }

  /// role 缺失 / null / 纯空白都要补齐；已是合法值则绝不改写
  #[test]
  fn normalizes_only_missing_or_blank_role() {
    let cases = [
      (json!({ "choices": [{ "message": { "content": "hi" } }] }), true),
      (json!({ "choices": [{ "message": { "role": null, "content": "hi" } }] }), true),
      (json!({ "choices": [{ "message": { "role": "  ", "content": "hi" } }] }), true),
      (json!({ "choices": [{ "message": { "role": "", "content": "hi" } }] }), true),
      // 合法值：一个字都不能动
      (json!({ "choices": [{ "message": { "role": "assistant", "content": "hi" } }] }), false),
      // 非空但异常：属于真正的协议问题，应交回 rig 原样报错，不掩盖
      (json!({ "choices": [{ "message": { "role": "user", "content": "hi" } }] }), false),
    ];
    for (body, should_patch) in cases {
      let raw = serde_json::to_vec(&body).unwrap();
      let out = normalize_gateway_body(&raw);
      assert_eq!(out.is_some(), should_patch, "输入 {body} 的归一化判定不符");
      if let Some(bytes) = out {
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["choices"][0]["message"]["role"], "assistant");
        // 只补 role，其余字段保持原样
        assert_eq!(parsed["choices"][0]["message"]["content"], "hi");
      }
    }
  }

  /// 不该碰的输入一律原样放行：错误信封、非 JSON、无 choices、空 role 之外的结构
  #[test]
  fn leaves_unrelated_bodies_untouched() {
    let untouched = [
      r#"{"error":{"message":"rate limited"}}"#,
      r#"{"errors":["boom"]}"#,
      r#"{"choices":[{"message":{"role":""}}],"error":{"message":"x"}}"#,
      r#"not json at all"#,
      r#"{"id":"x","choices":[]}"#,
      r#"{"object":"list","data":[]}"#,
      // 顶层是数组，不是对象
      r#"[{"choices":[{"message":{"role":""}}]}]"#,
    ];
    for raw in untouched {
      assert!(
        normalize_gateway_body(raw.as_bytes()).is_none(),
        "不应改写：{raw}"
      );
    }
  }

  /// 起一个只回一个响应的本机回环 HTTP 服务，返回（base_url, 线程句柄）
  fn spawn_stub_server(body: &str) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
    let port = listener.local_addr().unwrap().port();
    let body = body.to_string();
    let handle = std::thread::spawn(move || {
      let Ok((mut stream, _)) = listener.accept() else {
        return;
      };
      // 读到请求头结束即可（测试用的请求体很小，一次写入就能带全）
      let mut seen = Vec::new();
      let mut chunk = [0u8; 4096];
      while let Ok(n) = stream.read(&mut chunk) {
        if n == 0 {
          break;
        }
        seen.extend_from_slice(&chunk[..n]);
        if seen.windows(4).any(|w| w == b"\r\n\r\n") {
          break;
        }
      }
      let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
      );
      let _ = stream.write_all(response.as_bytes());
      let _ = stream.flush();
    });
    (format!("http://127.0.0.1:{port}/v1"), handle)
  }

  /// 以「ping」请求走一遍真实的 ai_chat 链路（协议转换 + 传输 + 解码）
  fn ping_request() -> (String, String, Option<String>, Option<String>, CompletionRequest) {
    super::prepare_request(AiChatParams {
      provider: "deepseek".to_string(),
      model: "deepseek-v4.1-flash".to_string(),
      api_key: Some("test-key".to_string()),
      base_url: Some("http://127.0.0.1:1/v1".to_string()),
      temperature: None,
      system_prompt: None,
      messages: vec![AiMessage::User { content: "ping".to_string() }],
      tools: vec![],
    })
    .expect("构造请求")
  }

  /// 端到端：挂了宽容层后，空 role 的成功响应要能正常拿到回复文本
  #[tokio::test]
  async fn empty_role_succeeds_with_compat_layer() {
    let (base_url, server) = spawn_stub_server(GATEWAY_BODY_EMPTY_ROLE);
    let (provider, model_name, _key, _endpoint, req) = ping_request();
    let client = openai::CompletionsClient::builder()
      .api_key("test-key")
      .base_url(base_url)
      .http_client(super::GatewayCompatClient::default())
      .build()
      .expect("构造客户端");

    let result = exec_model(
      &client.completion_model(&model_name),
      req,
      &provider,
      &model_name,
      ExecMode::Once,
    )
    .await
    .expect("挂宽容层后应当成功");
    assert!(result.content.contains("Pong!"), "回复内容应被正确解出：{}", result.content);
    assert!(result.tool_calls.is_empty());
    server.join().ok();
  }

  /// 反向对照：不挂宽容层时同一个响应必然报 ProviderResponseError: status 200 OK
  /// ——证明这个回归测试确实能抓住该故障，而不是碰巧通过。
  #[tokio::test]
  async fn empty_role_misreports_as_provider_error_without_compat_layer() {
    let (base_url, server) = spawn_stub_server(GATEWAY_BODY_EMPTY_ROLE);
    let (provider, model_name, _key, _endpoint, req) = ping_request();
    let client = openai::CompletionsClient::builder()
      .api_key("test-key")
      .base_url(base_url)
      .build()
      .expect("构造客户端");

    let err = exec_model(
      &client.completion_model(&model_name),
      req,
      &provider,
      &model_name,
      ExecMode::Once,
    )
    .await
    .expect_err("未挂宽容层时应当复现故障");
    assert!(err.contains("ProviderResponseError"), "应复现原始报错：{err}");
    assert!(err.contains("200"), "报错里应带上被误判的 200 状态：{err}");
    server.join().ok();
  }
}
