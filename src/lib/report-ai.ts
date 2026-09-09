/**
 * 评价报告 AI 生成（增强层）：
 * - 已配置模型 → 5 节结构化长报告 + 末尾短评语行
 * - 未配置 / 失败 → 数据版 markdown（report.ts），录入永不阻塞
 */
import { isAiConfigured, loadAiConfig } from "./ai";
import { isTauri } from "./db";
import { createLlm } from "../agent/providers";
import type { AgentLlm, AgentMessage } from "../agent/types";
import type { ReportRange } from "../types";
import { buildDataReportMarkdown, type ReportSummaries } from "./report";

export interface EvalReportContext {
  studentName: string;
  gradeClass: string;
  range: ReportRange;
  summaries: ReportSummaries;
}

export interface EvalReportResult {
  markdown: string;
  shortComment: string;
  /** ai AI 生成 | manual 数据版兜底 */
  source: "ai" | "manual";
}

const SYSTEM_PROMPT =
  "你是一位经验丰富的小学班主任，正在为学生写阶段性评价报告。" +
  "写作要求：1）基于给出的成绩、表现、作业摘要，不编造具体分数与事例；" +
  "2）语气温暖具体，先肯定再给建议；" +
  "3）按固定 5 节输出 markdown：# 标题 / ## 总评 / ## 学业表现 / ## 行为习惯 / ## 作业情况 / ## 给家长的建议，每节 2~4 句；" +
  "4）全文 300~800 字；5）末尾另起一行输出「短评语：」+ 一句 60~120 字的期末评语口吻短评，只输出报告与短评语行，不要解释。";

function buildMessages(ctx: EvalReportContext): AgentMessage[] {
  const rangeText =
    ctx.range.mode === "semester" && ctx.range.semester
      ? `学期 ${ctx.range.semester}（${ctx.range.start}~${ctx.range.end}）`
      : `${ctx.range.start}~${ctx.range.end}`;
  const lines = [
    `【学生】${ctx.studentName}`,
    `【班级】${ctx.gradeClass || "未分班"}`,
    `【时间范围】${rangeText}`,
    `【学业】${ctx.summaries.scoreSummary || "暂无成绩数据"}`,
    `【行为】${ctx.summaries.behaviorSummary || "暂无表现记录"}`,
    `【作业】${ctx.summaries.homeworkSummary || "暂无作业记录"}`,
    "请据此写评价报告。",
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

/** 从模型输出拆出短评语行：末尾「短评语：xxx」；没有则截正文前 120 字 */
export function parseEvalReport(raw: string): { markdown: string; shortComment: string } {
  const text = (raw ?? "").trim();
  if (!text) return { markdown: "", shortComment: "" };
  const match = /(?:^|\n)\s*短评语\s*[:：]\s*(.+)\s*$/.exec(text);
  if (match) {
    const shortComment = match[1].trim().slice(0, 120);
    const markdown = text.slice(0, match.index).trim();
    return { markdown, shortComment };
  }
  return { markdown: text, shortComment: text.replace(/\s+/g, "").slice(0, 120) };
}

export async function generateEvalReport(
  ctx: EvalReportContext,
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<EvalReportResult> {
  const fallback = (): EvalReportResult => {
    const markdown = buildDataReportMarkdown(ctx.studentName, ctx.range, ctx.summaries);
    const shortComment = ctx.summaries.scoreSummary
      ? `${ctx.summaries.scoreSummary.slice(0, 100)}`
      : "";
    return { markdown, shortComment: shortComment.slice(0, 120), source: "manual" };
  };
  if (!ctx.studentName.trim()) return fallback();

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return fallback();

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({ system: SYSTEM_PROMPT, messages: buildMessages(ctx), tools: [], config });
    const parsed = parseEvalReport(res.content);
    if (!parsed.markdown) return fallback();
    return { ...parsed, source: "ai" };
  } catch {
    return fallback();
  }
}
