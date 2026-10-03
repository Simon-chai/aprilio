/**
 * 课堂小结 AI 增强层（report-ai 同款降级范式）：
 * - 已配置模型 且 桌面端 → 由 stats 事实表生成教师口吻小结（markdown）
 * - 未配置 / 浏览器演示态 / 调用失败 / 返回空 → 返回 null，由调用方回退数据版
 *
 * 红线：本模块**永不抛错、永不阻塞**下课流程；模型输出只作为文本，不改动 stats。
 */
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { isTauri } from "../lib/env";
import { createLlm } from "../agent/providers";
import { PROMPT_IDS, resolvePrompt } from "../prompts";
import type { AgentLlm, AgentMessage } from "../agent/types";
import type { DigestInput } from "./digest";
import type { LessonStats } from "./types";

export interface LessonDigestAiOptions {
  /** 测试注入（缺省走 createLlm：Tauri → Rust rig，演示态 → mock） */
  llm?: AgentLlm;
  /** 测试注入；缺省 = 桌面端且模型已配置 */
  aiReady?: boolean;
}

/** 把 stats 压成事实表：模型只做润色，不做聚合（防双源漂移） */
function buildMessages(input: DigestInput, stats: LessonStats): AgentMessage[] {
  const { session } = input;
  const periodText = session.period === null ? "临时课堂" : `第 ${session.period} 节`;
  const lines = [
    `【班级】${session.class_name}`,
    `【科目】${session.subject || "未填写"}`,
    `【时间】${session.lesson_date} ${periodText}，课长 ${stats.duration_min} 分钟`,
    `【点名】${stats.picks.reduce((sum, p) => sum + p.count, 0)} 人次，覆盖 ${stats.picks.length} 人，覆盖率 ${Math.round(stats.pick_coverage * 100)}%`,
    `【表扬】${stats.praise_count} 条；【待改进】${stats.improve_count} 条`,
    `【小组积分】${
      stats.groups.length
        ? stats.groups.map((g) => `第 ${g.group_no} 组 ${g.score} 分`).join("、")
        : "无小组数据"
    }`,
    `【缺勤】${
      stats.absent.length ? stats.absent.map((a) => a.student_name).join("、") : "无"
    }`,
    `【沉默预警】${
      stats.silent.length
        ? stats.silent
            .map((s) => `${s.student_name}（${s.days === null ? "从未被点到" : `${s.days} 天未被点到`}）`)
            .join("、")
        : "无"
    }`,
    "请据此写课堂小结。",
  ];
  return [{ role: "user", content: lines.join("\n") }];
}

/**
 * 生成 AI 版小结 markdown；不可用或失败返回 null（调用方回退数据版）。
 */
export async function generateAiLessonDigest(
  input: DigestInput,
  stats: LessonStats,
  options: LessonDigestAiOptions = {},
): Promise<string | null> {
  const config = loadAiConfig();
  const aiReady = options.aiReady ?? (isTauri() && isAiConfigured(config));
  if (!aiReady) return null;

  try {
    const llm = options.llm ?? createLlm();
    const res = await llm.chat({
      system: resolvePrompt(PROMPT_IDS.lessonDigest),
      messages: buildMessages(input, stats),
      tools: [],
      config,
    });
    const text = (res.content ?? "").trim();
    return text ? text : null;
  } catch {
    return null;
  }
}