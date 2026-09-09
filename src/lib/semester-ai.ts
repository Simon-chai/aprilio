/**
 * 智能识别年级与学期（AI 增强层）：
 * - 规则优先：从文本里提取「三年级」与「2026年秋季 / 2025-2026学年第二学期」等线索；
 * - 规则失败且已配置模型时，交给模型推断，返回结果必须通过合法性校验（防幻觉）；
 * - 浏览器演示态 / 未配置模型 / 调用失败 → 返回空，界面照常手工填写（永不阻塞）。
 * 隐私：仅把文件名 / 标题行文本发给用户自己配置的模型服务，不写日志。
 */
import { isAiConfigured, loadAiConfig } from "./ai";
import { getClassMeta, isTauri, saveClassMeta } from "./db";
import { createLlm } from "../agent/providers";
import { inferGradeFromName } from "./semester";
import type { AgentLlm, AgentMessage } from "../agent/types";

export interface GradeSemesterGuess {
  grade: number | null;
  /** YYYY-YYYY-1/2 */
  semester: string | null;
  method: "rule" | "ai";
}

const SEMESTER_RE = /^\d{4}-\d{4}-[12]$/;

/**
 * 从文本提取学期号：支持「2026年秋季 / 春季」「2025-2026学年第二学期」「2026学年第一学期」。
 * 找不到返回 null。规则不依赖 AI。
 */
export function extractSemesterFromText(text: string): string | null {
  const t = text.replace(/\s+/g, "");
  if (!t) return null;

  // 明确的学年区间 + 秋/春季：2025-2026学年春季学期
  const yearRange = /(\d{4})-(\d{4})学年?(?:第?([一二])学期|(秋|春)季)?/.exec(t);
  if (yearRange) {
    const start = Number(yearRange[1]);
    const term = yearRange[3] === "二" || yearRange[4] === "春" ? 2 : 1;
    return `${start}-${start + 1}-${term}`;
  }

  // 单年份 + 秋/春季：2026年秋季
  const singleAutumnSpring = /(\d{4})年?(秋|春)季/.exec(t);
  if (singleAutumnSpring) {
    const start = Number(singleAutumnSpring[1]);
    const term = singleAutumnSpring[2] === "春" ? 2 : 1;
    return `${start}-${start + 1}-${term}`;
  }

  // 单年份 + 第几学期：2026学年第一学期
  const singleTerm = /(\d{4})学年?第?([一二])学期/.exec(t);
  if (singleTerm) {
    const start = Number(singleTerm[1]);
    const term = singleTerm[2] === "二" ? 2 : 1;
    return `${start}-${start + 1}-${term}`;
  }

  return null;
}

/** 解析模型输出为 {grade, semester}；非法值一律置 null（防幻觉） */
export function parseGradeSemesterReply(raw: string): {
  grade: number | null;
  semester: string | null;
} {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return { grade: null, semester: null };
  try {
    const parsed = JSON.parse(match[0]) as { grade?: unknown; semester?: unknown };
    const gradeNum = Number(parsed.grade);
    const grade = Number.isInteger(gradeNum) && gradeNum >= 1 && gradeNum <= 6 ? gradeNum : null;
    const semester =
      typeof parsed.semester === "string" && SEMESTER_RE.test(parsed.semester.trim())
        ? parsed.semester.trim()
        : null;
    return { grade, semester };
  } catch {
    return { grade: null, semester: null };
  }
}

const SYSTEM_PROMPT =
  "你是班级信息识别助手。根据给出的文本判断这个班级的「年级（1~6 的整数）」和「起始学期」。" +
  "学期格式必须是 YYYY-YYYY-1（秋季）或 YYYY-YYYY-2（春季），例如 2026-2027-1。" +
  "无法确定时对应字段填 null。只输出 JSON，形如 {\"grade\": 3, \"semester\": \"2026-2027-1\"}，不要任何解释。";

function buildMessages(lines: string[]): AgentMessage[] {
  return [{ role: "user", content: `文本：\n${lines.join("\n")}` }];
}

/**
 * 综合识别年级与学期：规则优先，规则识别不出时（且已配置模型）才调用 AI。
 * options.llm / options.aiReady 供单测注入替身。
 */
export async function inferGradeSemester(
  lines: string[],
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<GradeSemesterGuess> {
  const text = lines.filter(Boolean).join(" ").trim();
  if (!text) return { grade: null, semester: null, method: "rule" };

  const ruleGrade = inferGradeFromName(text);
  const ruleSemester = extractSemesterFromText(text);
  if (ruleGrade != null && ruleSemester != null) {
    return { grade: ruleGrade, semester: ruleSemester, method: "rule" };
  }

  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return { grade: ruleGrade, semester: ruleSemester, method: "rule" };

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({ system: SYSTEM_PROMPT, messages: buildMessages(lines), tools: [], config });
    const parsed = parseGradeSemesterReply(res.content);
    // 规则命中的字段优先于模型（模型只补规则缺失的部分）
    return {
      grade: ruleGrade ?? parsed.grade,
      semester: ruleSemester ?? parsed.semester,
      method: "ai",
    };
  } catch {
    return { grade: ruleGrade, semester: ruleSemester, method: "rule" };
  }
}

/**
 * 导入收尾的便捷入口：识别年级/学期并补写班级元信息。
 * 只在班级尚未登记对应字段时补写（不覆盖老师已手动设置的），失败静默返回 null。
 * 供花名册 / 成绩导入完成后调用；不阻塞导入主流程。
 */
export async function applyInferredClassMeta(
  className: string,
  lines: string[],
  options: { llm?: AgentLlm; aiReady?: boolean } = {}
): Promise<GradeSemesterGuess | null> {
  const name = className.trim();
  if (!name) return null;
  try {
    const guess = await inferGradeSemester([name, ...lines], options);
    if (guess.grade == null && guess.semester == null) return null;
    const current = await getClassMeta(name);
    const patch: { entry_grade?: number; entry_semester?: string } = {};
    if (current.entry_grade == null && guess.grade != null) patch.entry_grade = guess.grade;
    if (current.entry_semester == null && guess.semester != null) patch.entry_semester = guess.semester;
    if (Object.keys(patch).length) await saveClassMeta(name, patch);
    return guess;
  } catch {
    return null;
  }
}
