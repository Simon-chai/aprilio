/**
 * 学生评价卡片（spec：docs/EVAL_CARD.md）——数据聚合与视图模型层。
 * 把学生指定周期内的成绩 / 表现 / 作业聚合成卡片视图模型：纯逻辑、可测、不碰 DOM。
 * 分层：本文件（聚合）→ eval-card-template.ts（A 版 HTML 模板）→ html-to-png.ts（转 PNG）
 * → eval-card-export.ts（保存编排）→ components/EvalCardDialog.vue（界面）。
 * 口径说明：成绩复用 getStudentScoreReport（与学生档案「成绩」页 / AI 分析同源）；
 * 行为只取 praise 做亮点（卡片面向家长，待改进项不上卡）；作业按时率复用 homework.ts 汇总。
 */
import {
  getProfile,
  getStudent,
  getStudentScoreReport,
  getTermComment,
  listBehaviorRecords,
  listHomeworkRecords,
} from "./db";
import { localDateStr } from "./format";
import { summarizeHomeworks } from "./homework";
import { round1 } from "./score-analysis";
import { currentSemester, semesterLabel, semesterOfDate } from "./timetable";
import type { StudentBehaviorRecord, StudentExamSubject } from "../types";

/** 统计周期预设：本月 / 上月 / 本学期 / 自定义区间 */
export type EvalCardPeriodPreset = "thisMonth" | "lastMonth" | "thisSemester" | "custom";

/** 一次统计的区间与展示标签（start/end 均为含端点的 YYYY-MM-DD） */
export interface EvalCardRange {
  start: string;
  end: string;
  label: string;
}

/** 卡片顶部三枚综合胶囊：学习 / 表现 / 作业（无对应数据时整个 chip 隐藏） */
export interface EvalCardChip {
  key: "study" | "behavior" | "homework";
  label: string;
  value: string;
}

/** 成绩区的一科（数字分科目，条形宽度按百分制） */
export interface EvalCardSubjectBar {
  subject: string;
  score: number;
}

/** 亮点时间线的一条：MM-DD + 记录评语（空评语回落维度名） */
export interface EvalCardMoment {
  date: string;
  text: string;
}

/** 卡片视图模型：模板只认这个结构，不接触数据库 */
export interface EvalCardView {
  name: string;
  className: string;
  /** 头像圆里的字：取名字的首字（去姓），双字名取名首字 */
  avatarChar: string;
  periodLabel: string;
  stars: number;
  ratingLabel: string;
  chips: EvalCardChip[];
  /** 周期内最近一次考试；null 时整个成绩区隐藏 */
  score: null | {
    title: string;
    subtitle: string;
    subjects: EvalCardSubjectBar[];
    /** 总结行（总分变化 / 排名），tone 决定箭头与颜色 */
    rankNote: string;
    noteTone: "up" | "down" | "flat";
  };
  tags: string[];
  moments: EvalCardMoment[];
  /** 本学期评语原文；对话框里可改，改后以编辑值为准 */
  comment: string;
  teacherName: string;
  dateLabel: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

const isoOf = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

/** 自定义区间是否合法：YYYY-MM-DD 且 start ≤ end */
export function isValidEvalCardRange(start: string, end: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
}

/** 周期解析（now 参数供测试注入） */
export function evalCardRange(
  preset: EvalCardPeriodPreset,
  custom: { start: string; end: string },
  now: Date = new Date()
): EvalCardRange {
  const today = localDateStr(now);
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  if (preset === "thisMonth") {
    return { start: isoOf(y, m, 1), end: today, label: `${y} 年 ${m} 月` };
  }
  if (preset === "lastMonth") {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    const lastDay = new Date(py, pm, 0).getDate();
    return { start: isoOf(py, pm, 1), end: isoOf(py, pm, lastDay), label: `${py} 年 ${pm} 月` };
  }
  if (preset === "thisSemester") {
    const sem = currentSemester(now);
    const startYear = Number(sem.slice(0, 4));
    const isFall = sem.endsWith("-1");
    return {
      start: isoOf(isFall ? startYear : startYear + 1, isFall ? 9 : 3, 1),
      end: today,
      label: semesterLabel(sem),
    };
  }
  // custom：调用方先经 isValidEvalCardRange 校验
  const { start, end } = custom;
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const fmt = (d: string) => (sameYear ? d.slice(5).replace("-", ".") : d.replace(/-/g, "."));
  return { start, end, label: `${fmt(start)} – ${fmt(end)}` };
}

/**
 * 综合星级（启发式，写进 spec 便于后续调参）：
 * 基础 3 星；总排名前 30% +1、后 30% -1；表扬 ≥5 次 +1；待改进 ≥3 次 -1；
 * 作业按时率 ≥90% +1、<60% -1；收敛到 1–5 星。缺数据的维度不计分。
 */
export function computeEvalCardStars(input: {
  rankPct: number | null;
  praiseCount: number;
  improveCount: number;
  onTimeRate: number | null;
}): number {
  let stars = 3;
  if (input.rankPct !== null) {
    if (input.rankPct <= 0.3) stars += 1;
    else if (input.rankPct > 0.7) stars -= 1;
  }
  if (input.praiseCount >= 5) stars += 1;
  if (input.improveCount >= 3) stars -= 1;
  if (input.onTimeRate !== null) {
    if (input.onTimeRate >= 0.9) stars += 1;
    else if (input.onTimeRate < 0.6) stars -= 1;
  }
  return Math.min(5, Math.max(1, stars));
}

function ratingLabelOf(stars: number): string {
  if (stars >= 4) return "优秀";
  if (stars === 3) return "良好";
  if (stars === 2) return "进步中";
  return "继续加油";
}

function subjectsOf(subjects: StudentExamSubject[]): EvalCardSubjectBar[] {
  return subjects
    .filter((s): s is StudentExamSubject & { score: number } => s.score !== null)
    .map((s) => ({ subject: s.subject, score: s.score }));
}

function chipOf(
  key: EvalCardChip["key"],
  label: string,
  value: string | null
): EvalCardChip | null {
  return value === null || value === "" ? null : { key, label, value };
}

/** 聚合指定学生在指定周期内的全部卡片数据 */
export async function aggregateEvalCard(
  studentId: number,
  range: EvalCardRange
): Promise<EvalCardView> {
  const student = await getStudent(studentId);
  if (!student) throw new Error("学生不存在");

  const [profile, report, behaviors, homeworks] = await Promise.all([
    getProfile(),
    getStudentScoreReport(studentId),
    listBehaviorRecords(studentId, 500),
    listHomeworkRecords(studentId, { start: range.start, end: range.end, limit: 500 }),
  ]);

  // 行为按 recorded_date 过滤（列表按 created_at 倒序，量级取 500 条足够覆盖一个学期）
  const inRange = behaviors.filter(
    (b: StudentBehaviorRecord) => b.recorded_date >= range.start && b.recorded_date <= range.end
  );
  const praises = inRange.filter((b) => b.type === "praise");
  const improves = inRange.filter((b) => b.type === "improve");
  const homework = summarizeHomeworks(homeworks);
  const homeworkValid = homework.total - homework.exempt > 0;

  // 成绩：周期内最近一次考试（报告按考试时间倒序）
  const exam =
    (report?.exams ?? []).find(
      (e) => e.exam_date.slice(0, 10) >= range.start && e.exam_date.slice(0, 10) <= range.end
    ) ?? null;
  const subjects = exam ? subjectsOf(exam.subjects) : [];
  const studyAvg = subjects.length
    ? String(round1(subjects.reduce((a, b) => a + b.score, 0) / subjects.length))
    : null;

  const rankPct =
    exam && exam.class_total_rank !== null && exam.class_student_count > 0
      ? exam.class_total_rank / exam.class_student_count
      : null;
  const stars = computeEvalCardStars({
    rankPct,
    praiseCount: praises.length,
    improveCount: improves.length,
    onTimeRate: homework.onTimeRate,
  });

  // 亮点标签：表扬维度计数 top3 + 作业按时
  const tagCounts = new Map<string, number>();
  for (const b of praises) {
    const key = b.dimension_name_snap.trim() || "表现";
    tagCounts.set(key, (tagCounts.get(key) ?? 0) + 1);
  }
  const tags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  if (homeworkValid) {
    tags.push(`作业按时 ${homework.excellent + homework.done}/${homework.total - homework.exempt}`);
  }

  // 亮点时间线：表扬记录按日期倒序取 3 条（空评语回落维度名）
  const moments = [...praises]
    .sort((a, b) => (a.recorded_date < b.recorded_date ? 1 : -1) || b.id - a.id)
    .slice(0, 3)
    .map((b) => ({
      date: b.recorded_date.slice(5),
      text: b.comment.trim() || b.dimension_name_snap.trim() || "表现突出",
    }));

  // 成绩总结行：总分变化 + 班级排名（等级制考试无总分时只给排名 / 等级）
  let rankNote = "";
  let noteTone: "up" | "down" | "flat" = "flat";
  if (exam) {
    const parts: string[] = [];
    if (exam.total !== null && exam.total_delta !== null && exam.total_delta !== 0) {
      parts.push(
        exam.total_delta > 0
          ? `总分较上次提高 ${formatNum(exam.total_delta)} 分`
          : `总分较上次下降 ${formatNum(-exam.total_delta)} 分`
      );
      noteTone = exam.total_delta > 0 ? "up" : "down";
    }
    if (exam.total !== null && parts.length === 0) {
      parts.push(`总分 ${formatNum(exam.total)}`);
    }
    if (exam.class_total_rank !== null) {
      parts.push(
        `班级第 ${exam.class_total_rank} 名（共 ${exam.class_student_count} 人）`
      );
    }
    if (exam.total === null && exam.total_grade) {
      parts.unshift(`综合等级 ${exam.total_grade}`);
    }
    rankNote = parts.join("，");
  }

  const termComment = await getTermComment(studentId, semesterOfDate(range.end));

  const chips = [
    chipOf("study", "学习", studyAvg),
    chipOf(
      "behavior",
      "表现",
      inRange.length === 0 ? null : praises.length >= 3 ? "优" : praises.length >= 1 ? "良" : "好"
    ),
    chipOf(
      "homework",
      "作业",
      homeworkValid
        ? (homework.onTimeRate ?? 0) >= 0.9
          ? "优"
          : (homework.onTimeRate ?? 0) >= 0.75
            ? "良"
            : "加油"
        : null
    ),
  ].filter((c): c is EvalCardChip => c !== null);

  const now = new Date();
  const given = student.name.slice(1);

  return {
    name: student.name,
    className: student.grade_class || "未分班",
    avatarChar: (given || student.name).trim().charAt(0) || "生",
    periodLabel: range.label,
    stars,
    ratingLabel: ratingLabelOf(stars),
    chips,
    score: exam
      ? {
          title: exam.exam_name,
          subtitle: [
            exam.exam_date.slice(0, 10),
            exam.class_total_rank !== null ? `班级第 ${exam.class_total_rank} 名` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          subjects,
          rankNote,
          noteTone,
        }
      : null,
    tags,
    moments,
    comment: termComment?.content?.trim() ?? "",
    teacherName: profile?.name?.trim() || "班主任",
    dateLabel: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`,
  };
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

/** 卡片导出的默认文件名（不含扩展名）：评价卡片-李梓涵-2026 年 9 月 */
export function evalCardFileName(view: Pick<EvalCardView, "name" | "periodLabel">): string {
  return `评价卡片-${view.name}-${view.periodLabel}`.replace(/\s+/g, "");
}
