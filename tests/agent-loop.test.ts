import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createToolRegistry } from "../src/agent/registry";
import { runAgentTurn } from "../src/agent/loop";
import type { AgentEvent, AgentLlm, AgentTool, LlmResponse } from "../src/agent/types";
import { DEFAULT_AI_CONFIG } from "../src/lib/ai";

const Blank = defineComponent({ render: () => null });

async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/home", name: "home", component: Blank },
      { path: "/students", name: "students", component: Blank },
      { path: "/students/:id", name: "student-detail", component: Blank, props: true },
    ],
  });
  await router.push("/home");
  await router.isReady();
  return router;
}

/** 按脚本逐轮返回的 LLM 替身，同时记录每轮收到的请求 */
function scriptedLlm(steps: LlmResponse[]) {
  let i = 0;
  const seen: { system: string; messageRoles: string[]; toolCount: number }[] = [];
  const llm: AgentLlm = {
    async chat({ system, messages, tools }) {
      seen.push({
        system,
        messageRoles: messages.map((m) => m.role),
        toolCount: tools.length,
      });
      return steps[Math.min(i++, steps.length - 1)];
    },
  };
  return { llm, seen };
}

const throwingTool: AgentTool = {
  definition: {
    name: "boom",
    description: "总会抛异常的工具",
    parameters: { type: "object", properties: {}, required: [] },
  },
  execute: async () => {
    throw new Error("数据库炸了");
  },
};

describe("runAgentTurn", () => {
  it("executes tool calls, feeds results back and returns the final reply", async () => {
    const router = await makeRouter();
    const { llm, seen } = scriptedLlm([
      { content: "", toolCalls: [{ id: "c1", name: "navigate", arguments: { target: "students" } }] },
      { content: "已打开学生档案，需要我查点什么吗？", toolCalls: [] },
    ]);

    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      userText: "打开学生列表",
      history: [],
      registry: createToolRegistry([ (await import("../src/agent/tools/navigation")).default ]),
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: { router },
      currentRoute: "home",
      onEvent: (e) => events.push(e),
    });

    expect(result.reply).toBe("已打开学生档案，需要我查点什么吗？");
    expect(router.currentRoute.value.name).toBe("students");

    // 消息序列：user → assistant(toolCalls) → tool → assistant(final)
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(result.messages[2]).toMatchObject({ role: "tool", toolCallId: "c1", name: "navigate" });
    expect((result.messages[2] as { content: string }).content).toContain("已打开「学生档案」页面");

    expect(result.toolRuns).toHaveLength(1);
    expect(result.toolRuns[0].result.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["tool-start", "tool-end"]);

    // LLM 第二轮应收到 system prompt 与回喂后的完整消息
    expect(seen[1].messageRoles).toEqual(["user", "assistant", "tool"]);
    expect(seen[0].system).toContain("学生档案"); // currentRoute=home → 「首页」在 NAV_TARGETS；system 含准则
    expect(seen[0].system).toContain("工具使用准则");
  });

  it("reports unknown tools back to the model instead of crashing", async () => {
    const router = await makeRouter();
    const { llm } = scriptedLlm([
      { content: "", toolCalls: [{ id: "c1", name: "launch_missiles", arguments: {} }] },
      { content: "抱歉，我没有这个能力。", toolCalls: [] },
    ]);

    const result = await runAgentTurn({
      userText: "发射",
      history: [],
      registry: createToolRegistry([]),
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: { router },
      currentRoute: "home",
    });

    expect(result.toolRuns[0].result.ok).toBe(false);
    expect(result.toolRuns[0].result.error).toContain("未知工具");
    expect((result.messages[2] as { content: string }).content).toContain("未知工具");
    expect(result.reply).toBe("抱歉，我没有这个能力。");
  });

  it("keeps the loop alive when a tool throws", async () => {
    const router = await makeRouter();
    const { llm } = scriptedLlm([
      { content: "", toolCalls: [{ id: "c1", name: "boom", arguments: {} }] },
      { content: "工具出错了，我如实说明。", toolCalls: [] },
    ]);

    const result = await runAgentTurn({
      userText: "测试",
      history: [],
      registry: createToolRegistry([throwingTool]),
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: { router },
      currentRoute: "home",
    });

    expect(result.toolRuns[0].result.ok).toBe(false);
    expect(result.toolRuns[0].result.error).toBe("数据库炸了");
    expect(result.reply).toContain("如实说明");
  });

  it("stops after maxRounds of endless tool calls", async () => {
    const router = await makeRouter();
    const endless: LlmResponse = {
      content: "",
      toolCalls: [{ id: "c1", name: "navigate", arguments: { target: "students" } }],
    };
    const { llm } = scriptedLlm([endless]);

    const result = await runAgentTurn({
      userText: "循环",
      history: [],
      registry: createToolRegistry([(await import("../src/agent/tools/navigation")).default]),
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: { router },
      currentRoute: "home",
      maxRounds: 2,
    });

    expect(result.reply).toContain("上限");
    expect(result.toolRuns).toHaveLength(2);
  });

  it("forwards text deltas as events in streaming order", async () => {
    const router = await makeRouter();
    const deltas: string[] = [];
    const llm: AgentLlm = {
      async chat({ onDelta }) {
        onDelta?.("先查");
        onDelta?.("一下");
        return { content: "先查一下", toolCalls: [] };
      },
    };

    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      userText: "你好",
      history: [],
      registry: createToolRegistry([]),
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: { router },
      currentRoute: "home",
      onEvent: (e) => events.push(e),
    });

    expect(result.reply).toBe("先查一下");
    // delta 事件先于最终回复定稿，文本按序拼接
    expect(events.map((e) => (e.type === "text-delta" ? e.text : `<${e.type}>`))).toEqual([
      "先查",
      "一下",
    ]);
  });
});
