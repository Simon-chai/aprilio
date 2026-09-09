/**
 * Agent 评测运行器 (Eval Runner)
 * 执行黄金评测用例集，统计意图命中率、参数准确性、安全确认门拦截率等指标。
 */
import type { CapabilityContainer } from "../../src/agent/container";
import type { AgentLlm, AgentToolContext, ToolCallPayload } from "../../src/agent/types";
import { mockLlm } from "../../src/agent/providers/mock";
import { buildCapabilityContainer } from "../../src/agent/manifest";
import type { EvalCase, EvalCategory, EvalResult, EvalSummary } from "./types";

export interface EvalRunnerOptions {
  llm?: AgentLlm;
  container?: CapabilityContainer;
  ctx?: AgentToolContext;
}

export async function runSingleEval(
  testCase: EvalCase,
  options: EvalRunnerOptions = {},
): Promise<EvalResult> {
  const llm = options.llm ?? mockLlm();
  const container = options.container ?? buildCapabilityContainer();
  const ctx = options.ctx ?? ({ router: { push: async () => {} } as never });

  try {
    const res = await llm.chat({
      system: "你是一个测试评测助手",
      messages: [{ role: "user", content: testCase.input }],
      tools: container.registry(ctx).definitions(),
      config: {
        provider: "mock",
        model: "mock",
        apiKey: "",
        baseUrl: "",
        temperature: 0,
        systemPrompt: "",
      },
    });

    const call: ToolCallPayload | undefined = res.toolCalls[0];
    const actualTool = call ? call.name : null;
    const actualArgs = call?.arguments ?? {};

    // 1. 校验工具命中情况
    if (testCase.expected.tool === null) {
      if (actualTool !== null) {
        return {
          caseId: testCase.id,
          category: testCase.category,
          passed: false,
          actualTool,
          actualArgs,
          reason: `期望不触发工具调用，实际调用了 "${actualTool}"`,
        };
      }

      if (testCase.expected.contentContains) {
        for (const kw of testCase.expected.contentContains) {
          if (!res.content.includes(kw)) {
            return {
              caseId: testCase.id,
              category: testCase.category,
              passed: false,
              actualTool: null,
              reason: `回复内容缺少关键字 "${kw}"，实际内容：${res.content.slice(0, 100)}`,
            };
          }
        }
      }

      return {
        caseId: testCase.id,
        category: testCase.category,
        passed: true,
        actualTool: null,
      };
    }

    if (actualTool !== testCase.expected.tool) {
      return {
        caseId: testCase.id,
        category: testCase.category,
        passed: false,
        actualTool,
        actualArgs,
        reason: `工具不匹配：期望 "${testCase.expected.tool}"，实际命中 "${actualTool ?? "null"}"`,
      };
    }

    // 2. 校验参数匹配度
    if (testCase.expected.args) {
      if (typeof testCase.expected.args === "function") {
        const ok = testCase.expected.args(actualArgs);
        if (!ok) {
          return {
            caseId: testCase.id,
            category: testCase.category,
            passed: false,
            actualTool,
            actualArgs,
            reason: `参数校验函数未通过，实际参数：${JSON.stringify(actualArgs)}`,
          };
        }
      } else {
        for (const [key, val] of Object.entries(testCase.expected.args)) {
          if (actualArgs[key] !== val) {
            return {
              caseId: testCase.id,
              category: testCase.category,
              passed: false,
              actualTool,
              actualArgs,
              reason: `参数 "${key}" 不匹配：期望 ${JSON.stringify(val)}，实际为 ${JSON.stringify(actualArgs[key])}`,
            };
          }
        }
      }
    }

    // 3. 校验安全确认门逻辑
    let gated = false;
    if (testCase.expected.shouldGate !== undefined && call) {
      const tool = container.registry(ctx).get(call.name);
      if (tool) {
        const execRes = await tool.execute(call.arguments ?? {}, ctx);
        gated = !execRes.ok && Boolean(execRes.error && (execRes.error.includes("confirm:true") || execRes.error.includes("写操作")));

        if (testCase.expected.shouldGate && !gated) {
          return {
            caseId: testCase.id,
            category: testCase.category,
            passed: false,
            actualTool,
            actualArgs,
            gated,
            reason: `安全门禁未生效：写操作应被拦截要求 confirm:true，但实际未被拦截`,
          };
        }

        if (!testCase.expected.shouldGate && gated) {
          return {
            caseId: testCase.id,
            category: testCase.category,
            passed: false,
            actualTool,
            actualArgs,
            gated,
            reason: `安全门禁误拦截：已确认或只读操作被拒绝，错误信息：${execRes.error}`,
          };
        }
      }
    }

    return {
      caseId: testCase.id,
      category: testCase.category,
      passed: true,
      actualTool,
      actualArgs,
      gated,
    };
  } catch (err) {
    return {
      caseId: testCase.id,
      category: testCase.category,
      passed: false,
      reason: `执行异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runEvalSuite(
  cases: EvalCase[],
  options: EvalRunnerOptions = {},
): Promise<EvalSummary> {
  const results: EvalResult[] = [];
  const failures: Array<{ id: string; input: string; reason: string }> = [];

  const categoryMap: Record<EvalCategory, { total: number; passed: number }> = {
    navigation: { total: 0, passed: 0 },
    data_query: { total: 0, passed: 0 },
    analysis: { total: 0, passed: 0 },
    docs_search: { total: 0, passed: 0 },
    confirm_gate: { total: 0, passed: 0 },
    fallback: { total: 0, passed: 0 },
  };

  for (const c of cases) {
    const res = await runSingleEval(c, options);
    results.push(res);

    categoryMap[c.category].total += 1;
    if (res.passed) {
      categoryMap[c.category].passed += 1;
    } else {
      failures.push({
        id: c.id,
        input: c.input,
        reason: res.reason ?? "未知失败",
      });
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const accuracy = total > 0 ? passed / total : 0;

  const categories = Object.entries(categoryMap).reduce(
    (acc, [cat, stats]) => {
      acc[cat as EvalCategory] = {
        total: stats.total,
        passed: stats.passed,
        failed: stats.total - stats.passed,
        accuracy: stats.total > 0 ? stats.passed / stats.total : 0,
      };
      return acc;
    },
    {} as Record<EvalCategory, { total: number; passed: number; failed: number; accuracy: number }>,
  );

  return {
    total,
    passed,
    failed,
    accuracy,
    categories,
    failures,
  };
}
