/**
 * useAgent —— Agent 框架的 Vue 集成层。
 *
 * 负责：会话视图状态（用户消息 / 助手回复 / 工具卡片）、发送流程、
 * 把 runAgentTurn 的事件流实时映射到 UI。
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { createLlm } from "../agent/providers";
import { defaultAgentTools, createToolRegistry } from "../agent/registry";
import { runAgentTurn } from "../agent/loop";
import type { AgentMessage, ToolCallPayload, ToolResult } from "../agent/types";
import { isAiConfigured, loadAiConfig, aiErrorMessage, type AiConfig } from "../lib/ai";
import { logError } from "../lib/logger";

/** 聊天面板的一条可见内容 */
export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      label: string;
      detail: string;
      status: "running" | "done" | "failed";
      result?: ToolResult;
    };

const TOOL_LABELS: Record<string, string> = {
  navigate: "界面跳转",
  query_data: "数据查询",
  find_docs: "文档检索",
};

/** 工具卡片的参数摘要：一行说清楚这次调用要干什么 */
function toolDetail(call: ToolCallPayload): string {
  const args = call.arguments ?? {};
  switch (call.name) {
    case "navigate": {
      const target = String(args.target ?? "");
      const suffix = args.student_id !== undefined ? ` · 学生 #${String(args.student_id)}` : "";
      return `→ ${target}${suffix}`;
    }
    case "query_data": {
      const parts: string[] = [String(args.entity ?? "")];
      if (args.keyword) parts.push(`关键词「${String(args.keyword)}」`);
      if (args.grade_class) parts.push(`班级「${String(args.grade_class)}」`);
      if (args.student_id !== undefined) parts.push(`学生 #${String(args.student_id)}`);
      return parts.join(" · ");
    }
    case "find_docs":
      return `关键词「${String(args.keywords ?? "")}」`;
    default:
      return JSON.stringify(args);
  }
}

/** 会话历史保留最近 N 条消息（含工具轮次），防止上下文无限膨胀 */
const MAX_HISTORY = 24;

export function useAgent() {
  const route = useRoute();
  const router = useRouter();

  const items = ref<ChatItem[]>([]);
  const sending = ref(false);
  const error = ref("");
  const history = ref<AgentMessage[]>([]);

  const aiReady = computed(() => isAiConfigured(loadAiConfig()));
  const canSend = computed(() => !sending.value);

  function pushHistory(messages: AgentMessage[]) {
    history.value = [...history.value, ...messages].slice(-MAX_HISTORY);
  }

  function upsertToolItem(call: ToolCallPayload, result?: ToolResult) {
    const idx = items.value.findIndex((it) => it.kind === "tool" && it.id === call.id);
    if (idx < 0) {
      items.value.push({
        kind: "tool",
        id: call.id,
        name: call.name,
        label: TOOL_LABELS[call.name] ?? call.name,
        detail: toolDetail(call),
        status: result ? (result.ok ? "done" : "failed") : "running",
        result,
      });
      return;
    }
    const item = items.value[idx];
    if (item.kind === "tool" && result) {
      item.status = result.ok ? "done" : "failed";
      item.result = result;
    }
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || sending.value) return;

    const config: AiConfig = loadAiConfig();
    if (!isAiConfigured(config)) {
      error.value = "还没有配置 AI 模型——到「数据与设置」选择供应商，填好模型名和密钥。";
      return;
    }

    error.value = "";
    items.value.push({ kind: "user", text: trimmed });
    sending.value = true;

    try {
      const registry = createToolRegistry(defaultAgentTools());
      const turn = await runAgentTurn({
        userText: trimmed,
        history: history.value,
        registry,
        llm: createLlm(),
        config,
        ctx: { router },
        currentRoute: String(route.name ?? ""),
        onEvent: (event) => {
          if (event.type === "tool-start") upsertToolItem(event.call);
          if (event.type === "tool-end") upsertToolItem(event.call, event.result);
        },
      });

      pushHistory(turn.messages);
      items.value.push({ kind: "assistant", text: turn.reply });
    } catch (e) {
      // 完整错误落日志；界面展示友好化文案
      logError("Agent 执行失败", e);
      error.value = aiErrorMessage(e);
    } finally {
      sending.value = false;
    }
  }

  function clear() {
    items.value = [];
    history.value = [];
    error.value = "";
  }

  return { items, sending, error, aiReady, canSend, send, clear };
}
