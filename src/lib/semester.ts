/**
 * 学期化班级管理纯函数：学期号线性化 / 年级实时推导 / 学期归属。
 *
 * 设计见 docs/SEMESTER_MANAGEMENT.md。核心原则：班级保留稳定标识，
 * 「当前年级 / 上还是下」由起始年级 + 起始学期结合当前时间实时推导，
 * 不批量改库、不复制班级记录。
 */
import { currentSemester } from "./timetable";

const CN_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 从班级名推断年级（规则优先，不依赖 AI）：命中「三年级 / 3年级 / 三(2)班」等返回 1~6，
 * 无法识别返回 null。供班级表单自动预选与导入时的年级识别。
 */
export function inferGradeFromName(name: string): number | null {
  const text = name.trim();
  if (!text) return null;
  const digit = /([1-6])\s*年级/.exec(text);
  if (digit) return Number(digit[1]);
  const cn = /([一二三四五六])\s*年级/.exec(text);
  if (cn) return CN_NUM[cn[1]] ?? null;
  return null;
}

/**
 * 最近 N 个学期的候选列表（当前学期在前，向过去回溯），供起始学期下拉选择。
 * 覆盖「当前学年秋/春 + 往前若干学年」，老师录入旧班时能选到更早的学期。
 */
export function recentSemesters(count = 8, at: string | Date = new Date()): string[] {
  const current = semesterIndex(semesterOfDate(at));
  if (Number.isNaN(current)) return [];
  const options: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = current - i;
    if (idx < 0) break;
    const startYear = Math.floor(idx / 2);
    const term = (idx % 2) + 1;
    options.push(`${startYear}-${startYear + 1}-${term}`);
  }
  return options;
}

/** 小学年级中文名；超出 1~6 原样拼接（如「7年级」） */
export function gradeLabel(grade: number): string {
  const names = ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"];
  return names[grade - 1] ?? `${grade}年级`;
}

/**
 * 学期号在线性轴上的序号：`2025-2026-1` → 0，`2025-2026-2` → 1，`2026-2027-1` → 2。
 * 便于比较两个学期的先后与间隔；非法输入返回 NaN。
 */
export function semesterIndex(semester: string): number {
  const match = /^(\d{4})-(\d{4})-([12])$/.exec(semester.trim());
  if (!match) return Number.NaN;
  const startYear = Number(match[1]);
  const term = Number(match[3]);
  return startYear * 2 + (term - 1);
}

/**
 * 当前年级 = 初始年级 + 已过学年数。
 * 每过两个学期（秋→春→下一秋）升一个年级；起始学期在未来时钳制为初始年级。
 */
export function gradeAt(
  entryGrade: number,
  entrySemester: string,
  at: string | Date = new Date()
): number {
  const start = semesterIndex(entrySemester);
  if (Number.isNaN(start)) return entryGrade;
  const current = semesterIndex(semesterOfDate(at));
  const passed = current - start;
  if (passed <= 0) return entryGrade;
  return entryGrade + Math.floor(passed / 2);
}

/** 该时刻所属学期在学年内的阶段：1=秋季（上学期）| 2=春季（下学期） */
export function semesterTerm(at: string | Date = new Date()): 1 | 2 {
  const d = typeof at === "string" ? new Date(`${at}T00:00:00`) : at;
  const m = d.getMonth() + 1;
  return m >= 9 || m <= 2 ? 1 : 2;
}

/** 某日期归属的学期号（成绩 / 表现按日期实时推导学期用） */
export function semesterOfDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  if (Number.isNaN(d.getTime())) return currentSemester();
  return currentSemester(d);
}

/**
 * 班级当前展示文案，如「四年级 · 上学期」；未登记年级或起始学期返回 null。
 * `at` 供单测注入固定时间。
 */
export function classCurrentLabel(
  entryGrade: number | null,
  entrySemester: string | null,
  at: string | Date = new Date()
): string | null {
  if (entryGrade == null || !entrySemester) return null;
  const grade = gradeAt(entryGrade, entrySemester, at);
  return `${gradeLabel(grade)} · ${semesterTerm(at) === 1 ? "上学期" : "下学期"}`;
}

/** 升级提醒：登记了年级/学期、且相比起始学期已升过年级的在用班级 */
export interface UpgradeNotice {
  name: string;
  /** 当前年级数字 */
  grade: number;
  /** 展示文案，如「四年级 · 上学期」 */
  label: string;
}

/**
 * 计算需要提醒「已升年级」的班级（仅登记过元信息、且当前年级 > 起始年级）。
 * 纯函数、不落库；调用方决定展示与是否归档。
 */
export function upgradedClasses(
  classes: { name: string; entry_grade?: number | null; entry_semester?: string | null; archived_at?: string | null }[],
  at: string | Date = new Date()
): UpgradeNotice[] {
  const notices: UpgradeNotice[] = [];
  for (const c of classes) {
    if (c.archived_at) continue;
    if (c.entry_grade == null || !c.entry_semester) continue;
    const grade = gradeAt(c.entry_grade, c.entry_semester, at);
    if (grade > c.entry_grade) {
      notices.push({ name: c.name, grade, label: classCurrentLabel(c.entry_grade, c.entry_semester, at)! });
    }
  }
  return notices;
}
