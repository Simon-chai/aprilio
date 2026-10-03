/**
 * LLM 传输层（lib 侧）：消息契约 + 桌面端 rig-core 传输。
 *
 * 为什么在 lib：业务 AI（behavior-ai / roster / scores 等）只需要「发一次 chat」，
 * 不该为此依赖 agent 框架。agent 框架通过 src/agent/types.ts 转发这里的核心类型，
 * provider 工厂（含浏览器演示态 mock）仍留在 src/agent/providers —— 分层方向恒为 agent → lib。
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { AiConfig } from "./ai";

/** 传给 LLM 的工具声明（JSON Schema 形式，可序列化后透传给 Rust/rig-core） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
        /** 数组元素 schema（如 file_paths: string[]）；运行时经 JSON 原样透传给模型 */
        items?: { type: string };
      }
    >;
    required?: string[];
  };
}

/** LLM 发起的工具调用 */
export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 消息序列（与 Rust 侧 AiMessage 协议一一对应，serde tag = "role"）。
 * - assistant 携带 toolCalls 表示模型发起了调用
 * - tool 消息是把工具结果回喂给模型
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPayload[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** LLM 单轮响应 */
export interface LlmResponse {
  /** 助手文本（可能为空，比如只发起工具调用时） */
  content: string;
  toolCalls: ToolCallPayload[];
}

/** LLM 抽象：调用方只依赖这个接口，方便 mock / 日后换实现 */
export interface AgentLlm {
  chat(req: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
    config: AiConfig;
    /** 流式回调：助手文本增量（Rust Channel 推送 / mock 整段模拟）。可缺省 */
    onDelta?: (text: string) => void;
  }): Promise<LlmResponse>;
}

/** Rust 侧 AiChatResult 的返回结构 */
interface AiChatResult {
  content: string;
  tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** Rust 侧 AiStreamEvent（tag = "type"） */
type AiStreamEvent = { type: "delta"; text: string };

/**
 * 桌面端传输 —— LLM 请求经 Rust 侧 rig-core 发出（多供应商 + 密钥不出本机）。
 * Rust 命令 ai_chat_stream 负责协议转换：工具定义 → rig ToolDefinition，
 * 助手文本增量经 ipc::Channel 逐段推送（事件 { type: "delta" }），最终结果随返回值给出。
 */
export function tauriLlm(): AgentLlm {
  return {
    async chat({ system, messages, tools, config, onDelta }): Promise<LlmResponse> {
      const channel = new Channel<AiStreamEvent>();
      if (onDelta) {
        channel.onmessage = (event) => {
          if (event.type === "delta" && event.text) onDelta(event.text);
        };
      }

      const result = await invoke<AiChatResult>("ai_chat_stream", {
        onDelta: channel,
        params: {
          provider: config.provider,
          model: config.model,
          api_key: config.apiKey.trim() || null,
          base_url: config.baseUrl.trim() || null,
          temperature: config.temperature,
          system_prompt: system,
          messages: messages.map((m) =>
            m.role === "assistant"
              ? { role: m.role, content: m.content, toolCalls: m.toolCalls ?? [] }
              : m,
          ),
          tools: tools.map(
            (t: ToolDefinition): { name: string; description: string; schema: ToolDefinition["parameters"] } => ({
              name: t.name,
              description: t.description,
              schema: t.parameters,
            }),
          ),
        },
      });

      return {
        content: result.content,
        toolCalls: (result.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments ?? {},
        })),
      };
    },
  };
}
