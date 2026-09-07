/**
 * 课表导入纯函数：把 RosterTable（花名册管道的通用表格）识别为课表布局并映射格子。
 * 与 db.ts / UI 分离可直测；交互见 ImportTimetableDialog.vue。
 * 口径同 docs/TIMETABLE.md §8：星期表头 + 节次表头 + 单元格科目（括号内容为备注）。
 */
import type { RosterTable } from "./roster";
import { defaultPeriods } from "./timetable";

/* ---------------- 基础词法 ---------------- */

/** 星期词 → 星期几（1=周一 … 7=周日）；需整体命中（trim 后） */
const WEEKDAY_WORDS: [RegExp, number][] = [
  [/^(周一|星期一|mon(day)?)$/i, 1],
  [/^(周二|星期二|tue(sday)?)$/i, 2],
  [/^(周三|星期三|wed(nesday)?)$/i, 3],
  [/^(周四|星期四|thu(rsday)?)$/i, 4],
  [/^(周五|星期五|fri(day)?)$/i, 5],
  [/^(周六|星期六|sat(urday)?)$/i, 6],
  [/^(周日|周天|星期日|星期天|sun(day)?)$/i, 7],
];

export function weekdayNumberOf(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  for (const [re, day] of WEEKDAY_WORDS) if (re.test(t)) return day;
  return null;
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字（一~十二）→ 数值；非法返回 null */
function cnToNumber(s: string): number | null {
  if (s === "十") return 10;
  const m10 = s.match(/^十([一二三四五六七八九])$/);
  if (m10) return 10 + (CN_DIGITS[m10[1]] ?? 0);
  const m1 = s.match(/^([一二三四五六七八九])$/);
  return m1 ? (CN_DIGITS[m1[1]] ?? null) : null;
}

export type PeriodLabel = { kind: "period"; period: number } | { kind: "skip"; label: string };

/** 节次表头解析：第N节/第N节课/N（含中文数字）；午休等固定非节次词 → skip；其余 → null */
export function parsePeriodLabel(text: string): PeriodLabel | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(午休|大课间|眼保健操|课间操|晨检|晨会|午会|放学|到校)$/.test(t)) {
    return { kind: "skip", label: t };
  }
  const m = t.match(/^第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*节?课?$/) ?? t.match(/^(\d{1,2})$/);
  if (!m) return null;
  const raw = m[1];
  const period = /^\d+$/.test(raw) ? Number(raw) : cnToNumber(raw);
  if (!period || period < 1 || period > 12) return null;
  return { kind: "period", period };
}

/** 单元格拆分：「数学（去机房）」→ 科目+备注（全半角括号均可）；纯文本 → 备注为 null */
export function splitSubjectNote(text: string): { subject: string; note: string | null } {
  const t = text.trim();
  const m = t.match(/^(.+?)\s*[（(]([^（）()]{1,30})[）)]$/);
  if (m && m[1].trim()) return { subject: m[1].trim(), note: m[2].trim() };
  return { subject: t, note: null };
}

/* ---------------- 布局识别 ---------------- */

export interface TimetableLayout {
  ok: boolean;
  /** true = 行=节次 × 列=星期（标准向）；false = 列=节次 × 行=星期（转置表） */
  periodRows: boolean;
  /** 星期表头位置：periodRows 时为行号，否则为列号（0 起） */
  dayHeader: number;
  /** 节次表头位置：periodRows 时为列号，否则为行号（0 起） */
  periodHeader: number;
  /** 数据区起始位置：periodRows 时为行号，否则为列号（0 起） */
  dataStart: number;
  /** 数据轴下标（periodRows: 列号，否则行号）→ 星期几 1~7 */
  dayMap: Record<number, number>;
  confidence: "high" | "low";
  reason: string;
}

/** 物理网格：hasHeader 时表头是第 0 行，否则 rows[0] 就是数据 */
function physicalGrid(table: RosterTable): string[][] {
  return table.hasHeader ? [table.headers, ...table.rows] : table.rows;
}

const MIN_DAYS = 3;

function lowLayout(reason: string, partial: Partial<TimetableLayout> = {}): TimetableLayout {
  return {
    ok: false,
    periodRows: true,
    dayHeader: -1,
    periodHeader: -1,
    dataStart: 1,
    dayMap: {},
    confidence: "low",
    reason,
    ...partial,
  };
}

export function detectTimetableLayout(table: RosterTable): TimetableLayout {
  const grid = physicalGrid(table);

  interface DayPos {
    row: number;
    col: number;
    day: number;
  }
  const dayCells: DayPos[] = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const day = weekdayNumberOf(row[c] ?? "");
      if (day) dayCells.push({ row: r, col: c, day });
    }
  }

  // 同一行/列聚集 ≥3 个不同星期词 → 该行/列是星期表头；横向优先
  const best = (key: "row" | "col") => {
    const groups = new Map<number, DayPos[]>();
    for (const p of dayCells) groups.set(p[key], [...(groups.get(p[key]) ?? []), p]);
    let winner = -1;
    let days = 0;
    for (const [k, list] of groups) {
      const n = new Set(list.map((x) => x.day)).size;
      if (n > days || (n === days && k < winner)) {
        winner = k;
        days = n;
      }
    }
    return { index: winner, days };
  };
  const h = best("row");
  const v = best("col");

  if (h.days >= MIN_DAYS && h.days >= v.days) {
    const dayMap: Record<number, number> = {};
    for (const p of dayCells) if (p.row === h.index) dayMap[p.col] = p.day;
    const periodHeader = findPeriodAxis(grid, "col", h.index + 1, Object.keys(dayMap).map(Number));
    if (periodHeader === -1) {
      return lowLayout("已识别星期表头，但未找到节次列（第N节 / 数字）", {
        periodRows: true,
        dayHeader: h.index,
        dataStart: h.index + 1,
        dayMap,
      });
    }
    return {
      ok: true,
      periodRows: true,
      dayHeader: h.index,
      periodHeader,
      dataStart: h.index + 1,
      dayMap,
      confidence: "high",
      reason: "已识别星期表头与节次列",
    };
  }

  if (v.days >= MIN_DAYS) {
    const dayMap: Record<number, number> = {};
    for (const p of dayCells) if (p.col === v.index) dayMap[p.row] = p.day;
    const periodHeader = findPeriodAxis(grid, "row", v.index + 1, Object.keys(dayMap).map(Number));
    if (periodHeader === -1) {
      return lowLayout("已识别星期表头，但未找到节次行（第N节 / 数字）", {
        periodRows: false,
        dayHeader: v.index,
        dataStart: v.index + 1,
        dayMap,
      });
    }
    return {
      ok: true,
      periodRows: false,
      dayHeader: v.index,
      periodHeader,
      dataStart: v.index + 1,
      dayMap,
      confidence: "high",
      reason: "已识别星期表头与节次行（转置表）",
    };
  }

  return lowLayout("未找到星期表头（周一~周五等），请在下方手动指定");
}

/** 在数据轴上找节次表头：命中节次词最多（≥1）的轴胜出（并列取靠前）；axis="col" 扫列（跳过星期列），"row" 扫行 */
function findPeriodAxis(
  grid: string[][],
  axis: "col" | "row",
  from: number,
  exclude: number[]
): number {
  let winner = -1;
  let bestCount = 0;
  const crossLen = axis === "col" ? grid.length : Math.max(...grid.map((r) => r.length), 0);
  const axisLen = axis === "col" ? Math.max(...grid.map((r) => r.length), 0) : grid.length;
  for (let i = 0; i < axisLen; i++) {
    if (exclude.includes(i)) continue;
    let count = 0;
    for (let j = from; j < crossLen; j++) {
      const cell = axis === "col" ? (grid[j]?.[i] ?? "") : (grid[i]?.[j] ?? "");
      if (parsePeriodLabel(cell)?.kind === "period") count++;
    }
    if (count > bestCount) {
      winner = i;
      bestCount = count;
    }
  }
  return winner;
}

/** 手动指定布局（识别低置信度时的兜底）；所选表头无星期词时按顺序假设周一起始 */
export function layoutFromSelection(
  table: RosterTable,
  periodRows: boolean,
  dayHeader: number,
  periodHeader: number
): TimetableLayout {
  const grid = physicalGrid(table);
  const axis: string[] = periodRows
    ? (grid[dayHeader] ?? [])
    : grid.map((row) => row[dayHeader] ?? "");
  const dayMap: Record<number, number> = {};
  axis.forEach((text, i) => {
    if (i === periodHeader) return;
    const day = weekdayNumberOf(text ?? "");
    if (day) dayMap[i] = day;
  });
  let confidence: "high" | "low" = "high";
  let reason = "按手动选择映射";
  if (Object.keys(dayMap).length < 2) {
    for (const k of Object.keys(dayMap)) delete dayMap[Number(k)];
    let next = 1;
    axis.forEach((_, i) => {
      if (i !== periodHeader && next <= 7) dayMap[i] = next++;
    });
    confidence = "low";
    reason = "所选表头未识别到星期词，已按顺序假设周一~周五，请核对预览";
  }
  return {
    ok: true,
    periodRows,
    dayHeader,
    periodHeader,
    dataStart: dayHeader + 1,
    dayMap,
    confidence,
    reason,
  };
}

/* ---------------- 格子映射 ---------------- */

export interface TimetableImportCell {
  /** 1~5（周六周日识别但不产出） */
  day_of_week: number;
  /** 1~12，越界丢弃 */
  period: number;
  subject: string;
  note: string | null;
}

export interface TimetableMapping {
  cells: TimetableImportCell[];
  /** 被剔除的非节次行/列（午休、大课间…） */
  skipped: string[];
  /** 周六/周日列被丢弃的格子数 */
  droppedWeekendCells: number;
}

export function mapTimetableCells(table: RosterTable, layout: TimetableLayout): TimetableMapping {
  const grid = physicalGrid(table);
  const cells: TimetableImportCell[] = [];
  const skipped: string[] = [];
  let droppedWeekendCells = 0;

  const pushCell = (day: number, period: number, text: string) => {
    const { subject, note } = splitSubjectNote(text ?? "");
    if (!subject) return;
    if (day >= 6) {
      droppedWeekendCells += 1;
      return;
    }
    cells.push({ day_of_week: day, period, subject, note });
  };

  if (layout.periodRows) {
    for (let r = layout.dataStart; r < grid.length; r++) {
      const row = grid[r] ?? [];
      const label = parsePeriodLabel(row[layout.periodHeader] ?? "");
      if (!label) continue;
      if (label.kind === "skip") {
        skipped.push(label.label);
        continue;
      }
      for (const [c, day] of Object.entries(layout.dayMap)) {
        pushCell(day, label.period, row[Number(c)] ?? "");
      }
    }
  } else {
    for (const [r, day] of Object.entries(layout.dayMap)) {
      const row = grid[Number(r)] ?? [];
      for (let c = layout.dataStart; c < row.length; c++) {
        const label = parsePeriodLabel(grid[layout.periodHeader]?.[c] ?? "");
        if (!label) continue;
        if (label.kind === "skip") {
          if (!skipped.includes(label.label)) skipped.push(label.label);
          continue;
        }
        pushCell(day, label.period, row[c] ?? "");
      }
    }
  }

  cells.sort((a, b) => a.day_of_week - b.day_of_week || a.period - b.period);
  return { cells, skipped, droppedWeekendCells };
}

/** 预览网格的节次行序：去重升序 */
export function previewPeriods(cells: TimetableImportCell[]): number[] {
  return [...new Set(cells.map((c) => c.period))].sort((a, b) => a - b);
}

/* ---------------- 模板 ---------------- */

/** 下载 CSV 模板（带 BOM，Excel 直开不乱码）：8 节 × 周一~周五 + 填写说明 */
export function downloadTimetableTemplate(): void {
  const rows: string[][] = [["节次", "周一", "周二", "周三", "周四", "周五"]];
  const sample = ["数学", "语文", "英语", "体育", "音乐", "美术", "班会"];
  defaultPeriods().forEach((p, i) => {
    rows.push([`第${p.period}节`, sample[i % sample.length], "", "", "", ""]);
  });
  rows.push(["说明", "节次行可增删；周末列不会导入；括号内容会存为备注，如：数学（去机房）"]);
  const csv =
    "\uFEFF" +
    rows.map((r) => r.map((v) => (v.includes(",") ? `"${v}"` : v)).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "课表导入模板.csv";
  a.click();
  URL.revokeObjectURL(url);
}
