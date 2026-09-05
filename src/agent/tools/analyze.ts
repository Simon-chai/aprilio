/**
 * 工具：analyze —— 深度分析引擎代理工具（声明式注册，default export 即被容器装载）。
 *
 * 职责：
 * - 作为 Agent 工具调用与底层分析引擎（AnalysisEngine）的适配桥梁
 * - 支持将模型派发的分析请求按类型/协议（如 text2sql, aggregation, document 等）路由至对应的分析器
 * - 预留未来扩展，纯契约驱动与零具体业务耦合
 */
import {
  defaultAnalysisEngine,
  type AnalysisContext,
  type AnalysisEngine,
  type AnalysisQuery,
} from "../analysis";
import { defineAgentTool } from "../define";
import type { AgentTool, AgentToolContext, ToolResult } from "../types";

function parsePayload(raw: unknown): unknown {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return { text: trimmed };
    }
  }
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }
  return {};
}

export function createAnalyzeTool(engine: AnalysisEngine = defaultAnalysisEngine): AgentTool {
  return defineAgentTool({
    name: "analyze",
    label: "深度分析",
    description:
      "深度数据与文档分析引擎代理：根据分析类型（kind）及载荷参数分派至对应分析器执行（例如 text2sql、数据聚合、多源文档提取等）。",
    tags: ["readonly", "analysis"],
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "分析类型，例如 text2sql、aggregation、document 等",
        },
        payload: {
          type: "object",
          description: "分析请求载荷对象或查询参数",
        },
      },
      required: ["kind"],
    },
    async execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult> {
      const rawKind = args.kind;
      if (typeof rawKind !== "string" || !rawKind.trim()) {
        return {
          ok: false,
          summary: "",
          error: "缺少必要的分析类型参数 kind",
        };
      }

      const query: AnalysisQuery = {
        kind: rawKind.trim(),
        payload: parsePayload(args.payload),
        metadata: {
          caller: "agent_tool",
        },
      };

      const analysisCtx: AnalysisContext = {
        capabilities: ctx.capabilities,
      };

      const result = await engine.execute(query, analysisCtx);

      return {
        ok: result.ok,
        summary: result.summary,
        data: result.data,
        error: result.error,
      };
    },
  });
}

export default createAnalyzeTool();
