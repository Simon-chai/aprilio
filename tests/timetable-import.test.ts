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
    const csv = [
      "节次,第1节,第2节,第4节",
      "周一,数学,语文,体育",
      "周二,英语,数学,,",
      "周三,语文,,数学",
      "周四,数学,英语,",
      "周五,,语文,班会",
    ].join("\n");
    const layout = detectTimetableLayout(tableOf(csv));
    expect(layout.ok).toBe(true);
    expect(layout.periodRows).toBe(false);
    expect(layout.dayHeader).toBe(0);
    expect(layout.periodHeader).toBe(0);
    expect(layout.dataStart).toBe(1);
    expect(layout.dayMap).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
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
    const csv = ["节次,周一,周二,周三,周四,周六", "第1节,数学,,,,奥数"].join("\n");
    const layout = detectTimetableLayout(tableOf(csv));
    const { cells, droppedWeekendCells } = mapTimetableCells(tableOf(csv), layout);
    expect(droppedWeekendCells).toBe(1);
    expect(cells.every((c) => c.day_of_week <= 5)).toBe(true);
  });

  it("maps transposed layout", () => {
    const csv = [
      "节次,第1节,第2节",
      "周一,数学,语文",
      "周二,英语,数学",
      "周三,语文,,",
      "周四,数学,英语",
      "周五,,班会",
    ].join("\n");
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
