# 课表整表化与 Excel/CSV 导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本轮执行说明：用户已批准 spec 并要求「出计划后直接开始实现」。git 提交统一推迟到收尾征求用户意见后一次性处理（工作区已有本轮早前的未提交改动：个人资料身份枚举、保存后跳首页等），每个任务只关注自己的文件。

**Goal:** 凡叫「课表」的界面画出完整节次网格（行=节次全集），并提供可发现的 Excel/CSV 课表导入。

**Architecture:** 纯函数层（`periodsUnion` + `lib/timetable-import.ts`）→ db 双态只读/清理函数 → 导入对话框组件（复刻 ImportRosterDialog 骨架、复用花名册文件管道）→ 三个视图改造（我的课表默认周课表、班级 Tab 默认网格、首页行数修正）。

**Tech Stack:** Vue 3 + TS + vitest（jsdom 走 db.ts 内存演示态）；无 Rust 改动、无 DDL。

**Spec:** `docs/superpowers/specs/2026-09-07-timetable-full-grid-and-import-design.md`

## Global Constraints

- 周一~周五固定 5 列（决策 ④）；默认 8 节；节次上限 12（`TimetableGrid` 既有约束）
- 科目配色一律走 `subjectChipClass` / `subjectDotClass`，不新增色值
- 双态约束：每个 db 函数先 `isTauri()` 分支，浏览器态走 `mem()` 内存 store
- 注释与用户文案用中文；每任务完成标准：`rtk vitest run <相关测试>` 绿 + `npm run typecheck` 绿
- 首页交互定稿不动（只修正节次行来源）；不动 `TimetableGrid.vue`、`TimetableCalendar.vue`、Agent 工具
- 相关命令均在仓库根目录执行；vitest 单文件用 `rtk vitest run tests/<file>`

---

### Task 1: `periodsUnion` 纯函数

**Files:**
- Modify: `src/lib/timetable.ts`（「节次配置」区块，`defaultPeriods` 之后追加）
- Test: `tests/timetable-lib.test.ts`

**Interfaces:**
- Produces: `periodsUnion(lists: (TimetablePeriod[] | null)[]): TimetablePeriod[]`（Task 2/5/7 依赖）

- [ ] **Step 1: 写失败测试**（`tests/timetable-lib.test.ts`；顶部 `from "../src/lib/timetable"` 的 import 列表补 `periodsUnion`，文件末尾追加）

```ts
describe("periodsUnion", () => {
  it("merges period configs ascending and keeps first non-empty times", () => {
    const a = [
      { period: 1, session: "morning", start: "08:00", end: "08:40" },
      { period: 2, session: "morning", start: "", end: "" },
    ] as TimetablePeriod[];
    const b = [
      { period: 2, session: "morning", start: "08:50", end: "09:30" },
      { period: 8, session: "afternoon", start: "16:30", end: "17:10" },
    ] as TimetablePeriod[];
    const merged = periodsUnion([a, b]);
    expect(merged.map((p) => p.period)).toEqual([1, 2, 8]);
    expect(merged[1].start).toBe("08:50");
    expect(merged[1].end).toBe("09:30");
  });

  it("falls back to defaultPeriods when everything is empty", () => {
    expect(periodsUnion([])).toEqual(defaultPeriods());
    expect(periodsUnion([null, null])).toEqual(defaultPeriods());
  });
});
```

（`TimetablePeriod` 类型如未导入，从 `../src/types` 补 type import。）

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/timetable-lib.test.ts`，期望 FAIL（periodsUnion 未导出）
- [ ] **Step 3: 实现**（`src/lib/timetable.ts`，`defaultPeriods` 函数之后）

```ts
/**
 * 合并多班节次配置：按 period 升序去重，时间取首个非空值；全空回退默认节次。
 * 「我的课表」「首页面板」的网格行数来源——画满学校节次结构，不随有课节次缩水。
 */
export function periodsUnion(lists: (TimetablePeriod[] | null)[]): TimetablePeriod[] {
  const byPeriod = new Map<number, TimetablePeriod>();
  for (const list of lists) {
    for (const p of list ?? []) {
      const existing = byPeriod.get(p.period);
      if (!existing) {
        byPeriod.set(p.period, { ...p });
      } else {
        if (!existing.start && p.start) existing.start = p.start;
        if (!existing.end && p.end) existing.end = p.end;
      }
    }
  }
  const merged = [...byPeriod.values()].sort((a, b) => a.period - b.period);
  return merged.length ? merged : defaultPeriods();
}
```

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/timetable-lib.test.ts`

### Task 2: db 双态新增 `listTimetablePeriodsByClass` + `clearTimetableSlots`

**Files:**
- Modify: `src/lib/db.ts`（`listTimetableSlotsWithClass` 函数之后追加，约 :2656）
- Test: `tests/timetable-db.test.ts`

**Interfaces:**
- Produces:
  - `listTimetablePeriodsByClass(semester: string): Promise<{ class_name: string; periods: TimetablePeriod[] | null }[]>`（按班级名 zh 排序）
  - `clearTimetableSlots(timetableId: number): Promise<number>`（返回删除格数）

- [ ] **Step 1: 写失败测试**（`tests/timetable-db.test.ts` 顶部 import 补 `listTimetablePeriodsByClass` / `clearTimetableSlots` / `getTimetableWithSlots`（如缺），describe 内追加）

```ts
it("lists per-class period configs for the semester (双态)", async () => {
  const a = await findOrCreateTimetable("节次班甲", SEMESTER);
  const b = await findOrCreateTimetable("节次班乙", SEMESTER);
  await saveTimetablePeriods(a.timetable.id, [
    { period: 1, session: "morning", start: "08:00", end: "08:40" },
    { period: 8, session: "afternoon", start: "16:30", end: "17:10" },
  ]);
  // 班乙不配置 → periods 为 null，也要出现在结果里

  const list = await listTimetablePeriodsByClass(SEMESTER);
  const jia = list.find((x) => x.class_name === "节次班甲");
  const yi = list.find((x) => x.class_name === "节次班乙");
  expect(jia?.periods?.map((p) => p.period)).toEqual([1, 8]);
  expect(yi?.periods).toBeNull();
});

it("clears all slots of one timetable and returns the deleted count", async () => {
  const { timetable } = await findOrCreateTimetable(CLASS_A, SEMESTER);
  await saveTimetableSlot(timetable.id, 1, 1, "语文");
  await saveTimetableSlot(timetable.id, 2, 2, "数学");

  expect(await clearTimetableSlots(timetable.id)).toBe(2);
  expect(await getTimetableWithSlots(CLASS_A, SEMESTER)).toMatchObject({ slots: [] });
  expect(await clearTimetableSlots(timetable.id)).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/timetable-db.test.ts`
- [ ] **Step 3: 实现**（`src/lib/db.ts`，`listTimetableSlotsWithClass` 之后；`parsePeriodsJson`/`mem`/`getDb` 均已在文件内）

```ts
/** 学期内各班节次配置（含没排过课的班）；「我的课表」整表行数的数据来源 */
export async function listTimetablePeriodsByClass(
  semester: string
): Promise<{ class_name: string; periods: TimetablePeriod[] | null }[]> {
  if (!isTauri()) {
    return mem()
      .timetables.filter((t) => t.semester === semester)
      .map((t) => ({ class_name: t.class_name, periods: t.periods }))
      .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
  }
  const db = await getDb();
  const rows = await db.select<{ class_name: string; periods_json: string | null }[]>(
    "SELECT class_name, periods_json FROM timetables WHERE semester = ?",
    [semester]
  );
  return rows
    .map(({ class_name, periods_json }) => ({ class_name, periods: parsePeriodsJson(periods_json) }))
    .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
}

/** 清空某张课表的全部格子（导入「清空后导入」选项用）；返回删除格数 */
export async function clearTimetableSlots(timetableId: number): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const before = store.timetableSlots.length;
    store.timetableSlots = store.timetableSlots.filter((s) => s.timetable_id !== timetableId);
    return before - store.timetableSlots.length;
  }
  const db = await getDb();
  const result = await db.execute("DELETE FROM timetable_slots WHERE timetable_id = ?", [
    timetableId,
  ]);
  return result.rowsAffected;
}
```

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/timetable-db.test.ts`

### Task 3: `lib/timetable-import.ts` 纯函数模块

**Files:**
- Create: `src/lib/timetable-import.ts`
- Test: `tests/timetable-import.test.ts`（新建）

**Interfaces:**
- Consumes: `RosterTable`（`src/lib/roster.ts:22`：`{ headers: string[]; rows: string[][]; hasHeader: boolean; delimiter: string }`）、`defaultPeriods`（lib/timetable）
- Produces（Task 4 依赖）:
  - `detectTimetableLayout(table: RosterTable): TimetableLayout`
  - `layoutFromSelection(table, periodRows, dayHeader, periodHeader): TimetableLayout`
  - `mapTimetableCells(table, layout): { cells: TimetableImportCell[]; skipped: string[]; droppedWeekendCells: number }`
  - `previewPeriods(cells): number[]`
  - `downloadTimetableTemplate(): void`
  - `weekdayNumberOf` / `parsePeriodLabel` / `splitSubjectNote`
  - 类型 `TimetableLayout { ok; periodRows; dayHeader; periodHeader; dataStart; dayMap: Record<number, number>; confidence: "high"|"low"; reason }`、`TimetableImportCell { day_of_week; period; subject; note }`

- [ ] **Step 1: 写失败测试**（新建 `tests/timetable-import.test.ts`）

```ts
import { describe, expect, it, vi } from "vitest";
import {
  detectTimetableLayout,
  downloadTimetableTemplate,
  layoutFromSelection,
  mapTimetableCells,
  parsePeriodLabel,
  previewPeriods,
  splitSubjectNote,
  weekdayNumberOf,
} from "../src/lib/timetable-import";
import type { RosterTable } from "../src/lib/roster";

/** 标准向：行=节次 × 列=星期 */
const STANDARD_CSV = [
  "节次,周一,周二,周三,周四,周五",
  "第1节,数学,语文,,英语,",
  "第2节,语文,数学,数学（带教具）,语文,班会",
  "午休,,,",
  "第4节,体育,,音乐,,",
].join("\n");

function tableOf(csv: string, hasHeader = true): RosterTable {
  const lines = csv.split("\n").map((l) => l.split(","));
  const headers = hasHeader ? lines[0] : lines[0].map((_, i) => `第${i + 1}列`);
  const rows = hasHeader ? lines.slice(1) : lines;
  return { headers, rows, hasHeader, delimiter: "," };
}

describe("基础词法", () => {
  it("maps weekday words (含星期一/Mon) to day numbers", () => {
    expect(weekdayNumberOf("周一")).toBe(1);
    expect(weekdayNumberOf("星期五 ")).toBe(5);
    expect(weekdayNumberOf("Mon")).toBe(1);
    expect(weekdayNumberOf("周日")).toBe(7);
    expect(weekdayNumberOf("语文")).toBeNull();
  });

  it("parses period labels incl. chinese numerals; non-period rows are 'skip'", () => {
    expect(parsePeriodLabel("第1节")).toEqual({ kind: "period", period: 1 });
    expect(parsePeriodLabel("第三节")).toEqual({ kind: "period", period: 3 });
    expect(parsePeriodLabel("12")).toEqual({ kind: "period", period: 12 });
    expect(parsePeriodLabel("午休")?.kind).toBe("skip");
    expect(parsePeriodLabel("大课间")?.kind).toBe("skip");
    expect(parsePeriodLabel("语文")).toBeNull();
  });

  it("splits '数学（去机房）' into subject + note (全半角括号)", () => {
    expect(splitSubjectNote("数学（去机房）")).toEqual({ subject: "数学", note: "去机房" });
    expect(splitSubjectNote("数学(去机房)")).toEqual({ subject: "数学", note: "去机房" });
    expect(splitSubjectNote(" 语文 ")).toEqual({ subject: "语文", note: null });
  });
});

describe("detectTimetableLayout", () => {
  it("detects the standard orientation: header row = weekdays, first column = periods", () => {
    const layout = detectTimetableLayout(tableOf(STANDARD_CSV));
    expect(layout.ok).toBe(true);
    expect(layout.periodRows).toBe(true);
    expect(layout.dayHeader).toBe(0);
    expect(layout.periodHeader).toBe(0);
    expect(layout.dataStart).toBe(1);
    expect(layout.dayMap).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
  });

  it("detects the transposed orientation (列=节次 × 行=星期)", () => {
    const csv = ["节次,第1节,第2节,第4节", "周一,数学,语文,体育", "周二,英语,数学,,"].join("\n");
    const layout = detectTimetableLayout(tableOf(csv));
    expect(layout.ok).toBe(true);
    expect(layout.periodRows).toBe(false);
    expect(layout.dayHeader).toBe(0);
    expect(layout.periodHeader).toBe(0);
    expect(layout.dataStart).toBe(1);
    expect(layout.dayMap).toEqual({ 1: 1, 2: 2 });
  });

  it("reports low confidence when no weekday header exists", () => {
    const layout = detectTimetableLayout(tableOf("姓名,金额\n张三,100"));
    expect(layout.ok).toBe(false);
    expect(layout.confidence).toBe("low");
    expect(layout.reason).toContain("星期");
  });
});

describe("mapTimetableCells", () => {
  it("maps standard layout: skips non-period rows, splits notes, keeps empties out", () => {
    const layout = detectTimetableLayout(tableOf(STANDARD_CSV));
    const { cells, skipped, droppedWeekendCells } = mapTimetableCells(tableOf(STANDARD_CSV), layout);
    expect(skipped).toEqual(["午休"]);
    expect(droppedWeekendCells).toBe(0);
    expect(cells).toContainEqual({ day_of_week: 3, period: 2, subject: "数学", note: "带教具" });
    expect(cells).toContainEqual({ day_of_week: 1, period: 1, subject: "数学", note: null });
    expect(cells.filter((c) => c.period === 3)).toHaveLength(0); // 午休行不产出
    expect(cells.filter((c) => c.day_of_week === 2 && c.period === 4)).toHaveLength(0); // 空格不产出
  });

  it("drops weekend columns with a count", () => {
    const csv = ["节次,周一,周六", "第1节,数学,奥数"].join("\n");
    const layout = detectTimetableLayout(tableOf(csv));
    const { cells, droppedWeekendCells } = mapTimetableCells(tableOf(csv), layout);
    expect(droppedWeekendCells).toBe(1);
    expect(cells.every((c) => c.day_of_week <= 5)).toBe(true);
  });

  it("maps transposed layout", () => {
    const csv = ["节次,第1节,第2节", "周一,数学,语文", "周二,英语,数学"].join("\n");
    const layout = detectTimetableLayout(tableOf(csv));
    const { cells } = mapTimetableCells(tableOf(csv), layout);
    expect(cells).toContainEqual({ day_of_week: 1, period: 1, subject: "数学", note: null });
    expect(cells).toContainEqual({ day_of_week: 2, period: 2, subject: "数学", note: null });
  });

  it("supports manual selection when detection is low-confidence", () => {
    const table = tableOf("A,B,C\n第1节,数学,语文");
    expect(detectTimetableLayout(table).ok).toBe(false);
    const layout = layoutFromSelection(table, true, 0, 0);
    expect(layout.dayMap).toEqual({ 1: 1, 2: 2 }); // B/C 列无星期词 → 按顺序假设周一/周二
    const { cells } = mapTimetableCells(table, layout);
    expect(cells).toContainEqual({ day_of_week: 1, period: 1, subject: "数学", note: null });
  });
});

describe("previewPeriods / template", () => {
  it("returns sorted distinct periods", () => {
    const cells = [
      { day_of_week: 1, period: 3, subject: "语文", note: null },
      { day_of_week: 2, period: 1, subject: "数学", note: null },
    ];
    expect(previewPeriods(cells)).toEqual([1, 3]);
  });

  it("downloads a CSV template (creates blob link and clicks once)", () => {
    const click = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
    vi.spyOn(document, "createElement").mockReturnValue({
      click,
      style: {},
    } as unknown as HTMLAnchorElement);
    downloadTimetableTemplate();
    expect(click).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/timetable-import.test.ts`（模块不存在）
- [ ] **Step 3: 实现**（新建 `src/lib/timetable-import.ts`，完整内容如下）

```ts
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

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

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

  interface DayPos { row: number; col: number; day: number }
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

/** 在数据轴上找节次表头：命中节次词最多（≥2）的轴胜出；axis="col" 扫列（跳过星期列），"row" 扫行 */
function findPeriodAxis(grid: string[][], axis: "col" | "row", from: number, exclude: number[]): number {
  let winner = -1;
  let bestCount = 1;
  const crossLen = axis === "col" ? grid.length : Math.max(...grid.map((r) => r.length), 0);
  const axisLen = axis === "col" ? Math.max(...grid.map((r) => r.length), 0) : grid.length;
  for (let i = 0; i < axisLen; i++) {
    if (exclude.includes(i)) continue;
    let count = 0;
    for (let j = from; j < crossLen; j++) {
      const cell = axis === "col" ? (grid[j]?.[i] ?? "") : (grid[i]?.[j] ?? "");
      if (parsePeriodLabel(cell)?.kind === "period") count++;
    }
    if (count >= 2 && (count > bestCount || (count === bestCount && winner === -1))) {
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
```

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/timetable-import.test.ts`

### Task 4: `ImportTimetableDialog.vue`

**Files:**
- Create: `src/components/ImportTimetableDialog.vue`
- Test: `tests/import-timetable-dialog.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `findOrCreateTimetable` / `clearTimetableSlots` / `saveTimetableSlot` / `listClasses`（已存在，返回 `ClassSummary[]`，取 `.name`）；Task 3 全部导出；`pickRosterFile` / `decodeRosterBytes` / `parseRosterTable`（`src/lib/roster.ts`，桌面端 xlsx 走 Rust `roster_read_table`，浏览器仅 CSV/TSV/TXT）；`currentSemester` / `subjectChipClass` / `WEEKDAY_LABELS`（lib/timetable）；`logInfo` / `logError`（lib/logger）
- Produces: Props `{ open: boolean; presetClass?: string }`；Emits `close` / `imported: [{ className: string; count: number }]`；`defineExpose({ loadText, loadTable })`（`loadText(text: string, label?: string): Promise<void>`，测试注入口，签名同 ImportRosterDialog）

- [ ] **Step 1: 写失败测试**（新建 `tests/import-timetable-dialog.test.ts`；跑在 jsdom 内存演示态 db 上，与 `roster-dialog.test.ts` 同套路）

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ImportTimetableDialog from "../src/components/ImportTimetableDialog.vue";
import { currentSemester } from "../src/lib/timetable";
import {
  clearTimetableSlots,
  findOrCreateTimetable,
  getTimetableWithSlots,
  saveTimetableSlot,
} from "../src/lib/db";

const CSV = [
  "节次,周一,周二,周三,周四,周五",
  "第1节,数学,语文,,英语,",
  "第2节,语文,数学,数学（带教具）,语文,班会",
].join("\n");

type Loader = { loadText: (text: string, label?: string) => Promise<void> };

async function presetClass(name: string): Promise<number> {
  const { timetable } = await findOrCreateTimetable(name, currentSemester());
  return timetable.id;
}

function importButton(wrapper: ReturnType<typeof mount>) {
  const btn = wrapper.findAll("button").find((b) => b.text().includes("开始导入"));
  expect(btn, "导入按钮应存在").toBeDefined();
  return btn!;
}

describe("ImportTimetableDialog", () => {
  it("keeps import disabled before a file is loaded", () => {
    const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
    expect(wrapper.text()).toContain("导入课表");
    expect(importButton(wrapper).attributes("disabled")).toBeDefined();
  });

  it("detects the layout, previews the grid and imports into the selected class", async () => {
    const className = "导入测试班";
    const id = await presetClass(className);
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV, "课表.csv");
      await flushPromises();

      expect(wrapper.text()).toContain("已识别星期表头与节次列");
      expect(wrapper.text()).toContain("数学 · 备注「带教具」");
      expect(importButton(wrapper).attributes("disabled")).toBeUndefined();

      await importButton(wrapper).trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("导入完成：成功 5 格");
      expect(wrapper.emitted("imported")).toHaveLength(1);
      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.find((s) => s.day_of_week === 3 && s.period === 2)).toMatchObject({
        subject: "数学",
        note: "带教具",
      });
      // 第1节只有周一/周二/周四有内容；空格不落库
      expect(slots.filter((s) => s.period === 1)).toHaveLength(3);
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("clears existing slots first when the option is checked", async () => {
    const className = "导入清空班";
    const id = await presetClass(className);
    await saveTimetableSlot(id, 5, 7, "旧课");
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText(CSV, "课表.csv");
      await wrapper.find('input[type="checkbox"]').setValue(true);
      await importButton(wrapper).trigger("click");
      await flushPromises();

      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.some((s) => s.subject === "旧课")).toBe(false);
      expect(slots.length).toBeGreaterThan(0);
    } finally {
      await clearTimetableSlots(id);
    }
  });

  it("falls back to manual header selection for ambiguous sheets", async () => {
    const className = "导入手工班";
    const id = await presetClass(className);
    try {
      const wrapper = mount(ImportTimetableDialog, { props: { open: true } });
      await flushPromises();
      await (wrapper.vm as unknown as Loader).loadText("A,B,C\n第1节,数学,语文");
      await flushPromises();

      expect(wrapper.text()).toContain("手动指定");
      const selects = wrapper.findAll("select");
      // 默认已预选：星期表头=第1行(0)、节次列=第1列(0)；映射按顺序假设周一/周二
      await importButton(wrapper).trigger("click");
      await flushPromises();

      const slots = (await getTimetableWithSlots(className, currentSemester()))!.slots;
      expect(slots.find((s) => s.day_of_week === 1 && s.period === 1)).toMatchObject({ subject: "数学" });
      expect(wrapper.emitted("imported")).toHaveLength(1);
    } finally {
      await clearTimetableSlots(id);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/import-timetable-dialog.test.ts`
- [ ] **Step 3: 实现组件**（新建 `src/components/ImportTimetableDialog.vue`，完整内容如下）

```vue
<script setup lang="ts">
/**
 * 导入课表对话框：Excel/CSV → 识别星期表头/节次表头 → 预览周网格 → 落库。
 * 与 ImportRosterDialog 同一交互骨架；文件管道复用 roster.ts（桌面 xlsx 走 Rust，浏览器仅 CSV）。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import {
  clearTimetableSlots,
  findOrCreateTimetable,
  isTauri,
  listClasses,
  saveTimetableSlot,
} from "../lib/db";
import { WEEKDAY_LABELS, currentSemester, subjectChipClass } from "../lib/timetable";
import {
  detectTimetableLayout,
  downloadTimetableTemplate,
  layoutFromSelection,
  mapTimetableCells,
  previewPeriods,
  type TimetableLayout,
} from "../lib/timetable-import";
import { decodeRosterBytes, parseRosterTable, pickRosterFile, type RosterTable } from "../lib/roster";
import { logError, logInfo } from "../lib/logger";

const props = defineProps<{ open: boolean; presetClass?: string }>();
const emit = defineEmits<{
  close: [];
  imported: [payload: { className: string; count: number }];
}>();

const classes = ref<string[]>([]);
const selectedClass = ref("");
const fileLabel = ref("");
const table = ref<RosterTable | null>(null);
const layout = ref<TimetableLayout | null>(null);
const manual = ref(false);
const manualPeriodRows = ref(true);
const manualDayHeader = ref(0);
const manualPeriodHeader = ref(0);
const clearing = ref(false);
const importing = ref(false);
const result = ref<{ imported: number; failed: string[] } | null>(null);
const error = ref("");

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    classes.value = [];
    selectedClass.value = props.presetClass ?? "";
    fileLabel.value = "";
    table.value = null;
    layout.value = null;
    manual.value = false;
    manualPeriodRows.value = true;
    manualDayHeader.value = 0;
    manualPeriodHeader.value = 0;
    clearing.value = false;
    importing.value = false;
    result.value = null;
    error.value = "";
    try {
      classes.value = (await listClasses()).map((c) => c.name);
    } catch {
      classes.value = [];
    }
  },
);

const mapping = computed(() =>
  table.value && layout.value ? mapTimetableCells(table.value, layout.value) : null,
);
const previewRows = computed(() => (mapping.value ? previewPeriods(mapping.value.cells) : []));
const canImport = computed(
  () =>
    !!(props.presetClass || selectedClass.value) &&
    !!mapping.value &&
    mapping.value.cells.length > 0 &&
    !importing.value,
);

/** 手动指定的候选轴：periodRows → 星期选行、节次选列；转置反之 */
const dayOptions = computed(() => {
  if (!table.value) return [];
  if (manualPeriodRows.value) {
    const n = table.value.rows.length + (table.value.hasHeader ? 1 : 0);
    return Array.from({ length: n }, (_, i) => ({ value: i, label: `第${i + 1}行` }));
  }
  return table.value.headers.map((h, i) => ({ value: i, label: `第${i + 1}列${h ? ` ${h}` : ""}` }));
});
const periodOptions = computed(() => {
  if (!table.value) return [];
  if (manualPeriodRows.value) {
    return table.value.headers.map((h, i) => ({ value: i, label: `第${i + 1}列${h ? ` ${h}` : ""}` }));
  }
  const n = table.value.rows.length + (table.value.hasHeader ? 1 : 0);
  return Array.from({ length: n }, (_, i) => ({ value: i, label: `第${i + 1}行` }));
});

async function loadTable(loaded: { table: RosterTable; sheet?: string }, label: string) {
  fileLabel.value = label;
  table.value = loaded.table;
  await analyze();
}

/** CSV 文本入口（浏览器演示态与测试注入共用） */
async function loadText(text: string, label = "") {
  fileLabel.value = label;
  try {
    table.value = parseRosterTable(text);
  } catch (e) {
    table.value = null;
    error.value = `解析失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  await analyze();
}

async function chooseFile() {
  error.value = "";
  result.value = null;
  if (isTauri()) {
    try {
      const loaded = await pickRosterFile();
      if (!loaded) return;
      await loadTable(loaded, loaded.fileName);
    } catch (e) {
      error.value = `读取文件失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return;
  }
  const file = await pickViaInput();
  if (!file) return;
  const text = decodeRosterBytes(await file.arrayBuffer()).text;
  await loadText(text, file.name);
}

/** 浏览器演示态的文件选择（<input type=file>；取消时靠窗口焦点回落识别） */
function pickViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(file);
    };
    const onFocus = () => setTimeout(() => done(input.files?.[0] ?? null), 300);
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

async function analyze() {
  if (!table.value) return;
  result.value = null;
  error.value = "";
  const detected = detectTimetableLayout(table.value);
  layout.value = detected;
  manual.value = !detected.ok;
  if (!detected.ok) {
    manualPeriodRows.value = detected.periodRows;
    manualDayHeader.value = Math.max(detected.dayHeader, 0);
    manualPeriodHeader.value = Math.max(detected.periodHeader, 0);
    applyManual();
  }
}

function applyManual() {
  if (!table.value) return;
  layout.value = layoutFromSelection(
    table.value,
    manualPeriodRows.value,
    manualDayHeader.value,
    manualPeriodHeader.value,
  );
}

async function doImport() {
  const m = mapping.value;
  const className = props.presetClass || selectedClass.value;
  if (!m || !className || importing.value) return;
  importing.value = true;
  error.value = "";
  try {
    const { timetable } = await findOrCreateTimetable(className, currentSemester());
    if (clearing.value) await clearTimetableSlots(timetable.id);
    const failed: string[] = [];
    for (const cell of m.cells) {
      try {
        await saveTimetableSlot(timetable.id, cell.day_of_week, cell.period, cell.subject, cell.note);
      } catch (e) {
        failed.push(
          `${WEEKDAY_LABELS[cell.day_of_week - 1]} 第${cell.period}节 ${cell.subject}：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    result.value = { imported: m.cells.length - failed.length, failed };
    logInfo(`课表导入完成：班级=${className} 成功 ${result.value.imported} 格，失败 ${failed.length} 格`);
    if (result.value.imported > 0) {
      emit("imported", { className, count: result.value.imported });
    }
  } catch (e) {
    logError("课表导入失败", e);
    error.value = `导入失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    importing.value = false;
  }
}

defineExpose({ loadText, loadTable });
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @click.self="emit('close')"
  >
    <div class="flex max-h-full w-[780px] max-w-full flex-col rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-4 flex shrink-0 items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">导入课表</h2>
        <button class="text-caption text-weak hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div class="scroll-thin relative min-h-0 flex-1 overflow-y-auto pr-1">
        <!-- 目标班级 + 文件 -->
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-caption text-ink">
            目标班级
            <select
              v-model="selectedClass"
              data-test="import-class-select"
              :disabled="!!props.presetClass"
              class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus disabled:opacity-60"
            >
              <option value="" disabled>请选择班级</option>
              <option v-for="c in classes" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <AppButton variant="secondary" @click="chooseFile">选择文件</AppButton>
          <AppButton variant="pearl" @click="downloadTimetableTemplate">下载模板</AppButton>
          <span class="min-w-0 flex-1 truncate text-caption text-weak">
            {{ fileLabel || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV）" }}
          </span>
        </div>

        <p v-if="error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ error }}</p>

        <template v-if="table && layout">
          <!-- 识别状态 -->
          <div class="mt-4 rounded-md bg-parchment p-3">
            <p class="text-caption text-ink">
              {{ layout.confidence === "high" ? "自动识别成功" : "未能完全识别，请手动指定" }} ·
              {{ layout.reason }}
            </p>
            <p
              v-for="c in (mapping?.cells ?? []).filter((x) => x.note)"
              :key="`${c.day_of_week}-${c.period}`"
              class="mt-1 text-fine text-weak"
            >
              {{ WEEKDAY_LABELS[c.day_of_week - 1] }} 第{{ c.period }}节：{{ c.subject }} · 备注「{{ c.note }}」
            </p>
            <p v-if="mapping?.skipped.length" class="mt-1 text-fine text-weak">
              已跳过非节次行：{{ mapping.skipped.join("、") }}
            </p>
            <p v-if="mapping?.droppedWeekendCells" class="mt-1 text-fine text-weak">
              周末列不会导入（丢弃 {{ mapping.droppedWeekendCells }} 格）
            </p>

            <!-- 低置信度：手动指定表头 -->
            <div v-if="manual" class="mt-2 flex flex-wrap items-center gap-3">
              <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1 text-caption"
                  :class="manualPeriodRows ? 'bg-canvas font-medium text-primary' : 'text-weak'"
                  @click="manualPeriodRows = true; applyManual()"
                >
                  行=节次
                </button>
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1 text-caption"
                  :class="!manualPeriodRows ? 'bg-canvas font-medium text-primary' : 'text-weak'"
                  @click="manualPeriodRows = false; applyManual()"
                >
                  列=节次
                </button>
              </div>
              <label class="flex items-center gap-2 text-caption text-ink">
                星期表头
                <select
                  v-model.number="manualDayHeader"
                  data-test="manual-day-header"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption"
                  @change="applyManual"
                >
                  <option v-for="o in dayOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="flex items-center gap-2 text-caption text-ink">
                节次表头
                <select
                  v-model.number="manualPeriodHeader"
                  data-test="manual-period-header"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption"
                  @change="applyManual"
                >
                  <option v-for="o in periodOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
            </div>
          </div>

          <!-- 预览：映射后的周网格 -->
          <div
            v-if="mapping && previewRows.length"
            class="scroll-thin mt-3 overflow-x-auto rounded-sm border border-hairline"
          >
            <table class="w-full text-caption">
              <thead>
                <tr class="bg-parchment text-left">
                  <th class="whitespace-nowrap px-3 py-2 font-normal text-weak">节次</th>
                  <th
                    v-for="w in WEEKDAY_LABELS"
                    :key="w"
                    class="whitespace-nowrap px-3 py-2 font-normal text-weak"
                  >
                    {{ w }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in previewRows" :key="p" class="border-t border-hairline">
                  <td class="whitespace-nowrap px-3 py-1.5 text-muted">第{{ p }}节</td>
                  <td v-for="(w, dayIdx) in WEEKDAY_LABELS" :key="w" class="px-1.5 py-1.5">
                    <span
                      v-for="cell in mapping.cells.filter((c) => c.day_of_week === dayIdx + 1 && c.period === p)"
                      :key="cell.subject"
                      class="mr-1 inline-block rounded-sm border px-1.5 py-0.5 text-fine"
                      :class="subjectChipClass(cell.subject)"
                      :title="cell.note ?? ''"
                    >
                      {{ cell.subject }}<template v-if="cell.note">（{{ cell.note }}）</template>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="mapping" class="mt-1 text-fine text-weak">
            共识别 {{ mapping.cells.length }} 格有内容的课；空格子不会写入。
          </p>

          <!-- 导入选项与结果 -->
          <label class="mt-3 flex items-center gap-2 text-caption text-muted">
            <input v-model="clearing" type="checkbox" data-test="clear-before-import" />
            清空该班现有课表后导入（覆盖整张表）
          </label>

          <div v-if="result" class="mt-4 rounded-md bg-parchment p-3">
            <p class="text-caption font-medium text-ink">
              导入完成：成功 {{ result.imported }} 格<template v-if="result.failed.length">，失败 {{ result.failed.length }} 格</template>
            </p>
            <ul v-if="result.failed.length" class="mt-1.5 space-y-0.5 text-fine text-weak">
              <li v-for="(f, i) in result.failed" :key="i">{{ f }}</li>
            </ul>
          </div>
        </template>
      </div>

      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ result ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" data-test="import-submit" @click="doImport">
          {{ importing ? "导入中…" : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/import-timetable-dialog.test.ts`

### Task 5: 我的课表页整表化

**Files:**
- Modify: `src/views/MyTimetableView.vue`
- Test: `tests/my-timetable-view.test.ts`（重写）

**Interfaces:**
- Consumes: Task 1 `periodsUnion` / `defaultPeriods`、Task 2 `listTimetablePeriodsByClass`、Task 4 `ImportTimetableDialog`
- Produces: 默认视图 `"week"`；`data-test="timetable-guide"`（空态引导卡）；`data-test="week-period-cell"` / `data-test="week-empty-cell"` / `data-test="subject-block-grid"` / `data-test="block-period-cell"`；header 常驻 `data-test="import-timetable-btn"`

- [ ] **Step 1: 重写测试**（`tests/my-timetable-view.test.ts` 全量替换为下文；router 需补 `/classes` 路由供引导卡链接解析）

```ts
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { describe, expect, it } from "vitest";
import MyTimetableView from "../src/views/MyTimetableView.vue";
import { profile } from "../src/lib/profile";
import { DEFAULT_PROFILE } from "../src/types";

/** jsdom 无 Tauri 外壳 → db.ts 走内存示例数据（三年级二班/三年级一班演示课表，周一第2节撞课） */
function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/timetable", name: "timetable", component: MyTimetableView },
      { path: "/profile", name: "profile", component: { template: "<div>profile</div>" } },
      { path: "/classes", name: "classes", component: { template: "<div>classes</div>" } },
      { path: "/classes/:name", name: "class-detail", component: { template: "<div>class</div>" }, props: true },
    ],
  });
  return mount(MyTimetableView, { global: { plugins: [router] } });
}

describe("MyTimetableView.vue", () => {
  it("defaults to the full week grid: 7 period rows even where I have no class", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.get('[data-test="subjects-missing-banner"]').text()).toContain("未登记任教学科");
    expect(wrapper.text()).toContain("周课表");
    // 节次行 = 全部默认节次（8 行），不随「我的课」缩水
    expect(wrapper.findAll('[data-test="week-period-cell"]')).toHaveLength(7);
    // 空格子可见（虚线占位）
    expect(wrapper.findAll('[data-test="week-empty-cell"]').length).toBeGreaterThan(0);
    // 日程卡仍在
    expect(wrapper.findAll('[data-test="week-event-day"]')).toHaveLength(5);
    wrapper.unmount();
  });

  it("shows the three-step guide when there is nothing to show", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: [] };
    const wrapper = mountView();
    await flushPromises();

    const guide = wrapper.get('[data-test="timetable-guide"]');
    expect(guide.text()).toContain("登记任教学科");
    expect(guide.text()).toContain("导入课表");
    expect(guide.text()).toContain("手工排课");
    wrapper.unmount();
  });

  it("aggregates my subjects across classes and flags conflicts (按科目视图整表)", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    // 默认周课表，切到按科目
    await wrapper.findAll("button").find((b) => b.text() === "按科目")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("每周共 8 节");
    expect(wrapper.find('[data-test="conflict-banner"]').exists()).toBe(true);
    // 按科目的网格也画满 8 行节次
    const blockGrid = wrapper.get('[data-test="subject-block-grid"]');
    expect(blockGrid.findAll('[data-test="block-period-cell"]')).toHaveLength(7);
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });

  it("week view renders dated columns, subject chips and five event day cards", async () => {
    profile.value = { ...DEFAULT_PROFILE, my_subjects: ["语文"] };
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain("周一");
    expect(wrapper.text()).toContain("周五");
    expect(wrapper.text()).toContain("调课后的实际行程");
    expect(wrapper.findAll("button").some((b) => b.classes().some((c) => c.includes("bg-rose-50")))).toBe(true);
    expect(wrapper.findAll('[data-test="week-event-day"]')).toHaveLength(5);
    // header 常驻导入入口
    expect(wrapper.get('[data-test="import-timetable-btn"]').text()).toContain("导入课表");
    wrapper.unmount();
    profile.value = { ...DEFAULT_PROFILE };
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/my-timetable-view.test.ts`

- [ ] **Step 3: 实现视图改造**（`src/views/MyTimetableView.vue`）

script 改动（既有 import 处追加，不改其他 import）：

```ts
import AppButton from "../components/ui/AppButton.vue";
import ImportTimetableDialog from "../components/ImportTimetableDialog.vue";
// ../lib/db 的既有 import 里追加：listTimetablePeriodsByClass
// ../lib/timetable 的既有 import 里追加：defaultPeriods, periodsUnion
// ../types 的既有 import 里追加：TimetablePeriod

const view = ref<"blocks" | "week">("week"); // 默认周课表
const importOpen = ref(false);
/** 整表行来源：各班节次配置并集（画满学校节次结构，不随有课节次缩水） */
const allPeriods = ref<TimetablePeriod[]>(defaultPeriods());
const amPeriods = computed(() => allPeriods.value.filter((p) => p.session === "morning"));
const pmPeriods = computed(() => allPeriods.value.filter((p) => p.session === "afternoon"));
/** 空态引导：没登记任教学科，或全库没有命中我的格子 */
const showGuide = computed(() => !loading.value && (!mySubjects.value.length || !schedule.weekly_total));
```

删除：`weekMaxPeriod` computed（:84-90）、`maxPeriodOf` 函数（:151-154，`sessionsAtBlock` 保留）。

把 `onMounted` 里的 rows/exceptions 加载抽成 `reloadSlots`（导入成功后复用）：

```ts
async function reloadSlots() {
  try {
    rows.value = await listTimetableSlotsWithClass(SEMESTER);
  } catch {
    rows.value = [];
  }
  const [start, end] = [weekDates.value[0], weekDates.value[4]];
  try {
    exceptions.value = await listTimetableExceptionsWithClass(SEMESTER, start, end);
  } catch {
    exceptions.value = [];
  }
  try {
    allPeriods.value = periodsUnion((await listTimetablePeriodsByClass(SEMESTER)).map((x) => x.periods));
  } catch {
    allPeriods.value = defaultPeriods();
  }
}

onMounted(async () => {
  await ensureProfile().catch(() => undefined);
  if (!mySubjects.value.length) view.value = "week";
  await reloadSlots();
  await reloadEvents();
  loading.value = false;
});
```

- [ ] **Step 4: 模板改动**

1. header 右侧、视图切换按钮之前加导入按钮：

```html
<AppButton variant="pearl" data-test="import-timetable-btn" @click="importOpen = true">
  导入课表
</AppButton>
```

2. 视图切换按钮文案：`本周日程` → `周课表`（`按科目` 不变）。

3. 周网格（原 `<template v-for="p in weekMaxPeriod" :key="p">` 区块整体替换）为「分组画满 + 空格占位」：

```html
<template v-for="(group, gi) in [amPeriods, pmPeriods]" :key="gi">
  <template v-if="group.length">
    <div v-if="gi > 0" class="flex items-center gap-3 py-1.5">
      <span class="text-fine text-weak">下午</span>
      <span class="h-px flex-1 bg-divider" />
    </div>
    <template v-for="p in group" :key="p.period">
      <div
        data-test="week-period-cell"
        class="flex min-h-[52px] flex-col items-center justify-center rounded-sm bg-pearl text-fine text-muted"
      >
        <span class="font-medium">{{ p.period }}</span>
        <span v-if="p.start && p.end" class="text-faint tnum">{{ p.start }}~{{ p.end }}</span>
      </div>
      <div v-for="date in weekDates" :key="`${p.period}-${date}`" class="flex min-h-[52px] flex-col gap-px">
        <button
          v-for="s in sessionsAt(date, p.period)"
          :key="`${s.class_name}-${s.subject}`"
          type="button"
          class="flex flex-1 flex-col items-start justify-center overflow-hidden rounded-sm border px-2 py-1 text-left transition-colors"
          :class="[
            subjectChipClass(s.subject),
            s.state === 'cancelled' ? 'line-through opacity-60' : 'hover:border-primary',
          ]"
          :title="`${s.subject} · ${s.class_name}${s.note ? `（${s.note}）` : ''}`"
          @click="goClass(s.class_name)"
        >
          <span class="flex w-full items-center gap-1">
            <span class="truncate text-fine font-medium">{{ s.subject }}</span>
            <span
              v-if="s.state !== 'normal'"
              class="ml-auto shrink-0 rounded-pill bg-primary-soft px-1.5 text-fine leading-4 text-primary"
            >
              {{ s.state === "cancelled" ? "停" : EXCEPTION_STATE_LABELS[s.state] }}
            </span>
          </span>
          <span class="truncate text-fine opacity-75">{{ s.class_name }}</span>
        </button>
        <div
          v-if="!sessionsAt(date, p.period).length"
          data-test="week-empty-cell"
          class="flex-1 rounded-sm border border-dashed border-divider bg-pearl/40"
        />
      </div>
    </template>
  </template>
</template>
```

4. 按科目网格：AppCard 内网格容器（`grid grid-cols-[56px_repeat(5,minmax(0,1fr))] gap-px`）加 `data-test="subject-block-grid"`；`<template v-for="p in maxPeriodOf(block)" :key="p">` 改为 `<template v-for="p in allPeriods" :key="p.period">`；节次格加 `data-test="block-period-cell"` 并显示时间；格子列改为「有课按钮 + 空占位」：

```html
<template v-for="p in allPeriods" :key="p.period">
  <div
    data-test="block-period-cell"
    class="flex h-11 flex-col items-center justify-center rounded-sm bg-pearl text-fine text-muted"
  >
    <span>{{ p.period }}</span>
    <span v-if="p.start && p.end" class="text-faint tnum">{{ p.start }}~{{ p.end }}</span>
  </div>
  <div v-for="day in 5" :key="day" class="relative">
    <button
      v-for="session in sessionsAtBlock(block, day, p.period)"
      :key="session.class_name"
      type="button"
      class="mb-px flex h-11 w-full flex-col items-start justify-center overflow-hidden rounded-sm border border-hairline bg-canvas px-2 text-left transition-colors hover:border-primary"
      :title="`${block.subject} · ${session.class_name}`"
      @click="goClass(session.class_name)"
    >
      <span class="truncate text-fine font-medium text-ink">{{ session.class_name }}</span>
      <span v-if="session.start && session.end" class="text-fine text-weak tnum">
        {{ session.start }}~{{ session.end }}
      </span>
    </button>
    <div
      v-if="!sessionsAtBlock(block, day, p.period).length"
      class="h-11 rounded-sm border border-dashed border-divider bg-pearl/40"
    />
  </div>
</template>
```

5. 空态：删除 `blocks-empty` 区块（含其 `v-else` 互斥结构——两个视图不再各自带空态分支），在冲突告警之后放共用引导卡：

```html
<div
  v-if="showGuide"
  data-test="timetable-guide"
  class="rounded-lg border border-hairline bg-canvas p-5"
>
  <h2 class="text-body font-semibold text-ink">三步把课表装进来</h2>
  <ol class="mt-3 space-y-2 text-caption text-muted">
    <li class="flex flex-wrap items-center gap-2">
      <span class="rounded-pill bg-pearl px-2 text-fine">1</span>
      登记任教学科，确定「哪些课是你的」
      <RouterLink to="/profile" class="text-primary hover:underline">去登记 →</RouterLink>
    </li>
    <li class="flex flex-wrap items-center gap-2">
      <span class="rounded-pill bg-pearl px-2 text-fine">2</span>
      导入 Excel / CSV 课表，自动识别星期与节次
      <button type="button" data-test="guide-import" class="text-primary hover:underline" @click="importOpen = true">
        导入课表 →
      </button>
    </li>
    <li class="flex flex-wrap items-center gap-2">
      <span class="rounded-pill bg-pearl px-2 text-fine">3</span>
      或到班级里逐格手排
      <RouterLink to="/classes" class="text-primary hover:underline">去班级排课 →</RouterLink>
    </li>
  </ol>
</div>
```

6. 模板根部（根 div 内最后）挂对话框：

```html
<ImportTimetableDialog :open="importOpen" @close="importOpen = false" @imported="reloadSlots" />
```

- [ ] **Step 5: 跑测试确认通过** — `rtk vitest run tests/my-timetable-view.test.ts`

### Task 6: 班级课程表 Tab 默认周网格

**Files:**
- Modify: `src/views/ClassDetailView.vue`（:65 `timetableView` 初始值；:565-600 Tab 模板）
- Test: `tests/class-detail-view.test.ts`

**Interfaces:**
- Consumes: Task 4 `ImportTimetableDialog`（`preset-class="props.name"`，`@imported` 后 `refreshTimetable()`）
- Produces: `data-test="timetable-view-grid"` / `data-test="timetable-view-calendar"` 切换按钮；`data-test="timetable-import-btn"`

- [ ] **Step 1: 写失败测试**（追加到 `tests/class-detail-view.test.ts`；该文件走 jsdom 内存演示数据，无 db mock）

```ts
it("opens the timetable tab on the editable week grid and toggles to the calendar", async () => {
  const router = createTestRouter();
  await router.push("/classes/三年级二班");
  await router.isReady();
  const wrapper = mount(ClassDetailView, { props: { name: "三年级二班" }, global: { plugins: [router] } });
  await flushPromises();

  await wrapper.get('[data-test="tab-timetable"]').trigger("click");
  await flushPromises();

  // 默认周网格（演示数据有格子）+ 导入入口 + 维护提示
  expect(wrapper.findAll('button[data-test="timetable-cell"]').length).toBeGreaterThan(0);
  expect(wrapper.get('[data-test="timetable-import-btn"]').text()).toContain("导入课表");
  expect(wrapper.text()).toContain("换课 / 停课 / 日程在日历视图维护");

  // 切日历：月历出现，铅笔入口仍在
  await wrapper.get('[data-test="timetable-view-calendar"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-test="calendar-title"]').exists()).toBe(true);
  expect(wrapper.find('button[data-test="edit-timetable-btn"]').exists()).toBe(true);

  // 再切回网格
  await wrapper.get('[data-test="timetable-view-grid"]').trigger("click");
  await flushPromises();
  expect(wrapper.findAll('button[data-test="timetable-cell"]').length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/class-detail-view.test.ts`

- [ ] **Step 3: 实现改造**

script：

```ts
const timetableView = ref<"calendar" | "grid">("grid"); // 默认进周网格
const timetableImportOpen = ref(false);
```

（`AppButton` 已在该文件 import；新增 `import ImportTimetableDialog from "../components/ImportTimetableDialog.vue";`）

模板：`<template v-else-if="timetable">` 区块整体替换为「头部工具行 + 双态内容」：

```html
<template v-else-if="timetable">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
      <button
        type="button"
        data-test="timetable-view-grid"
        class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
        :class="timetableView === 'grid' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
        @click="timetableView = 'grid'"
      >
        课表
      </button>
      <button
        type="button"
        data-test="timetable-view-calendar"
        class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
        :class="timetableView === 'calendar' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
        @click="timetableView = 'calendar'"
      >
        日历
      </button>
    </div>
    <div class="flex items-center gap-3">
      <p v-if="timetableView === 'grid'" class="text-fine text-weak">
        换课 / 停课 / 日程在日历视图维护
      </p>
      <AppButton variant="pearl" data-test="timetable-import-btn" @click="timetableImportOpen = true">
        导入课表
      </AppButton>
    </div>
  </div>

  <TimetableCalendar
    v-if="timetableView === 'calendar'"
    :class-name="props.name"
    :timetable="timetable"
    @edit="timetableView = 'grid'"
  />
  <TimetableGrid
    v-else
    :timetable="timetable"
    :slots="timetable.slots"
    editable
    :my-subjects="profile.my_subjects ?? []"
    @changed="refreshTimetable"
  />

  <ImportTimetableDialog
    :open="timetableImportOpen"
    :preset-class="props.name"
    @close="timetableImportOpen = false"
    @imported="refreshTimetable(); timetableImportOpen = false"
  />
</template>
```

同时删除原「完成，返回日历」按钮区块（`data-test="timetable-back-to-calendar"`，:581-588）与原来的 `v-if="timetableView === 'calendar'"` / 网格 `v-else` 包裹结构（铅笔按钮在 TimetableCalendar 内部，`@edit` 事件仍生效）。`:my-subjects` 处的 `profile` 用该文件既有的 profile 数据源（若无则改为 `[]` 常量——以实现时实际读法为准，保持现有 props 传递习惯）。

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/class-detail-view.test.ts tests/timetable-calendar.test.ts`

### Task 7: 首页面板行数修正

**Files:**
- Modify: `src/views/HomeView.vue`（:60-66 `weekMaxPeriod`；:104-114 `loadTodayTimetable`；:454-465 模板）
- Test: `tests/home-view.test.ts`

**Interfaces:**
- Consumes: Task 1 `periodsUnion`；`defaultPeriods`（lib/timetable 已导出）；类型 `TimetablePeriod`
- Produces: `weekPeriods: Ref<TimetablePeriod[]>`；模板 `data-test="panel-period-cell"`

- [ ] **Step 1: 写失败测试**（`tests/home-view.test.ts` 的「expands a centered semi-transparent week timetable」用例内追加断言；该用例 `dbMocks.listTimetableSlotsWithClass.mockResolvedValue(mondayRows)`，mondayRows 只有 period=2）

```ts
// 面板行数 = 学校节次结构全集（默认 8 行），不随「我的课」只有第 2 节而缩水
expect(wrapper.get('[data-test="panel-week-grid"]').exists()).toBe(true);
expect(wrapper.findAll('[data-test="panel-period-cell"]')).toHaveLength(7);
// 我的课仍出现在第 2 节
expect(wrapper.findAll('[data-test="panel-grid-session"]')).toHaveLength(2);
```

- [ ] **Step 2: 跑测试确认失败** — `rtk vitest run tests/home-view.test.ts`

- [ ] **Step 3: 实现**（`src/views/HomeView.vue`）

script（`../lib/timetable` 既有 import 追加 `defaultPeriods, periodsUnion`；`../types` 追加 `TimetablePeriod`）：

```ts
/** 周面板行 = 学校节次结构全集（各班 periods 并集），不随「我的课」缩水 */
const weekPeriods = ref<TimetablePeriod[]>(defaultPeriods());
```

删除 `weekMaxPeriod` computed（:60-66）。`loadTodayTimetable` 的 try 块内 `weekMyDays.value = map;` 之后加：

```ts
weekPeriods.value = periodsUnion(rows.map((r) => r.periods));
```

catch 块加 `weekPeriods.value = defaultPeriods();`。

模板（:454-457）：

```html
<template v-for="p in weekPeriods" :key="p.period">
  <div
    data-test="panel-period-cell"
    class="flex items-center justify-center rounded-sm bg-white/[0.06] tnum text-fine text-white/40"
  >
    {{ p.period }}
  </div>
  <div v-for="date in weekDates" :key="`${p.period}-${date}`" class="flex min-h-[44px] flex-col gap-1 rounded-sm p-px" :class="date === todayStr ? 'bg-white/[0.07]' : ''">
    <div
      v-for="s in sessionsAt(date, p.period)"
      .../* 内层原样，仅 p → p.period */
```

（`:key="`${p}-${date}`"` → `:key="`${p.period}-${date}`"`；`sessionsAt(date, p)` → `sessionsAt(date, p.period)`；其余内层结构不动。）

- [ ] **Step 4: 跑测试确认通过** — `rtk vitest run tests/home-view.test.ts`

### Task 8: 文档同步与全量验证

**Files:**
- Modify: `docs/TIMETABLE.md`（状态行 :3、决策记录追加 ⑩~⑫、§3 入口表「导入课表」行、§8 由 P1 改为已实现、§13 验收清单追加）

- [ ] **Step 1: 更新 docs/TIMETABLE.md**

1. :3 状态行追加：`；四轮整表化与导入已实现（2026-09-07）`，并补一句：`四轮新增：周课表网格成为课表类界面的默认形态（行=节次全集）、Excel/CSV 导入（识别星期/节次→预览→落库）、我的课表空态三步引导。`
2. 决策记录末尾追加（沿用既有格式）：

```markdown
> ⑩ **凡叫「课表」的界面必须画出完整节次网格**（2026-09-07 四轮）：行 = 学校节次结构全集（`periodsUnion` 合并各班 `periods_json`，全空回退默认 8 节），不随「我有课的节次」缩水；空格也是格子（虚线占位）。
> ⑪ **班级课程表 Tab 默认进周网格**：进 Tab 即见可编辑的 行=节次 × 列=周一~五 课表，月历降为「日历」切换项；调课/日程仍在日历侧维护，网格侧常驻提示。
> ⑫ **Excel/CSV 导入提前落地**（原 P1）：`lib/timetable-import.ts` 纯函数识别星期表头/节次表头（支持转置表、中文数字节次、括号备注、非节次行剔除、周末列丢弃）→ 预览 → 逐格 upsert；`ImportTimetableDialog.vue` 复用花名册文件管道与交互骨架；入口在「我的课表」页顶与班级课程表 Tab（预置当前班）；`import_timetable` Agent 工具后置。
```

3. §3 入口表追加一行：

```markdown
| 「我的课表」页顶 / 班级课程表 Tab「导入课表」 | Excel/CSV → 识别星期表头与节次表头（低置信度可手动指定）→ 预览周网格 → 逐格落库；可勾选「清空后导入」；支持下载 CSV 模板 |
```

4. §8 标题改为 `## 8. 导入（已实现，2026-09-07）`，首行改为陈述已实现与上文 ⑫ 的落点（`src/lib/timetable-import.ts`、`src/components/ImportTimetableDialog.vue`），识别规则清单保留；「4. 拍照识别（P2）」保留。
5. §13 末尾追加四轮验收项（与 spec 验收清单一致，抄 `docs/superpowers/specs/2026-09-07-timetable-full-grid-and-import-design.md` §8）。

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck
npm test
```

期望：typecheck 无错误；全部测试通过（既有 466 + 本轮新增）。

- [ ] **Step 3: 提交（征求用户意见后执行）**

本计划完成并验证后，向用户汇报改动清单并询问是否提交；如确认，建议拆两笔：

```bash
# 第一笔：本轮早前的资料身份枚举改动（先于本计划存在的工作区改动）
rtk git add src/types/index.ts src/views/ProfileView.vue src/views/HomeView.vue tests/profile-view.test.ts
rtk git commit -m "feat: 个人资料身份改为枚举下拉，首页不再展示身份"

# 第二笔：课表整表化与导入
rtk git add src/lib/timetable.ts src/lib/db.ts src/lib/timetable-import.ts src/components/ImportTimetableDialog.vue src/views/MyTimetableView.vue src/views/ClassDetailView.vue src/views/HomeView.vue docs/TIMETABLE.md docs/superpowers/specs/2026-09-07-timetable-full-grid-and-import-design.md docs/superpowers/plans/2026-09-07-timetable-full-grid-and-import.md tests/timetable-lib.test.ts tests/timetable-db.test.ts tests/timetable-import.test.ts tests/import-timetable-dialog.test.ts tests/my-timetable-view.test.ts tests/class-detail-view.test.ts tests/home-view.test.ts
rtk git commit -m "feat: 课表整表化（节次网格画满）+ Excel/CSV 导入与入口引导"
```

注意：HomeView.vue 同时含两轮改动（身份展示移除 + 周面板行数），如拆笔则按上述归属分别 stage 会有交叉——实现时若无法干净拆分，合为一笔提交并在提交信息里说明两部分内容。

## Self-Review 结论

- **Spec coverage**：§4.1→Task 1；§4.2/5.5→Task 2；§4.3/4.4→Task 3；§5.1→Task 4；§5.2→Task 5；§5.3→Task 6；§5.4→Task 7；§6 测试计划分散在各 Task 的测试步骤；§8 验收→Task 8 Step 1 回填 TIMETABLE.md。无遗漏。
- **Placeholder 扫描**：无 TBD/TODO；Task 6 `:my-subjects` 的 profile 传递方式以实现时实际读法为准（已在任务内注明），不构成占位。
- **类型一致性**：`periodsUnion` 签名在 Task 1 定义、Task 2/5/7 使用一致；`TimetableLayout`/`TimetableImportCell` 在 Task 3 定义、Task 4 使用一致；`clearTimetableSlots(timetableId): Promise<number>` Task 2 定义、Task 4 使用一致；`loadText(text, label?)` 暴露签名与 roster-dialog 测试套路一致。
