/**
 * 工具：query_data —— 数据查询（声明式注册，default export 即被容器装载）。
 *
 * 只暴露结构化参数（实体 + 过滤条件），不把裸 SQL 交给模型：
 * 避免注入与误写，也和 lib/db.ts 的查询能力对齐。
 * 浏览器演示态走内存示例数据，桌面端走 SQLite，同一套返回结构。
 */
import {
  getStats,
  listBehaviorRecords,
  listClasses,
  listEvalReports,
  listExamScores,
  listExams,
  listHomeworkRecords,
  listLessonEvents,
  listLessonSessions,
  listPhotos,
  listStudents,
  listTermComments,
} from "../../lib/db";
import type { LessonSession } from "../../classroom/types";
import { defineAgentTool } from "../define";
import { normalizeClassName } from "./navigation";
import { semesterLabel } from "../../lib/timetable";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/* ------------------------------------------------------------------ */
/* 课堂（lessons）：节课会话 + 事件摘要                                  */
/* ------------------------------------------------------------------ */

/** 课堂会话摘要行（query_data lessons 的返回单元） */
interface LessonDigestRow {
  session_id: number;
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
  status: "live" | "ended";
  started_at: string;
  ended_at: string | null;
  /** 摘要来源：stats = 下课快照（优先，避免与事件流双源漂移）；events = 事件流现算 */
  digest_source: "stats" | "events";
  /** 点名名单（谁被点了几次，次数降序） */
  picks: Array<{ student_id: number; student_name: string; count: number }>;
  praise_count: number;
  improve_count: number;
  /** group_point 聚合的小组分（按组号升序） */
  groups: Array<{ group_no: number; score: number }>;
  absent: Array<{ student_id: number; student_name: string }>;
}

/**
 * 课堂班级名归一：「三(2)班」「三年二班」「3 年 2 班」都落成 32。
 * 复用 navigate 的班级名归一（中文数字→阿拉伯、去「级」），再抹平括号与「年/班」。
 */
function normalizeLessonClassName(raw: string): string {
  return normalizeClassName(raw)
    .replace(/[（）()]/g, "")
    .replace(/[班年]/g, "");
}

/** 班级名匹配：精确 → 归一相等 → 归一包含，逐级放宽（与 navigate 的班级解析同款） */
function matchLessonClassName(sessions: LessonSession[], input: string): LessonSession[] {
  const wanted = normalizeLessonClassName(input);
  if (!wanted) return sessions;
  const stages: LessonSession[][] = [
    sessions.filter((s) => s.class_name === input),
    sessions.filter((s) => normalizeLessonClassName(s.class_name) === wanted),
    sessions.filter((s) => {
      const n = normalizeLessonClassName(s.class_name);
      return n !== wanted && (n.includes(wanted) || wanted.includes(n));
    }),
  ];
  for (const hits of stages) if (hits.length) return hits;
  return [];
}

/** 事件流现算摘要：未知 kind 安全跳过（对齐课堂事件契约与「未知工具不崩溃」红线） */
function aggregateLessonEvents(
  events: Array<{ kind: string; student_id: number | null; payload: Record<string, unknown> }>,
  nameOf: (id: number) => string
): Pick<LessonDigestRow, "picks" | "praise_count" | "improve_count" | "groups" | "absent"> {
  const pickCounts = new Map<number, number>();
  const absentIds = new Set<number>();
  const groupScores = new Map<number, number>();
  let praiseCount = 0;
  let improveCount = 0;

  for (const ev of events) {
    if (ev.kind === "pick" && ev.student_id !== null) {
      pickCounts.set(ev.student_id, (pickCounts.get(ev.student_id) ?? 0) + 1);
    } else if (ev.kind === "behavior" && ev.student_id !== null) {
      if (ev.payload.type === "praise") praiseCount += 1;
      else if (ev.payload.type === "improve") improveCount += 1;
    } else if (ev.kind === "group_point") {
      const groupNo = Number(ev.payload.group_no);
      const delta = Number(ev.payload.delta);
      if (Number.isFinite(groupNo) && Number.isFinite(delta)) {
        groupScores.set(groupNo, (groupScores.get(groupNo) ?? 0) + delta);
      }
    } else if (ev.kind === "attendance" && ev.student_id !== null) {
      // payload.absent 为显式 false = 重新标记在班（比撤销更轻），其余一律按缺勤计
      if (ev.payload.absent === false) absentIds.delete(ev.student_id);
      else absentIds.add(ev.student_id);
    }
  }

  return {
    picks: [...pickCounts.entries()]
      .map(([student_id, count]) => ({ student_id, student_name: nameOf(student_id), count }))
      .sort((a, b) => b.count - a.count || a.student_id - b.student_id),
    praise_count: praiseCount,
    improve_count: improveCount,
    groups: [...groupScores.entries()]
      .map(([group_no, score]) => ({ group_no, score }))
      .sort((a, b) => a.group_no - b.group_no),
    absent: [...absentIds].sort((a, b) => a - b).map((id) => ({ student_id: id, student_name: nameOf(id) })),
  };
}

/** 课堂摘要：已结束且已落 stats 快照的会话优先用快照，其余由未撤销事件流现算 */
async function buildLessonDigests(sessions: LessonSession[]): Promise<LessonDigestRow[]> {
  if (!sessions.length) return [];
  const needsNames = sessions.some((s) => !(s.status === "ended" && s.stats));
  const names = new Map<number, string>();
  if (needsNames) {
    for (const s of await listStudents()) names.set(s.id, s.name);
  }
  const nameOf = (id: number) => names.get(id) ?? `学生#${id}`;

  const rows: LessonDigestRow[] = [];
  for (const s of sessions) {
    const base = {
      session_id: s.id,
      class_name: s.class_name,
      subject: s.subject,
      lesson_date: s.lesson_date,
      period: s.period,
      status: s.status,
      started_at: s.started_at,
      ended_at: s.ended_at,
    };
    const stats = s.status === "ended" ? s.stats : null;
    if (stats) {
      rows.push({
        ...base,
        digest_source: "stats",
        picks: stats.picks ?? [],
        praise_count: stats.praise_count ?? 0,
        improve_count: stats.improve_count ?? 0,
        groups: stats.groups ?? [],
        absent: stats.absent ?? [],
      });
      continue;
    }
    const events = await listLessonEvents(s.id);
    rows.push({ ...base, digest_source: "events", ...aggregateLessonEvents(events, nameOf) });
  }
  return rows;
}

/** 摘要文本：整场一行 + 点名/表现/小组分/缺勤明细（进入 LLM 上下文，保持紧凑） */
function lessonDigestLines(r: LessonDigestRow): string[] {
  const period = r.period === null ? "临时课堂" : `第${r.period}节`;
  const status = r.status === "live" ? "进行中" : "已结束";
  const span = r.ended_at ? `${r.started_at} ~ ${r.ended_at}` : r.started_at;
  const source = r.digest_source === "stats" ? "下课快照" : "事件流";
  const lines = [
    `[#${r.session_id}] ${r.class_name} · ${r.subject || "未填科目"} · ${r.lesson_date} ${period} · ${status}（${span}）· 摘要来源：${source}`,
    r.picks.length
      ? `  点名 ${r.picks.length} 人：${r.picks.map((p) => `${p.student_name}×${p.count}`).join("、")}`
      : "  点名：暂无记录",
    `  表扬 ${r.praise_count} 次 / 待改进 ${r.improve_count} 次`,
  ];
  if (r.groups.length) {
    lines.push(`  小组分：${r.groups.map((g) => `第${g.group_no}组 ${g.score} 分`).join("、")}`);
  }
  if (r.absent.length) lines.push(`  缺勤：${r.absent.map((a) => a.student_name).join("、")}`);
  return lines;
}

/** 隐私注意：返回值会进入 LLM 上下文。云 API 场景的脱敏策略见 docs/AGENT.md */
export default defineAgentTool({
  name: "query_data",
  label: "数据查询",
  description:
    "查询应用数据库：学生档案（students）、照片记录（photos）、汇总统计（stats）、日常表现（behaviors）、考试批次（exams）、成绩明细（scores）、作业台账（homeworks）、评价报告存档（eval_reports）、课堂记录（lessons）。" +
    "数据分析、数量统计、条件筛选都用它；查成绩统计与排名时先用它拿到班级/考试/学生 ID，再配合 analyze 工具做深度分析。" +
    "课堂记录（lessons）按班级名与日期查节课会话及其点名、表扬/待改进、小组分、缺勤摘要——" +
    "「今天数学课点了谁」「这节课点了哪些人」这类课堂提问用它（class_name 宽容口语差异，如「三年二班」≈「三年级二班」）。",
  tags: ["readonly"],
  parameters: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        enum: ["students", "photos", "stats", "behaviors", "exams", "scores", "classes", "term_comments", "homeworks", "eval_reports", "lessons"],
        description: "查询实体",
      },
      keyword: {
        type: "string",
        description:
          "关键词：students 按姓名/学号模糊匹配；photos 按说明/文件名匹配；behaviors 按评语/维度名匹配；exams 按考试名匹配；scores 忽略；stats 忽略",
      },
      exam_type: {
        type: "string",
        enum: ["major", "minor"],
        description: "考试种类过滤，仅 exams 生效：major 大考（期中/期末）| minor 小考（单元/月考等）",
      },
      grade_class: {
        type: "string",
        description: "班级过滤，如「四年级一班」，仅 students、exams、scores 生效",
      },
      student_id: {
        type: "number",
        description: "按学生 ID 过滤，仅 photos、behaviors、scores 生效",
      },
      exam_id: {
        type: "number",
        description: "按考试批次 ID 过滤成绩明细，仅 scores 生效（先用 exams 实体拿到 ID）",
      },
      subject: {
        type: "string",
        description: "按科目过滤成绩明细，如「语文」，仅 scores 生效",
      },
      polarity: {
        type: "string",
        enum: ["praise", "improve", "neutral"],
        description: "按评价倾向过滤表现流水：praise（表扬）| improve（待改进）| neutral（中立），仅 behaviors 生效",
      },
      dimension_name: {
        type: "string",
        description: "按表现维度名称过滤，如「课堂表现」、「作业情况」，仅 behaviors 生效",
      },
      semester: {
        type: "string",
        description: "学期号过滤，如「2026-2027-1」，仅 term_comments 生效",
      },
      class_name: {
        type: "string",
        description:
          "班级名过滤，仅 lessons 生效；宽容口语差异（「三年二班」≈「三年级二班」，「三(2)班」也可识别）",
      },
      date: {
        type: "string",
        description: "按上课日期（YYYY-MM-DD）过滤，仅 lessons 生效；「今天」请自行换算成具体日期",
      },
      start: {
        type: "string",
        description: "上课日期区间起点（YYYY-MM-DD，闭区间），仅 lessons 生效；与 date 二选一",
      },
      end: {
        type: "string",
        description: "上课日期区间终点（YYYY-MM-DD，闭区间），仅 lessons 生效；与 date 二选一",
      },
      limit: {
        type: "number",
        description: "最多返回条数，默认 20，上限 100",
      },
    },
    required: ["entity"],
  },
  async execute(args) {
    const entity = String(args.entity ?? "");
    const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
    const limit = clampLimit(args.limit);

    if (entity === "students") {
      const all = await listStudents(keyword);
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const filtered = gradeClass
        ? all.filter((s) => (s.grade_class ?? "").includes(gradeClass))
        : all;
      const rows = filtered.slice(0, limit);
      return {
        ok: true,
        summary: `学生查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "photos") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const all = await listPhotos(studentId);
      const filtered = keyword
        ? all.filter(
            (p) =>
              (p.caption ?? "").includes(keyword) || p.file_name.toLowerCase().includes(keyword.toLowerCase()),
          )
        : all;
      const rows = filtered.slice(0, limit);
      return {
        ok: true,
        summary: `照片查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "stats") {
      const stats = await getStats();
      return { ok: true, summary: `应用统计：${JSON.stringify(stats)}`, data: stats };
    }

    if (entity === "exams") {
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const examType = args.exam_type === "major" || args.exam_type === "minor" ? args.exam_type : "";
      const all = await listExams(gradeClass || undefined);
      const filtered = all
        .filter((e) => (examType ? e.exam_type === examType : true))
        .filter((e) => (keyword ? e.name.includes(keyword) || e.class_name.includes(keyword) : true));
      const rows = filtered.slice(0, limit);
      const summary = rows
        .map(
          (e) =>
            `[#${e.id}] ${e.class_name || "未分班"} · ${e.name}（${e.exam_date}，${e.exam_type === "major" ? "大考" : "小考"}）· 科目 ${e.subject_count} · 成绩 ${e.score_count} 条 · 学生 ${e.student_count} 人`,
        )
        .join("\n");
      return {
        ok: true,
        summary: `考试批次查询：命中 ${filtered.length} 场，返回前 ${rows.length} 场。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "scores") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const examId = Number.isInteger(Number(args.exam_id)) ? Number(args.exam_id) : undefined;
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      const rows = await listExamScores({
        examId,
        studentId,
        subject: subject || undefined,
        className: gradeClass || undefined,
        limit,
      });
      const summary = rows
        .map(
          (r) =>
            `${r.student_name}（${r.student_no ?? "无学号"}）· ${r.subject} · ${
              r.score !== null ? r.score : (r.grade ?? "—")
            }`,
        )
        .join("\n");
      return {
        ok: true,
        summary: `成绩明细查询：命中 ${rows.length} 条（上限 ${limit}）。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "behaviors") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const all = await listBehaviorRecords(studentId, 100);
      const polarity = typeof args.polarity === "string" ? args.polarity.trim() : "";
      const dimensionName = typeof args.dimension_name === "string" ? args.dimension_name.trim() : "";

      const filtered = all.filter((r) => {
        if (polarity && r.type !== polarity) return false;
        if (dimensionName && r.dimension_name_snap !== dimensionName) return false;
        if (keyword && !r.comment.includes(keyword) && !r.dimension_name_snap.includes(keyword)) {
          return false;
        }
        return true;
      });

      const rows = filtered.slice(0, limit);
      const rowsSummary = rows
        .map((r) => {
          const icon = r.type === "praise" ? "👍" : r.type === "neutral" ? "➖" : "⚠️";
          const suffix = studentId === undefined ? ` (学生ID: ${r.student_id})` : "";
          return `[${r.recorded_date}] ${r.dimension_name_snap} ${icon} ${r.comment}${suffix}`;
        })
        .join("\n");

      return {
        ok: true,
        summary: `日常表现查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${rowsSummary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "classes") {
      const all = await listClasses();
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const filtered = all.filter((c) => {
        if (gradeClass && !c.name.includes(gradeClass)) return false;
        if (keyword && !c.name.includes(keyword)) return false;
        return true;
      });
      const rows = filtered.slice(0, limit);
      const summary = rows
        .map((c) => {
          const state = c.archived_at ? `已归档（${c.archived_at.slice(0, 10)}）` : "在用";
          return `${c.name} · ${state} · 学生 ${c.studentCount} 人`;
        })
        .join("\n");
      return {
        ok: true,
        summary: `班级查询：命中 ${filtered.length} 个，返回前 ${rows.length} 个。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "term_comments") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      if (studentId === undefined) {
        return { ok: false, summary: "", error: "term_comments 需要 student_id" };
      }
      const semester = typeof args.semester === "string" ? args.semester.trim() : "";
      const all = await listTermComments(studentId);
      const filtered = semester ? all.filter((c) => c.semester === semester) : all;
      const rows = filtered.slice(0, limit);
      const summary = rows
        .map((c) => `${semesterLabel(c.semester)}（${c.source === "ai" ? "AI 草稿" : "手工"}）：${c.content}`)
        .join("\n");
      return {
        ok: true,
        summary: `学期评语查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "homeworks") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      if (studentId !== undefined) {
        const rows = await listHomeworkRecords(studentId, { subject: subject || undefined, limit });
        const summary = rows.map((r) => `[${r.homework_date}] ${r.subject} ${r.status}${r.comment ? ` ${r.comment}` : ""}`).join("\n");
        return {
          ok: true,
          summary: `作业台账查询：命中 ${rows.length} 条。\n${summary || JSON.stringify(rows)}`,
          data: rows,
        };
      }
      // 未带 student_id 时按姓名关键词兜底：先定位学生再聚合其作业
      if (keyword) {
        const students = await listStudents(keyword);
        const hits = students.filter((s) => s.name.includes(keyword)).slice(0, 3);
        if (!hits.length) {
          return { ok: false, summary: "", error: `找不到姓名含「${keyword}」的学生，请提供 student_id。` };
        }
        const all: unknown[] = [];
        for (const s of hits) {
          const rows = await listHomeworkRecords(s.id, { subject: subject || undefined, limit });
          for (const r of rows) all.push({ ...r, student_name: s.name });
        }
        const rows = (all as unknown as { homework_date: string; id: number }[])
          .sort((a, b) => (a.homework_date < b.homework_date ? 1 : -1) || b.id - a.id)
          .slice(0, limit);
        const summary = (
          rows as unknown as { homework_date: string; subject: string; status: string; student_name: string }[]
        )
          .map((r) => `${r.student_name} [${r.homework_date}] ${r.subject} ${r.status}`)
          .join("\n");
        return {
          ok: true,
          summary: `作业台账查询：命中 ${rows.length} 条。\n${summary || JSON.stringify(rows)}`,
          data: rows,
        };
      }
      return { ok: false, summary: "", error: "homeworks 需要 student_id（或用 keyword 带学生姓名兜底）" };
    }

    if (entity === "eval_reports") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      if (studentId === undefined) {
        return { ok: false, summary: "", error: "eval_reports 需要 student_id" };
      }
      const rows = await listEvalReports(studentId, limit);
      const summary = rows.map((r) => `${r.title}（${r.range_start}~${r.range_end}）：${r.short_comment || r.content_md.slice(0, 60)}`).join("\n");
      return {
        ok: true,
        summary: `评价报告查询：命中 ${rows.length} 条。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "lessons") {
      const className = typeof args.class_name === "string" ? args.class_name.trim() : "";
      const lessonDate = typeof args.date === "string" ? args.date.trim() : "";
      const start = typeof args.start === "string" ? args.start.trim() : "";
      const end = typeof args.end === "string" ? args.end.trim() : "";
      // 班级名在工具内做宽容匹配，因此带班级名时不先限条数（避免先截断再筛丢命中）
      const sessions = await listLessonSessions({
        lesson_date: lessonDate || undefined,
        start: start || undefined,
        end: end || undefined,
        limit: className ? undefined : limit,
      });
      const matched = className ? matchLessonClassName(sessions, className) : sessions;
      const rows = await buildLessonDigests(matched.slice(0, limit));
      const lines = rows.flatMap(lessonDigestLines).join("\n");
      return {
        ok: true,
        summary: `课堂查询：命中 ${matched.length} 场，返回前 ${rows.length} 场。\n${
          lines || "（没有符合条件的课堂记录：可用 class_name / date 收窄，或确认是否已开课）"
        }`,
        data: rows,
      };
    }

    return {
      ok: false,
      summary: "",
      error: `未知查询实体 "${entity}"，可选：students、photos、stats、behaviors、exams、scores、classes、term_comments、homeworks、eval_reports、lessons。`,
    };
  },
});
