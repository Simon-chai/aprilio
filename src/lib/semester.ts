/**
 * 学期化纯函数：学期号线性化 / 日期归属学期。
 *
 * 设计见 docs/SEMESTER_MANAGEMENT.md。核心原则：班级只是稳定的文本标识，
 * 成绩 / 表现 / 评语 / 课表各自按日期或学期字段归属学期，不依赖班级级元信息。
 */
import { currentSemester } from "./timetable";

/**
 * 最近 N 个学期的候选列表（当前学期在前，向过去回溯），供学期下拉选择。
 * 覆盖「当前学年秋/春 + 往前若干学年」，回看历史学期时能选到更早的学期。
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

/** 某日期归属的学期号（成绩 / 表现 / 作业按日期实时推导学期用） */
export function semesterOfDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : date;
  if (Number.isNaN(d.getTime())) return currentSemester();
  return currentSemester(d);
}
