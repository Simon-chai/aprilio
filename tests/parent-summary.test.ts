import { describe, expect, it } from "vitest";
import type { AgentLlm, AgentMessage } from "../src/agent/types";
import {
  buildParentSummaryMaterial,
  filterBehaviorsByRange,
  rangeLabel,
  targetSemesterOfRange,
  type SummaryBehaviorRow,
} from "../src/lib/parent-summary";
import {
  buildSummaryMessages,
  parseParentSummary,
  requestParentSummary,
  PARENT_SUMMARY_MAX_LEN,
} from "../src/lib/parent-summary-ai";

const row = (
  type: string,
  dimension: string,
  comment = "",
  recorded_date = "2026-09-10"
): SummaryBehaviorRow & { recorded_date: string } => ({
  type,
  dimension_name_snap: dimension,
  comment,
  recorded_date,
});

describe("filterBehaviorsByRange", () => {
  const rows = [
    row("praise", "a", "", "2026-09-01"),
    row("praise", "b", "", "2026-09-15"),
    row("improve", "c", "", "2026-10-01"),
  ];

  it("keeps both ends of the closed range", () => {
    expect(filterBehaviorsByRange(rows, "2026-09-01", "2026-10-01")).toHaveLength(3);
    expect(filterBehaviorsByRange(rows, "2026-09-15", "2026-09-15")).toHaveLength(1);
  });

  it("drops records outside the range", () => {
    expect(filterBehaviorsByRange(rows, "2026-09-02", "2026-09-30").map((r) => r.dimension_name_snap)).toEqual(["b"]);
  });
});

describe("buildParentSummaryMaterial", () => {
  it("groups by polarity with counts and keeps source order", () => {
    const material = buildParentSummaryMaterial([
      row("praise", "课堂发言", "举手很积极"),
      row("improve", "作业书写", "偶有潦草"),
      row("praise", "互助同学", "主动帮同学讲题"),
      row("neutral", "其他", ""),
    ]);
    expect(material.praiseCount).toBe(2);
    expect(material.improveCount).toBe(1);
    expect(material.neutralCount).toBe(1);
    expect(material.total).toBe(4);
    expect(material.text).toBe(
      "表扬（2 条）：课堂发言：举手很积极；互助同学：主动帮同学讲题。待改进（1 条）：作业书写：偶有潦草。其他（1 条）：其他"
    );
  });

  it("falls back to the dimension name when comment is blank and clamps per group", () => {
    const many: SummaryBehaviorRow[] = Array.from({ length: 10 }, (_, i) =>
      row("praise", `d${i}`)
    );
    const material = buildParentSummaryMaterial(many);
    expect(material.text).toContain("d0");
    expect(material.text).toContain("d7");
    expect(material.text).not.toContain("d8");
    expect(material.praiseCount).toBe(10);
  });

  it("returns empty text for no records", () => {
    expect(buildParentSummaryMaterial([]).text).toBe("");
  });
});

describe("rangeLabel / targetSemesterOfRange", () => {
  it("labels semester and custom ranges", () => {
    expect(
      rangeLabel({ mode: "semester", semester: "2026-2027-1", start: "2026-09-01", end: "2027-02-28" })
    ).toBe("2026-2027-1 学期（2026-09-01~2027-02-28）");
    expect(rangeLabel({ mode: "custom", semester: null, start: "2026-09-01", end: "2026-09-30" })).toBe(
      "2026-09-01 ~ 2026-09-30"
    );
  });

  it("resolves the apply target semester", () => {
    expect(
      targetSemesterOfRange({ mode: "semester", semester: "2025-2026-2", start: "2026-03-01", end: "2026-08-31" })
    ).toBe("2025-2026-2");
    // 自定义区间按起始日期推导学期
    expect(targetSemesterOfRange({ mode: "custom", semester: null, start: "2026-10-02", end: "2026-10-31" })).toBe(
      "2026-2027-1"
    );
    expect(targetSemesterOfRange({ mode: "custom", semester: null, start: "2026-04-02", end: "2026-04-30" })).toBe(
      "2025-2026-2"
    );
  });
});

describe("buildSummaryMessages", () => {
  it("carries student, range, material and optional requirement", () => {
    const messages = buildSummaryMessages({
      studentName: "林知远",
      gradeClass: "三年二班",
      rangeText: "2026-2027-1 学期（2026-09-01~2027-02-28）",
      material: "表扬（1 条）：课堂发言：举手很积极",
      requirement: "多鼓励，语气轻一些",
    });
    expect(messages).toHaveLength(1);
    const text = messages[0].content;
    expect(text).toContain("【学生】林知远");
    expect(text).toContain("【班级】三年二班");
    expect(text).toContain("【时间范围】2026-2027-1 学期");
    expect(text).toContain("【时段内评价】表扬（1 条）");
    expect(text).toContain("【个性化要求】多鼓励，语气轻一些");
  });

  it("omits the requirement line when blank", () => {
    const messages = buildSummaryMessages({
      studentName: "林知远",
      gradeClass: "",
      rangeText: "2026-09-01 ~ 2026-09-30",
      material: "",
    });
    expect(messages[0].content).not.toContain("个性化要求");
    expect(messages[0].content).toContain("【时段内评价】本时段暂无评价记录");
  });
});

describe("parseParentSummary", () => {
  it("strips quotes and prefixes, then truncates to the hard limit", () => {
    expect(parseParentSummary("「家长您好…」")).toBe("家长您好…");
    expect(parseParentSummary("总结：孩子近期表现稳定。")).toBe("孩子近期表现稳定。");
    expect(parseParentSummary("a".repeat(PARENT_SUMMARY_MAX_LEN + 5))).toHaveLength(PARENT_SUMMARY_MAX_LEN);
  });
});

describe("requestParentSummary", () => {
  function fakeLlm(
    reply: string | Error,
    calls: { system: string; messages: AgentMessage[] }[] = []
  ): AgentLlm {
    return {
      chat: async (req) => {
        // 快照当前线程：requestParentSummary 会原地 push 助手回复，活引用会污染断言
        calls.push({ system: req.system, messages: req.messages.map((m) => ({ ...m })) });
        if (reply instanceof Error) throw reply;
        return { content: reply } as Awaited<ReturnType<AgentLlm["chat"]>>;
      },
    };
  }

  it("returns the cleaned summary and appends it to the thread", async () => {
    const calls: { system: string; messages: AgentMessage[] }[] = [];
    const thread = buildSummaryMessages({
      studentName: "林知远",
      gradeClass: "三年二班",
      rangeText: "2026-2027-1 学期",
      material: "表扬（1 条）：课堂发言",
    });
    const text = await requestParentSummary(thread, { llm: fakeLlm("「表现很好。」", calls), aiReady: true });
    expect(text).toBe("表现很好。");
    expect(thread).toHaveLength(2);
    expect(thread[1]).toEqual({ role: "assistant", content: "表现很好。" });
    expect(calls[0].system).toContain("家校沟通");
  });

  it("keeps the thread intact across chat-style follow-up requirements", async () => {
    const calls: { system: string; messages: AgentMessage[] }[] = [];
    const llm = fakeLlm("第一版。", calls);
    const thread = buildSummaryMessages({
      studentName: "林知远",
      gradeClass: "三年二班",
      rangeText: "2026-2027-1 学期",
      material: "表扬（1 条）",
    });
    await requestParentSummary(thread, { llm, aiReady: true });
    thread.push({ role: "user", content: "语气再温和一些" });
    const second = await requestParentSummary(thread, { llm: fakeLlm("第二版。", calls), aiReady: true });
    expect(second).toBe("第二版。");
    // 第二次请求携带完整线程：素材消息 + 第一版回复 + 新要求
    expect(calls[1].messages).toHaveLength(3);
    expect(calls[1].messages[1].content).toBe("第一版。");
    expect(calls[1].messages[2].content).toBe("语气再温和一些");
  });

  it("returns null without touching the llm when ai is not ready", async () => {
    const calls: unknown[] = [];
    const thread: AgentMessage[] = [{ role: "user", content: "x" }];
    const text = await requestParentSummary(thread, { llm: fakeLlm("y", calls), aiReady: false });
    expect(text).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when the model replies empty or throws", async () => {
    const thread: AgentMessage[] = [{ role: "user", content: "x" }];
    expect(await requestParentSummary(thread, { llm: fakeLlm("  "), aiReady: true })).toBeNull();
    expect(await requestParentSummary(thread, { llm: fakeLlm(new Error("boom")), aiReady: true })).toBeNull();
  });
});
