/**
 * 成绩分析纯函数：班级统计、排名、档位与趋势。
 *
 * 只做计算、不碰数据库——db 层负责取数，班级面板 / 个人面板 / AI 分析器
 * 共用同一套口径，保证「界面看到的数字」与「助手回答的数字」一致。
 *
 * 口径约定（小学场景，见 docs/SCORE_IMPORT.md）：
 * - 只统计数字分；等级制（优/良/缺考…）不参与均值、排名，单独展示
 * - 无科目满分字典，单科满分按 100 计；总分及格/优秀线按「科目数 × 60 / 90」折算
 */
import type {
  ExamScoreRow,
  ExamStatSummary,
  ExamType,
  ScoreLevel,
  ScoreLevelBand,
  SubjectScoreStat,
} from "../types";

/** 单科满分基准（无满分字典时的默认值） */
export const DEFAULT_FULL_SCORE = 100;
/** 及格线（默认口径；界面按「等级映射」配置取值） */
export const PASS_SCORE = 60;
/** 优秀线（默认口径；界面按「等级映射」配置取值） */
export const EXCELLENT_SCORE = 90;
/** 良好线（仅用于档位展示） */
export const GOOD_SCORE = 80;

/** 默认等级映射（与历史口径一致：优秀≥90 / 良好≥80 / 及格≥60 / 待提高<60） */
export const DEFAULT_SCORE_LEVEL_BANDS: ScoreLevelBand[] = [
  { key: "excellent", label: "优秀", min: 90 },
  { key: "good", label: "良好", min: 80 },
  { key: "pass", label: "及格", min: 60 },
  { key: "fail", label: "待提高", min: 0 },
];

/** 及格 / 优秀阈值（统计口径用） */
export interface ScoreLines {
  pass: number;
  excellent: number;
}

/** 从等级映射里取统计用的及格线 / 优秀线 */
export function scoreLinesOf(bands: ScoreLevelBand[] = DEFAULT_SCORE_LEVEL_BANDS): ScoreLines {
  return {
    pass: bands.find((b) => b.key === "pass")?.min ?? PASS_SCORE,
    excellent: bands.find((b) => b.key === "excellent")?.min ?? EXCELLENT_SCORE,
  };
}

/** 分数 → 档位：达到某档 min 即归入该档；非数字分返回 null */
export function scoreLevelOf(
  score: number | null | undefined,
  bands: ScoreLevelBand[] = DEFAULT_SCORE_LEVEL_BANDS
): ScoreLevel | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  for (const band of sorted) {
    if (score >= band.min) return band.key;
  }
  return "fail";
}

/** 档位 → 展示名（按等级映射取，可自定义） */
export function levelLabelOf(
  level: ScoreLevel | null,
  bands: ScoreLevelBand[] = DEFAULT_SCORE_LEVEL_BANDS
): string {
  if (!level) return "—";
  return bands.find((b) => b.key === level)?.label ?? SCORE_LEVEL_LABEL[level];
}

/** 兼容旧调用：默认口径的档位判定 */
export function scoreLevel(score: number | null | undefined): ScoreLevel | null {
  return scoreLevelOf(score);
}

export const SCORE_LEVEL_LABEL: Record<ScoreLevel, string> = {
  excellent: "优秀",
  good: "良好",
  pass: "及格",
  fail: "待提高",
};

/** 大考关键词：命中即判为大考，其余为平时小考 */
const MAJOR_EXAM_PATTERN = /期中|期末|统考|联考|模拟|毕业考|升学/;

/** 按考试名判定考试种类（大考 / 小考） */
export function inferExamType(name: string): ExamType {
  return MAJOR_EXAM_PATTERN.test(name ?? "") ? "major" : "minor";
}

/** 档位对应的文字色（Tailwind token） */
export const SCORE_LEVEL_TEXT: Record<ScoreLevel, string> = {
  excellent: "text-primary",
  good: "text-success",
  pass: "text-muted",
  fail: "text-danger",
};

/** 档位对应的进度条底色 */
export const SCORE_LEVEL_BAR: Record<ScoreLevel, string> = {
  excellent: "bg-primary",
  good: "bg-success",
  pass: "bg-weak",
  fail: "bg-danger",
};

export function levelLabel(level: ScoreLevel | null): string {
  return level ? SCORE_LEVEL_LABEL[level] : "—";
}

/** 保留一位小数（整数则去掉小数点，如 90 → "90"） */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return String(round1(n));
}

/** 0~1 比率 → 百分比文本，如 0.8 → "80%" */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** 数字分在 0~满分 中的占比（进度条宽度用），夹在 0~1 */
export function scoreRatio(score: number | null | undefined, full = DEFAULT_FULL_SCORE): number {
  if (score === null || score === undefined || Number.isNaN(score)) return 0;
  return Math.min(1, Math.max(0, score / full));
}

interface ScoreCell {
  subject: string;
  score: number | null;
  grade: string | null;
}

/** 按科目聚合统计（仅数字分参与，按科目首次出现顺序返回） */
export function computeSubjectStats(
  rows: ScoreCell[],
  lines: ScoreLines = scoreLinesOf()
): SubjectScoreStat[] {
  const bySubject = new Map<string, number[]>();
  for (const r of rows) {
    if (r.score === null || Number.isNaN(r.score)) continue;
    const list = bySubject.get(r.subject) ?? [];
    list.push(r.score);
    bySubject.set(r.subject, list);
  }
  const stats: SubjectScoreStat[] = [];
  for (const [subject, values] of bySubject) {
    const sum = values.reduce((a, b) => a + b, 0);
    stats.push({
      subject,
      count: values.length,
      average: round1(sum / values.length),
      max: Math.max(...values),
      min: Math.min(...values),
      passRate: values.filter((v) => v >= lines.pass).length / values.length,
      excellentRate: values.filter((v) => v >= lines.excellent).length / values.length,
    });
  }
  return stats;
}

/** 每名学生的总分（数字分求和；全科皆等级时 total 为 null，grade 汇总等级文本） */
export function computeStudentTotals(
  rows: Pick<ExamScoreRow, "student_id" | "subject" | "score" | "grade">[]
): Map<number, { score: number | null; grade: string | null; subjectCount: number }> {
  const acc = new Map<number, { sum: number; numeric: number; grades: string[]; subjects: Set<string> }>();
  for (const r of rows) {
    let item = acc.get(r.student_id);
    if (!item) {
      item = { sum: 0, numeric: 0, grades: [], subjects: new Set() };
      acc.set(r.student_id, item);
    }
    item.subjects.add(r.subject);
    if (r.score !== null && !Number.isNaN(r.score)) {
      item.sum += r.score;
      item.numeric++;
    } else if (r.grade) {
      item.grades.push(r.grade);
    }
  }
  const out = new Map<number, { score: number | null; grade: string | null; subjectCount: number }>();
  for (const [studentId, item] of acc) {
    out.set(studentId, {
      score: item.numeric > 0 ? round1(item.sum) : null,
      grade: item.numeric > 0 ? null : item.grades.join("、") || null,
      subjectCount: item.subjects.size,
    });
  }
  return out;
}

/**
 * 按总分排名（降序）：并列同名次（1、1、3 的密集口径），无数字总分者不参与。
 */
export function rankByTotal(
  totals: Map<number, { score: number | null }>
): Map<number, number> {
  const ranked = [...totals.entries()]
    .filter(([, v]) => v.score !== null)
    .sort((a, b) => (b[1].score as number) - (a[1].score as number));
  const ranks = new Map<number, number>();
  let lastScore: number | null = null;
  let lastRank = 0;
  ranked.forEach(([studentId, v], index) => {
    const score = v.score as number;
    const rank = lastScore !== null && score === lastScore ? lastRank : index + 1;
    ranks.set(studentId, rank);
    lastScore = score;
    lastRank = rank;
  });
  return ranks;
}

/** 一次考试的班级统计（总分 + 各科） */
export function computeExamStats(
  rows: ExamScoreRow[],
  lines: ScoreLines = scoreLinesOf()
): ExamStatSummary {
  const totals = computeStudentTotals(rows);
  const numericTotals = [...totals.values()]
    .map((v) => v.score)
    .filter((v): v is number => v !== null);
  const subjectCount = new Set(rows.map((r) => r.subject)).size;
  const fullTotal = subjectCount * DEFAULT_FULL_SCORE;

  return {
    student_count: new Set(rows.map((r) => r.student_id)).size,
    total_count: numericTotals.length,
    total_average: numericTotals.length
      ? round1(numericTotals.reduce((a, b) => a + b, 0) / numericTotals.length)
      : 0,
    total_max: numericTotals.length ? Math.max(...numericTotals) : 0,
    total_min: numericTotals.length ? Math.min(...numericTotals) : 0,
    total_pass_rate: numericTotals.length
      ? numericTotals.filter((v) => v >= (fullTotal * lines.pass) / DEFAULT_FULL_SCORE).length /
        numericTotals.length
      : 0,
    total_excellent_rate: numericTotals.length
      ? numericTotals.filter((v) => v >= (fullTotal * lines.excellent) / DEFAULT_FULL_SCORE).length /
        numericTotals.length
      : 0,
    subjects: computeSubjectStats(rows, lines),
  };
}

/**
 * 各科平均分的均值（0~100 口径）。
 * 跨考试比较时用它而不是总分均值——总分随科目数变化（3 科 vs 5 科），
 * 而单科均分始终是 0~100，趋势才可比。
 */
export function averageOfSubjectAverages(stats: ExamStatSummary): number {
  if (!stats.subjects.length) return 0;
  return round1(stats.subjects.reduce((a, s) => a + s.average, 0) / stats.subjects.length);
}

/** 单科班级排名：按分数降序，并列同名次，仅数字分参与 */
export function rankBySubject(
  rows: Pick<ExamScoreRow, "student_id" | "subject" | "score">[]
): Map<string, Map<number, number>> {
  const bySubject = new Map<string, { studentId: number; score: number }[]>();
  for (const r of rows) {
    if (r.score === null || Number.isNaN(r.score)) continue;
    const list = bySubject.get(r.subject) ?? [];
    list.push({ studentId: r.student_id, score: r.score });
    bySubject.set(r.subject, list);
  }
  const out = new Map<string, Map<number, number>>();
  for (const [subject, list] of bySubject) {
    list.sort((a, b) => b.score - a.score);
    const ranks = new Map<number, number>();
    let lastScore: number | null = null;
    let lastRank = 0;
    list.forEach((item, index) => {
      const rank = lastScore !== null && item.score === lastScore ? lastRank : index + 1;
      ranks.set(item.studentId, rank);
      lastScore = item.score;
      lastRank = rank;
    });
    out.set(subject, ranks);
  }
  return out;
}

/** 单科班级平均分：科目 → 平均分 */
export function subjectAverages(rows: ScoreCell[]): Map<string, number> {
  return new Map(computeSubjectStats(rows).map((s) => [s.subject, s.average]));
}

/** 总分差值趋势：>0 进步 | 0 持平 | <0 退步 | null 无从比较 */
export function trendOf(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return round1(current - previous);
}
