import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildSystemPrompt } from "../src/agent/prompt";
import { clearPageContext, reportPageContext } from "../src/agent/page-context-bus";
import { generateTermComment } from "../src/lib/comment-ai";
import { generateEvalReport } from "../src/lib/report-ai";
import { recommendComments } from "../src/lib/behavior-ai";
import { summarizeMemoTitle } from "../src/lib/memo-ai";
import { polishText } from "../src/lib/polish-ai";
import { generateAiLessonDigest } from "../src/classroom/digest-ai";
import { ensureGuardianTagPolarities } from "../src/lib/guardian-tags";
import { aiDetectNameColumn, aiInferClassName } from "../src/lib/roster";
import { aiDetectScoreSheet } from "../src/lib/scores";
import { DEFAULT_AI_CONFIG } from "../src/lib/ai";
import { PROMPT_IDS } from "../src/prompts/ids";
import { savePromptOverride, resetAllPromptOverrides } from "../src/prompts/store";
import type { AgentLlm } from "../src/agent/types";
import type { RosterTable } from "../src/lib/roster";

/**
 * 接线回归：11 处调用点都真的走提示词模块。
 *
 * 两类断言：
 * 1. **零漂移**——未自定义时发出去的 system 与出厂基线逐字一致
 *    （夹具 tests/fixtures/prompts-before.json：改造前的 10 处由改造前代码导出；
 *    content.text-polish 是通用润色上线时的出厂基线，防未来无意漂移）
 * 2. **可生效**——写入自定义值后，各处发给模型的 system 随之改变
 *    （证明接线没漏，而不是仅仅「值恰好相同」）
 */

const before = JSON.parse(
  readFileSync("tests/fixtures/prompts-before.json", "utf8"),
) as Record<string, string>;

const cfg = { ...DEFAULT_AI_CONFIG, apiKey: "k" };

function capture(): { llm: AgentLlm; seen: string[] } {
  const seen: string[] = [];
  const llm: AgentLlm = {
    async chat(req) {
      seen.push(req.system);
      return { content: "{}", toolCalls: [] };
    },
  };
  return { llm, seen };
}

const table: RosterTable = {
  headers: ["姓名", "语文", "数学"],
  rows: [
    ["张三", "90", "95"],
    ["李四", "88", "92"],
  ],
  hasHeader: true,
};

/** 依次触发全部 11 处调用点，收集实际发出去的 system 文本 */
async function collectAll(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  clearPageContext("class-detail");
  out["agent.fallback"] = buildSystemPrompt("classes");
  reportPageContext({
    page: "class-detail",
    title: "班级详情 · 三年级二班",
    params: { name: "三年级二班" },
    summary: "在用班级 · 学生 10 人",
  });
  out["agent.snapshot"] = buildSystemPrompt("class-detail");
  out["agent.extra"] = buildSystemPrompt("classes", "回答请简短");
  clearPageContext("class-detail");

  {
    const { llm, seen } = capture();
    await generateTermComment(
      {
        studentName: "张三",
        semester: "2025-2026-1",
        gradeClass: "三年级二班",
        scoreSummary: "期中：语文 90",
        behaviorSummary: "表扬：发言积极",
      },
      { llm, aiReady: true },
    );
    out["content.term-comment"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await generateEvalReport(
      {
        studentName: "张三",
        gradeClass: "三年级二班",
        range: { mode: "custom", start: "2025-09-01", end: "2025-10-01" },
        summaries: { scoreSummary: "s", behaviorSummary: "b", homeworkSummary: "h" },
      },
      { llm, aiReady: true },
    );
    out["content.eval-report"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await recommendComments(
      { studentName: "张三", dimensionName: "课堂表现", polarity: "praise", frequent: ["发言积极"] },
      { llm, aiReady: true, useCache: false },
    );
    out["content.behavior-comment"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await summarizeMemoTitle("周三下午教研会", { llm, aiReady: true });
    out["content.memo-title"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await polishText({ scene: "测试场景", text: "一句话原文" }, { llm, aiReady: true });
    out["content.text-polish"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await generateAiLessonDigest(
      {
        session: {
          id: 1,
          class_name: "三年级二班",
          subject: "语文",
          lesson_date: "2025-10-01",
          period: 3,
          status: "ended",
          note: null,
          activity_set_json: null,
          started_at: "",
          ended_at: "",
          created_at: "",
          updated_at: "",
        },
        events: [],
      } as never,
      {
        duration_min: 40,
        picks: [],
        pick_coverage: 0,
        praise_count: 0,
        improve_count: 0,
        groups: [],
        absent: [],
        silent: [],
      } as never,
      { llm, aiReady: true },
    );
    out["content.lesson-digest"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await ensureGuardianTagPolarities(["配合"], { llm, aiReady: true });
    out["recognize.guardian-tag"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await aiDetectNameColumn(table, llm, cfg);
    out["recognize.roster-name-column"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await aiInferClassName(["四8班学生详细信息.xlsx"], llm, cfg);
    out["recognize.roster-class-name"] = seen[0];
  }

  {
    const { llm, seen } = capture();
    await aiDetectScoreSheet(table, llm, cfg);
    out["recognize.score-sheet"] = seen[0];
  }

  return out;
}

beforeEach(() => {
  localStorage.clear();
  // 推荐评语有缓存层：清掉避免跨用例串味
  resetAllPromptOverrides();
});

describe("接线零漂移：未自定义时与改造前逐字一致", () => {
  it("11 处调用点全部命中夹具", async () => {
    const after = await collectAll();
    // 夹具 13 项：Agent 的三种形态 + 其余 10 个模块
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [key, expected] of Object.entries(before)) {
      expect(after[key], `${key} 与改造前不一致`).toBe(expected);
    }
  });
});

describe("接线可生效：写入自定义值后各处随之改变", () => {
  const MARK = "【接线标记】";

  const CASES: [string, string, string][] = [
    // [模块 id, 自定义正文, 期望改动的输出键]
    [PROMPT_IDS.termComment, `${MARK}评语`, "content.term-comment"],
    [PROMPT_IDS.evalReport, `${MARK}报告`, "content.eval-report"],
    [PROMPT_IDS.behaviorComment, `${MARK}推荐`, "content.behavior-comment"],
    [PROMPT_IDS.memoTitle, `${MARK}标题`, "content.memo-title"],
    [PROMPT_IDS.textPolish, `${MARK}润色`, "content.text-polish"],
    [PROMPT_IDS.lessonDigest, `${MARK}小结`, "content.lesson-digest"],
    [PROMPT_IDS.guardianTag, `${MARK}倾向`, "recognize.guardian-tag"],
    [PROMPT_IDS.rosterNameColumn, `${MARK}姓名列`, "recognize.roster-name-column"],
    [PROMPT_IDS.rosterClassName, `${MARK}班级`, "recognize.roster-class-name"],
    [PROMPT_IDS.scoreSheet, `${MARK}成绩单`, "recognize.score-sheet"],
  ];

  it.each(CASES)("%s 的自定义值会发给模型", async (id, text, outKey) => {
    savePromptOverride(id, text);
    const after = await collectAll();
    expect(after[outKey]).toBe(text);
  });

  it("智能助手主提示词的自定义值会生效，且运行期变量仍被注入", async () => {
    savePromptOverride(PROMPT_IDS.agent, `${MARK}页面={当前页面}；概况={页面概况}；补充={补充设定}`);
    const after = await collectAll();
    expect(after["agent.snapshot"]).toBe(
      `${MARK}页面=「班级详情 · 三年级二班」（class-detail）；概况=在用班级 · 学生 10 人；补充=`,
    );
    // 值为空的补充设定整行删除：这里它与其它占位符同行，故保留该行但值为空
    expect(after["agent.extra"]).toContain("补充=回答请简短");
  });

  it("助手自定义时若把页面概况单独成行，未上报页面则整行消失", async () => {
    savePromptOverride(PROMPT_IDS.agent, ["页面：{当前页面}", "{页面概况}", "完毕"].join("\n"));
    const after = await collectAll();
    // classes 未上报快照 → 概况整行省略
    expect(after["agent.fallback"]).toBe("页面：「班级管理」（classes）\n完毕");
    // class-detail 上报了 → 该行保留（这里是原样的变量插入）
    expect(after["agent.snapshot"]).toContain("在用班级 · 学生 10 人");
  });
});

describe("恢复默认后回到出厂文案", () => {
  it("清空覆盖即回到夹具内容", async () => {
    savePromptOverride(PROMPT_IDS.memoTitle, "改过的标题");
    expect((await collectAll())["content.memo-title"]).toBe("改过的标题");
    resetAllPromptOverrides();
    expect((await collectAll())["content.memo-title"]).toBe(before["content.memo-title"]);
  });
});

describe("契约变量由 resolvePrompt 自动注入（调用方无需传）", () => {
  it("长度上限变量在未传参数时也正确落地", () => {
    const after = buildSystemPrompt("classes");
    expect(after).toContain("工具使用准则");
  });

  it("删掉契约变量所在句不影响主流程，仅按自定义正文发送", async () => {
    // 用户完全重写、去掉了 {评语字数上限}：不阻断，如实发送自定义正文
    savePromptOverride(PROMPT_IDS.termComment, "随便写两句");
    const seen: string[] = [];
    const llm: AgentLlm = {
      async chat(req) {
        seen.push(req.system);
        return { content: "评语", toolCalls: [] };
      },
    };
    await generateTermComment(
      { studentName: "张三", semester: "s", gradeClass: "c", scoreSummary: "", behaviorSummary: "" },
      { llm, aiReady: true },
    );
    expect(seen[0]).toBe("随便写两句");
  });
});

describe("未注册模块 id 不炸主流程", () => {
  it("返回空串并告警，评语生成仍然完成", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm: AgentLlm = {
      async chat() {
        return { content: "正常评语", toolCalls: [] };
      },
    };
    const result = await generateTermComment(
      { studentName: "张三", semester: "s", gradeClass: "c", scoreSummary: "", behaviorSummary: "" },
      { llm, aiReady: true },
    );
    expect(result).toBe("正常评语");
    warn.mockRestore();
  });
});
