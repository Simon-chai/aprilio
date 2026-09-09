import { describe, expect, it } from "vitest";
import { generateEvalReport, parseEvalReport } from "../src/lib/report-ai";
import { resolveReportRange } from "../src/lib/report";

const range = resolveReportRange({ mode: "custom", start: "2026-09-01", end: "2026-09-30" });

describe("评价报告 AI", () => {
  it("拆出短评语行", () => {
    const { markdown, shortComment } = parseEvalReport("# 报告\n内容\n短评语：孩子进步很大，继续保持");
    expect(markdown).toContain("# 报告");
    expect(shortComment).toContain("进步很大");
  });

  it("未配置 AI 返回数据版兜底", async () => {
    const res = await generateEvalReport(
      {
        studentName: "林知远",
        gradeClass: "三年级二班",
        range,
        summaries: {
          scoreSummary: "",
          behaviorSummary: "",
          homeworkSummary: "",
          examCount: 0,
          praiseCount: 0,
          improveCount: 0,
        },
      },
      { aiReady: false }
    );
    expect(res.source).toBe("manual");
    expect(res.markdown).toContain("评价报告");
  });

  it("AI 成功返回双输出", async () => {
    const fakeLlm = {
      chat: async () => ({
        content: "## 总评\n很好\n短评语：该生表现优秀，望继续保持良好的学习习惯",
      }),
    };
    const res = await generateEvalReport(
      {
        studentName: "林知远",
        gradeClass: "三年级二班",
        range,
        summaries: {
          scoreSummary: "期中 语文90",
          behaviorSummary: "表扬2",
          homeworkSummary: "按时率100%",
          examCount: 1,
          praiseCount: 2,
          improveCount: 0,
        },
      },
      { llm: fakeLlm as never, aiReady: true }
    );
    expect(res.source).toBe("ai");
    expect(res.shortComment).toContain("表现优秀");
  });
});
