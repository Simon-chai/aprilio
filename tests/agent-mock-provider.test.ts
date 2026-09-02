import { describe, expect, it } from "vitest";
import { mockLlm } from "../src/agent/providers/mock";
import type { AgentMessage } from "../src/agent/types";

describe("mock provider (浏览器演示态规则解析)", () => {
  it("maps navigation phrases to the navigate tool", async () => {
    const llm = mockLlm();
    const res = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "帮我打开学生列表" }],
      tools: [],
      config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" },
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("navigate");
    expect(res.toolCalls[0].arguments.target).toBe("students");
  });

  it("maps counting questions to stats queries", async () => {
    const llm = mockLlm();
    const res = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "现在有几个学生？" }],
      tools: [],
      config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" },
    });
    expect(res.toolCalls[0]).toMatchObject({ name: "query_data", arguments: { entity: "stats" } });
  });

  it("extracts quoted names for student queries", async () => {
    const llm = mockLlm();
    const res = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "查一下林知远的资料" }],
      tools: [],
      config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" },
    });
    expect(res.toolCalls[0].name).toBe("query_data");
    expect(res.toolCalls[0].arguments.entity).toBe("students");
    expect(res.toolCalls[0].arguments.keyword).toBe("林知远");
  });

  it("routes help questions to doc search", async () => {
    const llm = mockLlm();
    const res = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "日志文件在哪里，怎么排查问题" }],
      tools: [],
      config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" },
    });
    expect(res.toolCalls[0].name).toBe("find_docs");
  });

  it("summarizes after tool results have been fed back", async () => {
    const llm = mockLlm();
    const messages: AgentMessage[] = [
      { role: "user", content: "打开学生列表" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "navigate", arguments: { target: "students" } }] },
      { role: "tool", toolCallId: "c1", name: "navigate", content: "已打开「学生档案」页面。" },
    ];
    const res = await llm.chat({ system: "", messages, tools: [], config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" } });
    expect(res.toolCalls).toHaveLength(0);
    expect(res.content).toContain("已打开");
  });

  it("falls back to a capability intro for unmatched input", async () => {
    const llm = mockLlm();
    const res = await llm.chat({
      system: "",
      messages: [{ role: "user", content: "你好呀" }],
      tools: [],
      config: { provider: "mock", model: "mock", apiKey: "", baseUrl: "", temperature: 0, systemPrompt: "" },
    });
    expect(res.toolCalls).toHaveLength(0);
    expect(res.content).toContain("演示态");
  });
});
