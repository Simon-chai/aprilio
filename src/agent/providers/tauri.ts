/**
 * Tauri Provider —— LLM 请求经 Rust 侧 genai 发出（多供应商 + 密钥不出本机）。
 * Rust 命令 ai_chat 负责协议转换：工具定义 → genai Tool，tool_calls → 回传 TS。
 */
import { invoke } from "@tauri-apps/api/core";
import type { AgentLlm, LlmResponse, ToolDefinition } from "../types";

/** Rust 侧 AiChatResult 的返回结构 */
interface AiChatResult {
  content: string;
  tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
}

export function tauriLlm(): AgentLlm {
  return {
    async chat({ system, messages, tools, config }): Promise<LlmResponse> {
      const result = await invoke<AiChatResult>("ai_chat", {
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
