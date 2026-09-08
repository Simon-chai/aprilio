import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_COMMENT_CACHE_TTL_MS,
  clearCommentCache,
  parseAiComments,
  recommendComments,
  writeCachedComments,
} from "../src/lib/behavior-ai";
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

  beforeEach(() => clearCommentCache());

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

  it("sends a distinct, polarity-specific prompt for each polarity", async () => {
    const prompts: string[] = [];
    const llm: AgentLlm = {
      chat: async (req) => {
        prompts.push(req.messages.map((m) => String(m.content)).join("\n"));
        return { content: "占位评语", toolCalls: [] };
      },
    };

    for (const polarity of ["praise", "improve", "neutral"] as const) {
      await recommendComments({ ...ctx, polarity }, { aiReady: true, llm });
    }

    expect(prompts).toHaveLength(3);
    // 三种倾向的提示词必须互不相同，避免模型对任何倾向都产出同一批评语
    expect(new Set(prompts).size).toBe(3);
    expect(prompts[0]).toContain("表扬");
    expect(prompts[1]).toContain("待改进");
    expect(prompts[2]).toContain("中立");
    // 待改进必须显式禁止表扬措辞，中立必须要求客观陈述
    expect(prompts[1]).toContain("禁止");
    expect(prompts[2]).toContain("客观");
  });

  it("reuses the cached batch for the same dimension and polarity without calling the model again", async () => {
    let calls = 0;
    const llm: AgentLlm = {
      chat: async () => {
        calls += 1;
        return { content: `第${calls}批评语`, toolCalls: [] };
      },
    };

    const first = await recommendComments(ctx, { aiReady: true, llm });
    expect(first.source).toBe("ai");
    expect(calls).toBe(1);

    // 来回切倾向卡片：命中缓存，不再消耗 token
    const again = await recommendComments(ctx, { aiReady: true, llm });
    expect(again.items).toEqual(first.items);
    expect(calls).toBe(1);

    // 换学生也复用同一批（缓存按「维度 + 倾向」共享）
    const otherStudent = await recommendComments(
      { ...ctx, studentName: "苏晚" },
      { aiReady: true, llm }
    );
    expect(otherStudent.items).toEqual(first.items);
    expect(calls).toBe(1);

    // 不同倾向各自独立缓存
    await recommendComments({ ...ctx, polarity: "improve" }, { aiReady: true, llm });
    expect(calls).toBe(2);
  });

  it("regenerates once the cache TTL expires", async () => {
    let calls = 0;
    const llm: AgentLlm = {
      chat: async () => {
        calls += 1;
        return { content: `第${calls}批评语`, toolCalls: [] };
      },
    };

    const first = await recommendComments(ctx, { aiReady: true, llm });
    // 把缓存时间改到 TTL 之前，模拟「隔了几天」
    writeCachedComments(ctx, first.items, Date.now() - AI_COMMENT_CACHE_TTL_MS - 1);

    const second = await recommendComments(ctx, { aiReady: true, llm });
    expect(calls).toBe(2);
    expect(second.items).not.toEqual(first.items);
  });

  it("can bypass the cache explicitly", async () => {
    let calls = 0;
    const llm: AgentLlm = {
      chat: async () => {
        calls += 1;
        return { content: `第${calls}批评语`, toolCalls: [] };
      },
    };

    await recommendComments(ctx, { aiReady: true, llm });
    await recommendComments(ctx, { aiReady: true, llm, useCache: false });
    expect(calls).toBe(2);
  });
});
