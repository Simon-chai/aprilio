/**
 * 万年历纯函数：月网格构建 / 月份平移 / 日期工具。
 *
 * 网格固定 6 行 × 7 列、周一起始（国内习惯），跨月部分前后补齐；
 * 课表课程与备忘都按「日期 → 条目」映射到这个网格上（见 docs/TIMETABLE.md）。
 */

/** 日历表头：周一起始 */
export const CALENDAR_WEEKDAY_LABELS = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
];

/** 日历网格的一个格子：日期 + 展示标记 */
export interface CalendarCell {
  /** YYYY-MM-DD */
  date: string;
  /** 几号（1 起） */
  day: number;
  /** 星期几（1=周一 … 7=周日） */
  weekday: number;
  /** 是否属于当前展示月份 */
  inMonth: boolean;
  /** 是否周末 */
  isWeekend: boolean;
}

/** 本地日期 → YYYY-MM-DD（不用 toISOString，避免时区偏移错天） */
export function toDateStr(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** YYYY-MM-DD → 本地 Date（当天零点） */
export function fromDateStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** 星期几（1=周一 … 7=周日） */
export function weekdayIndexOf(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

/** 月份天数 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 月份平移：month 1~12，delta 可负 */
export function shiftMonth(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/** 月份标题：2026年9月 */
export function monthTitle(year: number, month: number): string {
  return `${year}年${month}月`;
}

/**
 * 构建某月的万年历网格：固定 6 周 × 7 天，周一起始。
 * 第一格 = 本月 1 号所在周的周一（可能是上月末），依次连续 42 天。
 */
export function buildMonthGrid(year: number, month: number): CalendarCell[][] {
  const first = new Date(year, month - 1, 1);
  const firstOffset = weekdayIndexOf(first) - 1; // 距周一的天数
  const start = new Date(year, month - 1, 1 - firstOffset);

  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const weekday = weekdayIndexOf(d);
    cells.push({
      date: toDateStr(d),
      day: d.getDate(),
      weekday,
      inMonth: d.getFullYear() === year && d.getMonth() === month - 1,
      isWeekend: weekday >= 6,
    });
  }
  return Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** 网格首尾格子的日期（备忘区间查询用） */
export function gridRange(grid: CalendarCell[][]): { start: string; end: string } {
  const flat = grid.flat();
  return { start: flat[0].date, end: flat[flat.length - 1].date };
}
