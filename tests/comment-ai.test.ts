import { describe, expect, it } from "vitest";
import {
  buildBehaviorSummary,
  buildScoreSummary,
  generateTermComment,
  parseTermComment,
} from "../src/lib/comment-ai";
import type { AgentLlm, LlmResponse } from "../src/agent/types";

describe("parseTermComment", () => {
  it("strips quotes, prefixes and trims", () => {
    expect(parseTermComment("「本学期表现优秀，继续保持。」")).toBe("本学期表现优秀，继续保持。");
    expect(parseTermComment("评语：踏实认真")).toBe("踏实认真");
  });

  it("truncates over-long output", () => {
    const long = "很".repeat(300);
    expect(parseTermComment(long).length).toBe(200);
  });
});

describe("buildScoreSummary", () => {
  it("uses the latest exam subjects and total range", () => {
    const summary = buildScoreSummary([
      {
        exam_name: "期中",
        subjects: [
          { subject: "语文", score: 80, grade: null },
          { subject: "数学", score: 90, grade: null },
        ],
      },
      {
        exam_name: "期末",
        subjects: [
          { subject: "语文", score: 85, grade: null },
          { subject: "数学", score: 95, grade: null },
        ],
      },
    ]);
    expect(summary).toContain("期末：语文 85、数学 95");
    expect(summary).toContain("总分 170~180");
  });

  it("returns empty string when no rows", () => {
    expect(buildScoreSummary([])).toBe("");
  });
});

describe("buildBehaviorSummary", () => {
  it("groups by polarity and labels them", () => {
    const summary = buildBehaviorSummary([
      { type: "praise", dimension_name_snap: "课堂表现", comment: "发言积极" },
      { type: "improve", dimension_name_snap: "作业情况", comment: "字迹潦草" },
    ]);
    expect(summary).toContain("表扬：课堂表现：发言积极");
    expect(summary).toContain("待改进：作业情况：字迹潦草");
  });

  it("returns empty string when no rows", () => {
    expect(buildBehaviorSummary([])).toBe("");
  });
});

describe("generateTermComment degradation", () => {
  const ctx = {
    studentName: "林知远",
    semester: "2026-2027-1",
    gradeClass: "三年级二班",
    scoreSummary: "期末：语文 90",
    behaviorSummary: "表扬：课堂表现：发言积极",
  };

  it("returns null when AI is not ready (手工兜底)", async () => {
    const result = await generateTermComment(ctx, { aiReady: false });
    expect(result).toBeNull();
  });

  it("returns null when the model call throws", async () => {
    const llm: AgentLlm = {
      chat: async (): Promise<LlmResponse> => {
        throw new Error("network down");
      },
    };
    const result = await generateTermComment(ctx, { aiReady: true, llm });
    expect(result).toBeNull();
  });

  it("returns cleaned draft when AI is ready", async () => {
    const llm: AgentLlm = {
      chat: async (): Promise<LlmResponse> => ({
        content: "「该生本学期学习踏实，成绩稳步提升，望继续保持。」",
        toolCalls: [],
      }),
    };
    const result = await generateTermComment(ctx, { aiReady: true, llm });
    expect(result).toBe("该生本学期学习踏实，成绩稳步提升，望继续保持。");
  });
});
