/**
 * Agent 评测体系类型定义 (Agent Evals Types)
 */
import type { AgentToolContext } from "../../src/agent/types";

export type EvalCategory =
  | "navigation"
  | "data_query"
  | "analysis"
  | "docs_search"
  | "confirm_gate"
  | "fallback";

export interface EvalCase {
  id: string;
  description: string;
  category: EvalCategory;
  input: string;
  context?: {
    currentRoute?: string;
  };
  expected: {
    /** 期望命中的工具名；为 null 表示不应发起工具调用（直接文本回复） */
    tool?: string | null;
    /** 期望的工具参数校验：对象部分匹配或自定义校验函数 */
    args?: Record<string, unknown> | ((args: Record<string, unknown>) => boolean);
    /** 是否必须被确认门（human-in-the-loop）拦截 */
    shouldGate?: boolean;
    /** 回复文本期望包含的关键字列表（通常用于兜底或直接回复） */
    contentContains?: string[];
  };
}

export interface EvalResult {
  caseId: string;
  category: EvalCategory;
  passed: boolean;
  actualTool?: string | null;
  actualArgs?: Record<string, unknown>;
  gated?: boolean;
  reason?: string;
}

export interface EvalCategorySummary {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  categories: Record<EvalCategory, EvalCategorySummary>;
  failures: Array<{ id: string; input: string; reason: string }>;
}
