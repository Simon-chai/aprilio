/**
 * Tauri Provider —— LLM 请求经 Rust 侧 rig-core 发出（多供应商 + 密钥不出本机）。
 * Rust 命令 ai_chat_stream 负责协议转换：工具定义 → rig ToolDefinition，
 * 助手文本增量经 ipc::Channel 逐段推送（事件 { type: "delta" }），最终结果随返回值给出。
 */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { AgentLlm, LlmResponse, ToolDefinition } from "../types";

/** Rust 侧 AiChatResult 的返回结构 */
interface AiChatResult {
  content: string;
  tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** Rust 侧 AiStreamEvent（tag = "type"） */
type AiStreamEvent = { type: "delta"; text: string };

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
