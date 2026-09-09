/**
 * AI 学期评语草稿（增强层）：
 * - 桌面端且已配置模型 → 经 Rust rig-core 结合该生本学期成绩 + 表现生成期末评语草稿
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 返回 null，界面退回手动填写，录入永不阻塞
 * 隐私：仅把该生本学期的统计摘要与表现条目发给用户自己配置的模型服务，不写日志。
 */
import { isAiConfigured, loadAiConfig } from "./ai";
import { isTauri } from "./db";
import { createLlm } from "../agent/providers";
import type { AgentLlm, AgentMessage } from "../agent/types";

export const TERM_COMMENT_MAX_LEN = 200;

export interface TermCommentContext {
  studentName: string;
  semester: string;
  gradeClass: string;
  /** 本学期成绩摘要（如「语文 92、数学 95；较上次进步 3 分」），可空 */
  scoreSummary: string;
  /** 本学期表现摘要（表扬/待改进/中立各若干条），可空 */
  behaviorSummary: string;
}

const SYSTEM_PROMPT =
  "你是一位经验丰富的小学班主任，正在为学生写期末评语。" +
  "写作要求：1）结合给出的成绩与日常表现，客观具体、有温度；" +
  "2）先肯定优点，再委婉指出需要努力的方向；" +
  "3）不超过 120 字，只输出评语正文，不要标题、引号、编号或任何解释。";

function buildMessages(ctx: TermCommentContext): AgentMessage[] {
  const lines = [
    `【学生】${ctx.studentName}`,
    `【班级】${ctx.gradeClass || "未分班"}`,
    `【学期】${ctx.semester}`,
    `【成绩情况】${ctx.scoreSummary || "本学期暂无成绩数据"}`,
    `【日常表现】${ctx.behaviorSummary || "本学期暂无表现记录"}`,
    "请据此写一段期末评语。",
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

/** 清洗模型输出：去引号 / 前缀，限长 */
export function parseTermComment(raw: string, maxLen = TERM_COMMENT_MAX_LEN): string {
  let text = raw.trim();
  if (!text) return "";
  text = text
    .replace(/^[「“"'『【]+/, "")
    .replace(/[」”"'』】]+$/, "")
    .replace(/^(评语[:：]\s*)/, "")
    .trim();
  if (text.length > maxLen) text = text.slice(0, maxLen);
  return text;
}

/**
 * 生成学期评语草稿。未配置 / 失败返回 null（不抛错）。
 * options.llm / options.aiReady 供单测注入替身。
 */
export async function generateTermComment(
  ctx: TermCommentContext,
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<string | null> {
  if (!ctx.studentName.trim()) return null;

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return null;

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: SYSTEM_PROMPT,
      messages: buildMessages(ctx),
      tools: [],
      config,
    });
    return parseTermComment(res.content) || null;
  } catch {
    return null;
  }
}

/** 成绩摘要素材：一行 = 一次考试的科目分 */
export interface TermScoreRow {
  exam_name: string;
  subjects: { subject: string; score: number | null; grade: string | null }[];
}

/** 表现摘要素材 */
export interface TermBehaviorRow {
  type: string;
  dimension_name_snap: string;
  comment: string;
}

/**
 * 把本学期的成绩拼成一段摘要文本（无 AI 时也用于界面展示与手动参考）：
 * 取最近一次考试的各科分数 + 有分数考试的总分区间。
 */
export function buildScoreSummary(rows: TermScoreRow[]): string {
  if (!rows.length) return "";
  const latest = rows[rows.length - 1];
  const parts = latest.subjects
    .map((s) => {
      const value = s.score !== null ? String(s.score) : s.grade ?? "";
      return value ? `${s.subject} ${value}` : "";
    })
    .filter(Boolean);
  const totals = rows
    .map((r) => {
      const nums = r.subjects.filter((s) => s.score !== null);
      return nums.length ? nums.reduce((a, s) => a + (s.score ?? 0), 0) : null;
    })
    .filter((t): t is number => t !== null);
  const range = totals.length
    ? `总分 ${Math.min(...totals)}~${Math.max(...totals)}`
    : "";
  return [parts.length ? `${latest.exam_name}：${parts.join("、")}` : "", range]
    .filter(Boolean)
    .join("；");
}

/** 把本学期的表现拼成一段摘要文本：按倾向分组列出前几条评语 */
export function buildBehaviorSummary(rows: TermBehaviorRow[]): string {
  if (!rows.length) return "";
  const groups: Record<string, string[]> = { praise: [], improve: [], neutral: [] };
  for (const r of rows) {
    const key = r.type in groups ? r.type : "neutral";
    if (r.comment.trim()) groups[key].push(`${r.dimension_name_snap}：${r.comment.trim()}`);
  }
  const label: Record<string, string> = { praise: "表扬", improve: "待改进", neutral: "其他" };
  return (["praise", "improve", "neutral"] as const)
    .filter((k) => groups[k].length)
    .map((k) => `${label[k]}：${groups[k].slice(0, 3).join("；")}`)
    .join("。");
}

