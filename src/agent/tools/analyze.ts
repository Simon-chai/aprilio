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
  registerScoreAnalysisProvider,
  registerSemesterAnalysisProvider,
  type AnalysisContext,
  type AnalysisEngine,
  type AnalysisQuery,
} from "../analysis";
import { defineAgentTool } from "../define";
import type { AgentTool, AgentToolContext, ToolResult } from "../types";

// 内置分析器装配：成绩分析 + 学期汇总（幂等注册，重复调用安全）。
// 新增分析器时在这里补一行 registerXxx，保证 analyze 工具开箱可用。
registerScoreAnalysisProvider(defaultAnalysisEngine);
registerSemesterAnalysisProvider(defaultAnalysisEngine);

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
      "深度数据与文档分析引擎代理：根据分析类型（kind）及载荷参数分派至对应分析器执行。" +
      "成绩分析可用 kind：score_overview / score_class（班级某次考试统计 + 总分排名，payload 传 class_name，可选 exam_id）、" +
      "score_student（学生历次成绩、单科强弱与排名，payload 传 student_id 或 name）、" +
      "score_rank（班级总分排行榜，payload 传 class_name）、score_trend（成绩走势：payload 传 student_id/姓名 → 个人总分走势；传 class_name → 班级多次考试趋势）。" +
      "学期汇总可用 kind：semester_overview（某班某学期成绩汇总，payload 传 class_name，可选 semester）、" +
      "student_term_report（某生某学期成绩与表现轨迹，payload 传 student_id 或 name，可选 semester；semester 格式 YYYY-YYYY-1/2，缺省当前学期）。" +
      "也支持 text2sql、aggregation、document 等扩展类型。",
    tags: ["readonly", "analysis"],
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description:
            "分析类型。成绩：score_overview / score_class / score_student / score_rank / score_trend；学期：semester_overview / student_term_report；扩展：text2sql、aggregation、document 等",
        },
        payload: {
          type: "object",
          description:
            "分析请求载荷。成绩/学期分析常用字段：class_name（班级）、student_id（学生 ID）、name（学生姓名）、exam_id（考试批次 ID）、semester（学期号 YYYY-YYYY-1/2）",
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
