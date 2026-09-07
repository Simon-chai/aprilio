import { describe, expect, it } from "vitest";
import { parseAiComments, recommendComments } from "../src/lib/behavior-ai";
import type { AgentLlm } from "../src/agent/types";
import type { RecommendContext } from "../src/lib/behavior-ai";

describe("parseAiComments", () => {
  it("strips numbering, bullets and quotes; dedupes and skips blanks", () => {
    const raw = "1. 课堂听讲专注\n2、积极举手发言\n· 课堂听讲专注\n「带动小组讨论」\n\nfourth line";
    expect(parseAiComments(raw, 10)).toEqual([
      "课堂听讲专注",
      "积极举手发言",
      "带动小组讨论",
      "fourth line",
    ]);
  });

  it("truncates overlong lines to 25 chars and caps the count", () => {
    const long = "一".repeat(30);
    const out = parseAiComments(`${long}\n第二条\n第三条`, 2);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(25);
    expect(out[1]).toBe("第二条");
  });
});

describe("recommendComments", () => {
  const ctx: RecommendContext = {
    studentName: "陈嘉树",
    dimensionName: "课堂表现",
    polarity: "praise",
    frequent: ["积极举手发言", "课堂互动表现优异"],
  };

  it("falls back to frequent presets when AI is not ready", async () => {
    const res = await recommendComments(ctx, { aiReady: false });
    expect(res.source).toBe("preset");
    expect(res.items).toEqual(["积极举手发言", "课堂互动表现优异"]);
  });

  it("uses AI output when the injected llm returns parsable content", async () => {
    const llm: AgentLlm = {
      chat: async () => ({
        content: "1. 听讲专注，能主动质询\n2. 带动同桌一起思考",
        toolCalls: [],
      }),
    };
    const res = await recommendComments(ctx, { aiReady: true, llm });
    expect(res.source).toBe("ai");
    expect(res.items).toEqual(["听讲专注，能主动质询", "带动同桌一起思考"]);
  });

  it("falls back when the llm throws or returns junk", async () => {
    const throwing: AgentLlm = {
      chat: async () => {
        throw new Error("boom");
      },
    };
    expect((await recommendComments(ctx, { aiReady: true, llm: throwing })).source).toBe("preset");

    const junk: AgentLlm = { chat: async () => ({ content: "", toolCalls: [] }) };
    const res = await recommendComments(ctx, { aiReady: true, llm: junk });
    expect(res.source).toBe("preset");
    expect(res.items).toEqual(["积极举手发言", "课堂互动表现优异"]);
  });
});
