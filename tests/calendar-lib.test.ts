import { describe, expect, it } from "vitest";
import {
  buildMonthGrid,
  daysInMonth,
  fromDateStr,
  gridRange,
  mondayOf,
  monthTitle,
  shiftMonth,
  toDateStr,
  weekdayIndexOf,
} from "../src/lib/calendar";

describe("calendar pure functions", () => {
  it("converts between Date and date string without timezone drift", () => {
    const d = new Date(2026, 8, 6);
    expect(toDateStr(d)).toBe("2026-09-06");
    expect(toDateStr(fromDateStr("2026-09-06"))).toBe("2026-09-06");
  });

  it("computes weekday with Monday as 1 and Sunday as 7", () => {
    expect(weekdayIndexOf(new Date(2026, 8, 7))).toBe(1); // 周一
    expect(weekdayIndexOf(new Date(2026, 8, 12))).toBe(6); // 周六
    expect(weekdayIndexOf(new Date(2026, 8, 6))).toBe(7); // 周日
  });

  it("finds the Monday of the week, with Sunday still in the previous week's block", () => {
    expect(toDateStr(mondayOf(new Date(2026, 8, 7)))).toBe("2026-09-07"); // 周一 → 当天
    expect(toDateStr(mondayOf(new Date(2026, 8, 9)))).toBe("2026-09-07"); // 周三 → 本周一
    expect(toDateStr(mondayOf(new Date(2026, 8, 13)))).toBe("2026-09-07"); // 周日 → 仍归本周
    expect(toDateStr(mondayOf(new Date(2026, 8, 6)))).toBe("2026-08-31"); // 周日 → 上月末尾的周一
  });

  it("knows month lengths including leap years", () => {
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // 闰年
  });

  it("shifts months across year boundaries", () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 9, -2)).toEqual({ year: 2026, month: 7 });
  });

  it("builds a fixed 6x7 Monday-start grid for September 2026", () => {
    const grid = buildMonthGrid(2026, 9);
    expect(grid).toHaveLength(6);
    expect(grid.every((week) => week.length === 7)).toBe(true);

    // 2026-09-01 是周二：首格为 8 月 31 日（周一），第 2 格才是 9 月 1 日
    expect(grid[0][0]).toMatchObject({ date: "2026-08-31", weekday: 1, inMonth: false });
    expect(grid[0][1]).toMatchObject({ date: "2026-09-01", day: 1, inMonth: true, isWeekend: false });

    // 42 格连续：末格 = 首格 + 41 天
    const flat = grid.flat();
    expect(flat).toHaveLength(42);
    expect(flat[41].date).toBe("2026-10-11");

    // 本月天数与周末标记
    expect(flat.filter((c) => c.inMonth)).toHaveLength(30);
    expect(flat.filter((c) => c.inMonth && c.isWeekend)).toHaveLength(8); // 9 月有 8 个周末日
  });

  it("handles a month that starts on Monday (no leading cells needed)", () => {
    const grid = buildMonthGrid(2026, 6); // 2026-06-01 是周一
    expect(grid[0][0]).toMatchObject({ date: "2026-06-01", inMonth: true });
  });

  it("exposes the grid date range for range queries", () => {
    const grid = buildMonthGrid(2026, 9);
    expect(gridRange(grid)).toEqual({ start: "2026-08-31", end: "2026-10-11" });
  });

  it("renders month titles", () => {
    expect(monthTitle(2026, 9)).toBe("2026年9月");
  });
});
