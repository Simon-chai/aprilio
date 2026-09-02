/**
 * Agent 执行循环（tool-calling loop）。
 *
 * 用户一句话进来后：
 *   构造 system prompt → LLM → 有 tool_calls 就执行工具并回喂 → 再问 LLM → …
 * 直到模型给出最终回复，或达到轮次上限。
 *
 * 工具执行失败不会中断循环：错误以 tool 消息回喂，由模型决定如何向用户解释。
 */
import { buildSystemPrompt } from "./prompt";
import type { ToolRegistry } from "./registry";
import type {
  AgentEvent,
  AgentLlm,
  AgentMessage,
  AgentToolContext,
  AgentTurnResult,
  ToolCallPayload,
  ToolDefinition,
  ToolResult,
  ToolRunRecord,
} from "./types";
import type { AiConfig } from "../lib/ai";

export interface AgentTurnOptions {
  userText: string;
  /** 既有会话历史（不含本次输入） */
  history: AgentMessage[];
  registry: ToolRegistry;
  llm: AgentLlm;
  config: AiConfig;
  ctx: AgentToolContext;
  /** 当前路由名，注入 system prompt */
  currentRoute: string;
  /** 工具调用轮次上限，防御死循环 */
  maxRounds?: number;
  onEvent?: (event: AgentEvent) => void;
}

const DEFAULT_MAX_ROUNDS = 6;
const STALL_REPLY =
  "这一轮的操作步骤达到了上限，我先停下来了。可以把需求拆成几步分别告诉我。";

export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { userText, history, registry, llm, config, ctx, currentRoute, onEvent } = options;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const messages: AgentMessage[] = [...history, { role: "user", content: userText }];
  const toolRuns: ToolRunRecord[] = [];
  const tools: ToolDefinition[] = registry.definitions();
  const system = buildSystemPrompt(currentRoute, config.systemPrompt);

  for (let round = 0; round < maxRounds; round++) {
    const res = await llm.chat({ system, messages, tools, config });

    if (res.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        onEvent?.({ type: "tool-start", call });

        const result = await executeTool(registry, call, ctx);
        toolRuns.push({ call, result });
        onEvent?.({ type: "tool-end", call, result });

        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: result.ok ? result.summary : `执行失败：${result.error ?? "未知原因"}`,
        });
      }
      continue;
    }

    const reply = res.content.trim() || "（模型返回了空回复）";
    messages.push({ role: "assistant", content: reply });
    return { reply, messages, toolRuns };
  }

  messages.push({ role: "assistant", content: STALL_REPLY });
  return { reply: STALL_REPLY, messages, toolRuns };
}

/** 单个工具执行，异常收敛为失败的 ToolResult */
async function executeTool(
  registry: ToolRegistry,
  call: ToolCallPayload,
  ctx: AgentToolContext,
): Promise<ToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    const names = registry.list().map((t) => t.definition.name).join("、");
    return { ok: false, summary: "", error: `未知工具 "${call.name}"，可用工具：${names}。` };
  }
  try {
    return await tool.execute(call.arguments ?? {}, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, summary: "", error: message };
  }
}
