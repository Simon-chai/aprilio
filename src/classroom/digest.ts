/**
 * 课堂小结（数据版）+ 下课编排。
 *
 * 分层与 spec §8 一致：
 * - computeLessonStats / renderDataDigest 是**纯函数**（无 db、无 Date 依赖除「进行中会话的当前时刻」）
 * - generateLessonDigest：AI 优先（digest-ai），未配置 / 演示态 / 失败 → 数据版，**永不抛错**
 * - finishLesson：读名单（含缺勤）+ 未撤销事件 + 沉默读模型 → 生成 → db.endLessonSession 落库
 *
 * 事件流是唯一事实源：stats 全部由未撤销事件聚合而来，与活动 reduce 同口径。
 */
import { endLessonSession, lastPickedAtByStudent, listLessonEvents } from "../lib/db";
import { buildClassroomRoster } from "./seating";
import { generateAiLessonDigest } from "./digest-ai";
import type { ClassroomStudent, LessonEvent, LessonSession, LessonStats } from "./types";

export interface DigestInput {
  session: LessonSession;
  /** 全班在册（含缺勤） */
  roster: ClassroomStudent[];
  /** 未撤销事件全量（调用方保证已过滤 revoked） */
  events: LessonEvent[];
  /** 沉默读模型（编排层注入，保持纯函数） */
  daysSincePicked?: (studentId: number) => number | null;
}

export interface LessonDigestResult {
  stats: LessonStats;
  digest_md: string;
  digest_source: "ai" | "data";
}

/* ------------------------------------------------------------------ */
/* stats 聚合（纯函数）                                                  */
/* ------------------------------------------------------------------ */

/** 「从未被点」（days = null）排序权重：比任何实际天数都更久 */
const NEVER_PICKED_DAYS = Number.MAX_SAFE_INTEGER;

function silenceRank(days: number | null): number {
  return days === null ? NEVER_PICKED_DAYS : days;
}

/**
 * 事件聚合 → 下课统计快照（形状严格对齐 types.ts 的 LessonStats）。
 * 已撤销事件一律跳过（调用方已过滤时本步骤为幂等兜底）。
 */
export function computeLessonStats(input: DigestInput): LessonStats {
  const events = input.events.filter((ev) => ev.revoked_at === null);
  const nameOf = new Map(input.roster.map((s) => [s.id, s.name]));
  const name = (id: number) => nameOf.get(id) ?? `#${id}`;

  const absentIds = collectAbsentIds(events);
  const inClass = input.roster.filter((s) => !absentIds.has(s.id));

  /* 点名：人次 + 覆盖率 */
  const pickCounts = new Map<number, number>();
  for (const ev of events) {
    if (ev.kind !== "pick" || ev.student_id == null) continue;
    pickCounts.set(ev.student_id, (pickCounts.get(ev.student_id) ?? 0) + 1);
  }
  const picks = [...pickCounts.entries()]
    .map(([student_id, count]) => ({ student_id, student_name: name(student_id), count }))
    .sort((a, b) => b.count - a.count || a.student_id - b.student_id);
  const pick_coverage = inClass.length
    ? Math.min(1, pickCounts.size / inClass.length)
    : 0;

  /* 表扬 / 待改进 + 本课有表现记录的学生（沉默判定用） */
  let praise_count = 0;
  let improve_count = 0;
  const touched = new Set<number>();
  for (const ev of events) {
    if (ev.kind !== "behavior" || ev.student_id == null) continue;
    touched.add(ev.student_id);
    const type = ev.payload?.type;
    if (type === "praise") praise_count++;
    else if (type === "improve") improve_count++;
  }

  /* 小组分：组号取「名单里的组 ∪ 事件里的组」，事件里没有分的组显示 0（不双源漂移） */
  const scoreByGroup = new Map<number, number>();
  for (const s of input.roster) {
    if (s.group_no > 0 && !scoreByGroup.has(s.group_no)) scoreByGroup.set(s.group_no, 0);
  }
  for (const ev of events) {
    if (ev.kind !== "group_point") continue;
    const groupNo = Number(ev.payload?.group_no);
    const delta = Number(ev.payload?.delta);
    if (!Number.isFinite(groupNo) || groupNo < 0 || !Number.isFinite(delta)) continue;
    scoreByGroup.set(groupNo, (scoreByGroup.get(groupNo) ?? 0) + delta);
  }
  const groups = [...scoreByGroup.entries()]
    .map(([group_no, score]) => ({ group_no, score }))
    .sort((a, b) => a.group_no - b.group_no);

  /* 沉默预警：本课未被点到、也没有任何表现记录 → 按「距上次被点」降序（从未被点排最前） */
  const days = input.daysSincePicked ?? (() => null);
  const silent = inClass
    .filter((s) => !pickCounts.has(s.id) && !touched.has(s.id))
    .map((s) => ({ student_id: s.id, student_name: s.name, days: days(s.id) }))
    .sort((a, b) => silenceRank(b.days) - silenceRank(a.days));

  return {
    picks,
    pick_coverage,
    praise_count,
    improve_count,
    absent: input.roster
      .filter((s) => absentIds.has(s.id))
      .map((s) => ({ student_id: s.id, student_name: s.name })),
    groups,
    silent,
    duration_min: lessonDurationMin(input.session),
  };
}

/** attendance 事件聚合：末条未撤销事件定状态（absent === true 缺勤，false 归班） */
function collectAbsentIds(events: LessonEvent[]): Set<number> {
  const absent = new Set<number>();
  for (const ev of events) {
    if (ev.kind !== "attendance" || ev.student_id == null) continue;
    if (ev.payload?.absent === true) absent.add(ev.student_id);
    else absent.delete(ev.student_id);
  }
  return absent;
}

/** 课长（分钟）：started_at → ended_at（未下课取当前时刻），解析失败按 0 */
function lessonDurationMin(session: LessonSession): number {
  const start = toMs(session.started_at);
  if (start === null) return 0;
  const end = toMs(session.ended_at) ?? Date.now();
  return Math.max(0, Math.round((end - start) / 60000));
}

/** "YYYY-MM-DD HH:MM:SS" → 毫秒（SQLite localtime 与 ISO 两种格式都吃） */
function toMs(ts: string | null): number | null {
  if (!ts) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(ts);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0),
    ).getTime();
  }
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ */
/* 数据版小结模板（纯函数）                                              */
/* ------------------------------------------------------------------ */

/** 数据版小结 markdown：覆盖率 / 表扬 / 待改进 / 小组分 / 缺勤 / 沉默预警 / 时长 */
export function renderDataDigest(stats: LessonStats, session: LessonSession): string {
  const periodText = session.period === null ? "临时课堂" : `第 ${session.period} 节`;
  const head = [session.class_name, session.subject].filter(Boolean).join(" · ");
  const lines: string[] = [
    `# ${head} 课堂小结`,
    "",
    `> ${session.lesson_date} ${periodText} · 课长 ${stats.duration_min} 分钟 · 数据版小结`,
    "",
    "## 点名与参与",
    `- 点名 ${sumPicks(stats)} 人次，覆盖 ${stats.picks.length} 人（覆盖率 ${coverageText(stats)}）`,
  ];
  const inClassCount = stats.picks.length + stats.silent.length;
  if (!stats.picks.length) lines.push("- 本节课未点名");
  if (inClassCount > 0 && !stats.silent.length) lines.push("- 全体在班同学均有参与记录");

  lines.push("", "## 表现记录", `- 表扬 ${stats.praise_count} 条 · 待改进 ${stats.improve_count} 条`);
  if (!stats.praise_count) lines.push("- 本节课暂无表扬记录，可多给具体肯定");
  if (stats.improve_count) lines.push("- 待改进已记入学生档案，建议课后单独轻声提醒");

  lines.push("", "## 小组积分");
  const leader = groupLeader(stats);
  if (!stats.groups.length) lines.push("- 本节课没有小组数据（座位未分组或未使用小组活动）");
  else if (!leader) lines.push("- 各组均暂无加分");
  else {
    for (const g of stats.groups) {
      lines.push(`- 第 ${g.group_no} 组 ${g.score} 分${g.group_no === leader.group_no ? "（领先）" : ""}`);
    }
  }

  lines.push("", "## 缺勤");
  lines.push(
    stats.absent.length
      ? `- ${stats.absent.map((a) => a.student_name).join("、")}（共 ${stats.absent.length} 人）`
      : "- 本次课无缺勤记录",
  );

  lines.push("", "## 沉默预警");
  if (stats.silent.length) {
    lines.push("- 本节课既未被点到也无表现记录，建议下次优先关注：");
    for (const s of stats.silent) {
      lines.push(`- ${s.student_name}（${s.days === null ? "从未被点到" : `${s.days} 天未被点到`}）`);
    }
  } else {
    lines.push("- 无沉默预警，课堂参与度良好");
  }

  return lines.join("\n");
}

function sumPicks(stats: LessonStats): number {
  return stats.picks.reduce((sum, p) => sum + p.count, 0);
}

function coverageText(stats: LessonStats): string {
  return `${Math.round(stats.pick_coverage * 100)}%`;
}

/** 领先组：分数最高且 > 0；全 0 或空返回 null（P0 不做并列展示） */
function groupLeader(stats: LessonStats): { group_no: number; score: number } | null {
  const top = stats.groups.reduce<{ group_no: number; score: number } | null>(
    (best, g) => (g.score > (best?.score ?? 0) ? g : best),
    null,
  );
  return top && top.score > 0 ? top : null;
}

/* ------------------------------------------------------------------ */
/* 生成与下课编排                                                        */
/* ------------------------------------------------------------------ */

/**
 * 生成小结：AI 优先，未配置 / 演示态 / 失败 → 数据版；**永不抛错**（弃课流程不可被小结阻塞）。
 */
export async function generateLessonDigest(input: DigestInput): Promise<LessonDigestResult> {
  const stats = computeLessonStats(input);
  const data_md = renderDataDigest(stats, input.session);
  try {
    const ai_md = await generateAiLessonDigest(input, stats);
    if (ai_md && ai_md.trim()) {
      return { stats, digest_md: ai_md.trim(), digest_source: "ai" };
    }
  } catch (e) {
    // digest-ai 内部已兜底，这里再兜一层：小结生成永远不阻塞下课
    console.error("[classroom] 小结 AI 生成失败，回退数据版", e);
  }
  return { stats, digest_md: data_md, digest_source: "data" };
}

/**
 * 下课编排：读「全班在册（含缺勤）」+ 未撤销事件 + 沉默读模型 → 生成 → 落库。
 * 数据集会对话进行中调用（预览）：此时 ended_at 为空，stats 用当前时刻算课长。
 */
export async function finishLesson(session: LessonSession): Promise<LessonDigestResult> {
  const roster = await buildClassroomRoster(session.class_name, session.lesson_date);
  const events = await listLessonEvents(session.id);
  const lastPicked = await lastPickedAtByStudent(
    roster.students.map((s) => s.id),
    localTs(),
  );
  const daysSincePicked = (studentId: number): number | null => {
    const ts = lastPicked.get(studentId);
    return ts ? daysBetween(ts) : null;
  };

  const result = await generateLessonDigest({
    session,
    roster: roster.students,
    events,
    daysSincePicked,
  });
  await endLessonSession(session.id, {
    stats: result.stats,
    digest_md: result.digest_md,
    digest_source: result.digest_source,
  });
  return result;
}

/** 本地时间戳（与 SQLite datetime('now','localtime') 同格式，沉默读模型的上界） */
function localTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 「距上次被点 N 天」：按本地日期差（同天 = 0） */
function daysBetween(ts: string): number | null {
  const datePart = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const [y, m, d] = datePart.split("-").map(Number);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((todayStart.getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
}