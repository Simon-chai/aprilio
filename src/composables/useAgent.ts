/**
 * useAgent —— Agent 框架的 Vue 集成层。
 *
 * 负责：会话视图状态（用户消息 / 助手回复 / 工具卡片）、发送流程、
 * 把 runAgentTurn 的事件流实时映射到 UI。
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { createLlm } from "../agent/providers";
import { runAgentTurn } from "../agent/loop";
import { buildCapabilityContainer, ensureRustCapabilities } from "../agent/manifest";
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
  ui_action: "页面动作",
};

/** 容器装载后工具名 → 中文名；扫描产物自带 label，未匹配的落到静态表或工具名 */
function buildToolLabels(containerTools: { definition: { name: string }; label?: string }[]): Record<string, string> {
  const labels: Record<string, string> = { ...TOOL_LABELS };
  for (const tool of containerTools) {
    if (tool.label) labels[tool.definition.name] = tool.label;
  }
  return labels;
}

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
    case "ui_action": {
      const confirm = args.confirm === true ? " · 已确认" : "";
      return `${String(args.page ?? "")}/${String(args.action ?? "")}${confirm}`;
    }
    case "import_student_roster": {
      const confirm = args.confirm === true ? " · 已确认" : "";
      const file = args.file_path ? String(args.file_path).split(/[\\/]/).pop() : "选择文件";
      const column = args.name_column ? ` · 姓名列「${String(args.name_column)}」` : "";
      return `${file}${column}${confirm}`;
    }
    case "semantic_search":
      return `「${String(args.query ?? "")}」`;
    case "rag_reindex":
      return String(args.model ?? "bge-m3");
    case "photos_dir":
      return "查询存储目录";
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

  /** 工具卡片中文名：容器装载时取一次（能力清单变化时重建会话自然取新值） */
  let toolLabels = { ...TOOL_LABELS };

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
        label: toolLabels[call.name] ?? call.name,
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

  /** 流式期间的「进行中」助手条目下标；工具调用开始时置空，下一轮文本重新开条目 */
  let liveAssistant: number | null = null;

  function appendDelta(text: string) {
    const idx = liveAssistant;
    if (idx !== null && items.value[idx]?.kind === "assistant") {
      items.value[idx].text += text;
      return;
    }
    liveAssistant = items.value.length;
    items.value.push({ kind: "assistant", text });
  }

  /** 收尾：把流式条目的文本对齐为最终回复（处理 trim / 空回复兜底的差异） */
  function settleStreamedReply(reply: string) {
    const idx = liveAssistant;
    liveAssistant = null;
    if (idx !== null && items.value[idx]?.kind === "assistant") {
      items.value[idx].text = reply;
    } else {
      items.value.push({ kind: "assistant", text: reply });
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
    liveAssistant = null;

    try {
      await ensureRustCapabilities(); // 桌面端启动后拉一次 Rust 执行面能力（后续走缓存）
      const container = buildCapabilityContainer();
      toolLabels = buildToolLabels(container.allTools());
      const ctx = { router };
      const registry = container.registry(ctx);
      const turn = await runAgentTurn({
        userText: trimmed,
        history: history.value,
        registry,
        llm: createLlm(),
        config,
        ctx,
        currentRoute: String(route.name ?? ""),
        onEvent: (event) => {
          if (event.type === "text-delta") appendDelta(event.text);
          if (event.type === "tool-start") {
            liveAssistant = null; // 本轮文本已定格，下一轮增量另开条目
            upsertToolItem(event.call);
          }
          if (event.type === "tool-end") upsertToolItem(event.call, event.result);
        },
      });

      pushHistory(turn.messages);
      settleStreamedReply(turn.reply);
    } catch (e) {
      // 完整错误落日志；界面展示友好化文案。空的流式条目清掉，有部分文本则保留
      logError("Agent 执行失败", e);
      if (liveAssistant !== null) {
        const item = items.value[liveAssistant];
        if (item?.kind === "assistant" && !item.text) items.value.splice(liveAssistant, 1);
      }
      liveAssistant = null;
      error.value = aiErrorMessage(e);
    } finally {
      sending.value = false;
    }
  }

  function clear() {
    items.value = [];
    history.value = [];
    error.value = "";
    liveAssistant = null;
  }

  return { items, sending, error, aiReady, canSend, send, clear };
}
