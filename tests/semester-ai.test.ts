import { describe, expect, it } from "vitest";
import {
  applyInferredClassMeta,
  extractSemesterFromText,
  inferGradeSemester,
  parseGradeSemesterReply,
} from "../src/lib/semester-ai";
import { createClass, deleteClass, getClassMeta, saveClassMeta } from "../src/lib/db";
import type { AgentLlm, LlmResponse } from "../src/agent/types";

describe("extractSemesterFromText", () => {
  it("parses 秋季 / 春季 with a year", () => {
    expect(extractSemesterFromText("2026年秋季期中成绩单")).toBe("2026-2027-1");
    expect(extractSemesterFromText("2025-2026学年春季学期花名册")).toBe("2025-2026-2");
  });

  it("parses 第一学期 / 第二学期 with an academic year", () => {
    expect(extractSemesterFromText("2026学年第一学期")).toBe("2026-2027-1");
    expect(extractSemesterFromText("2025-2026学年第二学期")).toBe("2025-2026-2");
  });

  it("returns null when no semester hint", () => {
    expect(extractSemesterFromText("三年级二班")).toBeNull();
  });
});

describe("parseGradeSemesterReply", () => {
  it("parses JSON reply", () => {
    expect(parseGradeSemesterReply('{"grade": 3, "semester": "2026-2027-1"}')).toEqual({
      grade: 3,
      semester: "2026-2027-1",
    });
  });

  it("ignores out-of-range grade and malformed semester", () => {
    expect(parseGradeSemesterReply('{"grade": 9, "semester": "随便"}')).toEqual({
      grade: null,
      semester: null,
    });
  });

  it("returns nulls on non-JSON", () => {
    expect(parseGradeSemesterReply("无法判断")).toEqual({ grade: null, semester: null });
  });
});

describe("inferGradeSemester", () => {
  it("uses rules first without calling the model", async () => {
    let called = false;
    const llm: AgentLlm = {
      chat: async (): Promise<LlmResponse> => {
        called = true;
        return { content: "{}", toolCalls: [] };
      },
    };
    const result = await inferGradeSemester(["三年级二班 2026年秋季花名册"], {
      aiReady: true,
      llm,
    });
    expect(result).toEqual({ grade: 3, semester: "2026-2027-1", method: "rule" });
    expect(called).toBe(false);
  });

  it("falls back to AI when rules find nothing", async () => {
    const llm: AgentLlm = {
      chat: async (): Promise<LlmResponse> => ({
        content: '{"grade": 2, "semester": "2025-2026-2"}',
        toolCalls: [],
      }),
    };
    const result = await inferGradeSemester(["阳光班名单"], { aiReady: true, llm });
    expect(result).toEqual({ grade: 2, semester: "2025-2026-2", method: "ai" });
  });

  it("returns nulls without AI when rules find nothing", async () => {
    const result = await inferGradeSemester(["阳光班名单"], { aiReady: false });
    expect(result).toEqual({ grade: null, semester: null, method: "rule" });
  });

  it("degrades silently when the model call throws", async () => {
    const llm: AgentLlm = {
      chat: async (): Promise<LlmResponse> => {
        throw new Error("network down");
      },
    };
    const result = await inferGradeSemester(["阳光班名单"], { aiReady: true, llm });
    expect(result).toEqual({ grade: null, semester: null, method: "rule" });
  });
});

describe("applyInferredClassMeta", () => {
  const CLASS = "AI识别测试班";

  it("writes inferred grade/semester only when not already set", async () => {
    await createClass(CLASS);
    try {
      const guess = await applyInferredClassMeta(CLASS, ["三年级二班 2026年秋季花名册"], {
        aiReady: false,
      });
      expect(guess).toMatchObject({ grade: 3, semester: "2026-2027-1" });
      expect(await getClassMeta(CLASS)).toMatchObject({
        entry_grade: 3,
        entry_semester: "2026-2027-1",
      });

      // 已有值不覆盖
      await saveClassMeta(CLASS, { entry_grade: 5, entry_semester: "2024-2025-1" });
      await applyInferredClassMeta(CLASS, ["三年级二班 2026年秋季花名册"], { aiReady: false });
      expect(await getClassMeta(CLASS)).toMatchObject({
        entry_grade: 5,
        entry_semester: "2024-2025-1",
      });
    } finally {
      await deleteClass(CLASS);
    }
  });

  it("returns null and does not create meta for an empty class name", async () => {
    expect(await applyInferredClassMeta("", ["三年级"], { aiReady: false })).toBeNull();
  });
});
