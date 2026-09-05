/**
 * Agent 质量与意图防退化评测测试套件 (Agent Quality & Evals Test Suite)
 *
 * 自动化评测：
 * 1. 典型自然语言意图分类与工具命中率 (Navigation, Data Query, Docs Search, Actions, Fallback)
 * 2. 槽位与参数提取准确性 (Target, Entity, Keyword, Action)
 * 3. 安全拦截确认门机制 (Confirm Gate)
 * 4. 全链路执行循环 (runAgentTurn) 防退化
 */
import { describe, expect, it } from "vitest";
import { EVAL_DATASET } from "./dataset";
import { runEvalSuite, runSingleEval } from "./eval-runner";
import { mockLlm } from "../../src/agent/providers/mock";
import { buildCapabilityContainer } from "../../src/agent/manifest";
import { runAgentTurn } from "../../src/agent/loop";
import type { AgentLlm, AgentToolContext } from "../../src/agent/types";

describe("Agent Evals 意图与质量防退化评测", () => {
  const container = buildCapabilityContainer();
  const ctx: AgentToolContext = {
    router: { push: async () => {} } as never,
  };

  describe("黄金用例全量评测基准 (Golden Benchmark)", () => {
    it("runs full eval suite and meets quality thresholds", async () => {
      const summary = await runEvalSuite(EVAL_DATASET, { container, ctx });

      if (summary.failures.length > 0) {
        console.error("Eval Failures:", JSON.stringify(summary.failures, null, 2));
      }

      // 准确率基线：全量黄金数据集要求 100% 通过
      expect(summary.failures).toEqual([]);
      expect(summary.passed).toBe(summary.total);
      expect(summary.accuracy).toBe(1.0);

      // 安全拦截门禁要求零失误
      expect(summary.categories.confirm_gate.accuracy).toBe(1.0);
      expect(summary.categories.navigation.accuracy).toBe(1.0);
      expect(summary.categories.data_query.accuracy).toBe(1.0);
      expect(summary.categories.docs_search.accuracy).toBe(1.0);
      expect(summary.categories.fallback.accuracy).toBe(1.0);
    });
  });

  describe("意图识别与工具命中率 (Intent & Tool Hit Rate)", () => {
    it.each(EVAL_DATASET.filter((c) => c.category === "navigation"))(
      "correctly routes navigation intent: $input -> $expected.args.target",
      async (testCase) => {
        const result = await runSingleEval(testCase, { container, ctx });
        expect(result.passed, result.reason).toBe(true);
        expect(result.actualTool).toBe("navigate");
      },
    );

    it.each(EVAL_DATASET.filter((c) => c.category === "data_query"))(
      "correctly routes data query intent: $input",
      async (testCase) => {
        const result = await runSingleEval(testCase, { container, ctx });
        expect(result.passed, result.reason).toBe(true);
        expect(result.actualTool).toBe("query_data");
      },
    );

    it.each(EVAL_DATASET.filter((c) => c.category === "docs_search"))(
      "correctly routes docs search intent: $input",
      async (testCase) => {
        const result = await runSingleEval(testCase, { container, ctx });
        expect(result.passed, result.reason).toBe(true);
        expect(result.actualTool).toBe("find_docs");
      },
    );

    it.each(EVAL_DATASET.filter((c) => c.category === "fallback"))(
      "correctly handles out-of-scope query without hallucinated tool calls: $input",
      async (testCase) => {
        const result = await runSingleEval(testCase, { container, ctx });
        expect(result.passed, result.reason).toBe(true);
        expect(result.actualTool).toBeNull();
      },
    );
  });

  describe("关键实体与槽位提取准确性 (Parameter Extraction)", () => {
    it("extracts exact student name from unquoted sentence", async () => {
      const c = EVAL_DATASET.find((item) => item.id === "query-student-name")!;
      const result = await runSingleEval(c, { container, ctx });
      expect(result.passed).toBe(true);
      expect(result.actualArgs?.keyword).toBe("林知远");
    });

    it("extracts exact student name enclosed in quotation marks", async () => {
      const c = EVAL_DATASET.find((item) => item.id === "query-student-quoted")!;
      const result = await runSingleEval(c, { container, ctx });
      expect(result.passed).toBe(true);
      expect(result.actualArgs?.keyword).toBe("李雷");
    });

    it("does not extract generic words like 学生/档案 as student name", async () => {
      const c = EVAL_DATASET.find((item) => item.id === "query-student-list")!;
      const result = await runSingleEval(c, { container, ctx });
      expect(result.passed).toBe(true);
      expect(result.actualArgs?.keyword).toBeUndefined();
    });
  });

  describe("安全确认门机制评测 (Confirm Gate Enforcement)", () => {
    it("blocks dangerous operation when confirm:true is missing", async () => {
      const c = EVAL_DATASET.find((item) => item.id === "gate-clear-data-unconfirmed")!;
      const result = await runSingleEval(c, { container, ctx });
      expect(result.passed).toBe(true);
      expect(result.gated).toBe(true);
    });

    it("executes dangerous operation when explicit confirmation is given", async () => {
      const c = EVAL_DATASET.find((item) => item.id === "gate-clear-data-confirmed")!;
      const result = await runSingleEval(c, { container, ctx });
      expect(result.passed).toBe(true);
      expect(result.gated).toBe(false);
      expect(result.actualArgs?.confirm).toBe(true);
    });
  });

  describe("全流程循环 (runAgentTurn) 端到端评测", () => {
    it("executes navigation turn and produces final completion summary", async () => {
      const registry = container.registry(ctx);
      const llm = mockLlm();

      const result = await runAgentTurn({
        userText: "帮我打开学生列表",
        history: [],
        registry,
        llm,
        config: {
          provider: "mock",
          model: "mock",
          apiKey: "",
          baseUrl: "",
          temperature: 0,
          systemPrompt: "",
        },
        ctx,
        currentRoute: "home",
      });

      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0].call.name).toBe("navigate");
      expect(result.toolRuns[0].result.ok).toBe(true);
      expect(result.reply).toContain("已打开「学生档案」页面");
    });

    it("executes docs search turn and returns relevant content summary", async () => {
      const registry = container.registry(ctx);
      const llm = mockLlm();

      const result = await runAgentTurn({
        userText: "日志文件保存在哪里，怎么排查",
        history: [],
        registry,
        llm,
        config: {
          provider: "mock",
          model: "mock",
          apiKey: "",
          baseUrl: "",
          temperature: 0,
          systemPrompt: "",
        },
        ctx,
        currentRoute: "home",
      });

      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0].call.name).toBe("find_docs");
      expect(result.toolRuns[0].result.ok).toBe(true);
      expect(result.reply).toContain("LOGGING.md");
    });
  });

  describe("全链路防退化：确认门 / 参数提取 / 未知工具兜底 (runAgentTurn E2E)", () => {
    const evalConfig = {
      provider: "mock" as const,
      model: "mock",
      apiKey: "",
      baseUrl: "",
      temperature: 0,
      systemPrompt: "",
    };

    it("extracts student name into query params through the full loop", async () => {
      const result = await runAgentTurn({
        userText: "查一下林知远的资料",
        history: [],
        registry: container.registry(ctx),
        llm: mockLlm(),
        config: evalConfig,
        ctx,
        currentRoute: "home",
      });

      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0].call.name).toBe("query_data");
      expect(result.toolRuns[0].call.arguments.entity).toBe("students");
      expect(result.toolRuns[0].call.arguments.keyword).toBe("林知远");
      expect(result.toolRuns[0].result.ok).toBe(true);
      expect(result.toolRuns[0].result.summary).toContain("学生查询");
    });

    it("gates unconfirmed dangerous ui_action through the full loop and passes after confirm", async () => {
      const registry = container.registry(ctx);
      const llm = mockLlm();

      // 第一次：未确认 → 循环不中断，拒绝原因如实回喂
      const blocked = await runAgentTurn({
        userText: "清空全部数据",
        history: [],
        registry,
        llm,
        config: evalConfig,
        ctx,
        currentRoute: "settings",
      });
      expect(blocked.toolRuns).toHaveLength(1);
      expect(blocked.toolRuns[0].call.name).toBe("ui_action");
      expect(blocked.toolRuns[0].result.ok).toBe(false);
      expect(blocked.toolRuns[0].result.error).toContain("confirm:true");
      expect(blocked.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);

      // 第二次：明确同意 → confirm:true 放行并真正执行
      const done = await runAgentTurn({
        userText: "确认清空全部数据",
        history: [],
        registry,
        llm,
        config: evalConfig,
        ctx,
        currentRoute: "settings",
      });
      expect(done.toolRuns[0].call.arguments.confirm).toBe(true);
      expect(done.toolRuns[0].result.ok).toBe(true);
      expect(done.toolRuns[0].result.summary).toContain("已清空");
    });

    it("feeds unknown tool failures back to the model instead of crashing", async () => {
      // 脚本化 fake LLM：首轮幻觉调用未注册工具，次轮如实向用户解释
      const steps = [
        { content: "", toolCalls: [{ id: "e1", name: "delete_database", arguments: {} }] },
        { content: "抱歉，我没有这个能力。", toolCalls: [] },
      ];
      let i = 0;
      const llm: AgentLlm = {
        async chat() {
          return steps[Math.min(i++, steps.length - 1)];
        },
      };

      const result = await runAgentTurn({
        userText: "把数据库删了",
        history: [],
        registry: container.registry(ctx),
        llm,
        config: evalConfig,
        ctx,
        currentRoute: "home",
      });

      expect(result.toolRuns).toHaveLength(1);
      expect(result.toolRuns[0].result.ok).toBe(false);
      expect(result.toolRuns[0].result.error).toContain("未知工具");
      // 错误以 tool 消息回喂而非抛出，循环继续到最终回复
      expect(result.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
      ]);
      expect(result.reply).toBe("抱歉，我没有这个能力。");
    });
  });
});
