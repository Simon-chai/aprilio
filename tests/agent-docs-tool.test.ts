import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import findDocsTool from "../src/agent/tools/docs";

const tool = findDocsTool;
const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

describe("find_docs tool", () => {
  it("finds fragments across project docs", async () => {
    const result = await tool.execute({ keywords: "genai" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("找到");
    // genai → rig 迁移是当前技术栈方案的核心主题，应命中该文档
    expect(result.summary).toContain("AGENT_FRAMEWORK_EVALUATION.md");
    expect((result.data as { doc: { file: string } }[]).every((f) => f.doc.file.endsWith(".md"))).toBe(
      true,
    );
  });

  it("indexes the agent guide itself so the assistant can self-describe", async () => {
    const result = await tool.execute({ keywords: "工具 扩展" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("AGENT.md");
  });

  it("supports multiple keywords and limit", async () => {
    const result = await tool.execute({ keywords: "genai 工具", limit: 3 }, ctx);
    expect((result.data as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it("reports empty hits gracefully", async () => {
    const result = await tool.execute({ keywords: "量子纠缠xyz" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("没有找到");
    expect(result.data).toEqual([]);
  });

  it("rejects empty keywords", async () => {
    const result = await tool.execute({ keywords: "  " }, ctx);
    expect(result.ok).toBe(false);
  });
});
