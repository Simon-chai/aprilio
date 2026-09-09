import { describe, expect, it } from "vitest";
import {
  classCurrentLabel,
  gradeAt,
  gradeLabel,
  semesterIndex,
  semesterOfDate,
  semesterTerm,
  upgradedClasses,
} from "../src/lib/semester";

describe("semesterIndex", () => {
  it("assigns consecutive indices to autumn then spring then next autumn", () => {
    const a = semesterIndex("2025-2026-1");
    const b = semesterIndex("2025-2026-2");
    const c = semesterIndex("2026-2027-1");
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it("returns NaN for malformed semester text", () => {
    expect(Number.isNaN(semesterIndex("随便写的"))).toBe(true);
    expect(Number.isNaN(semesterIndex(""))).toBe(true);
  });
});

describe("gradeAt", () => {
  it("stays in the same grade across autumn→spring", () => {
    expect(gradeAt(3, "2025-2026-1", new Date(2026, 4, 1))).toBe(3); // 2026 春季
  });

  it("promotes one grade after a full academic year", () => {
    expect(gradeAt(3, "2025-2026-1", new Date(2026, 8, 6))).toBe(4); // 2026 秋季
  });

  it("promotes two grades after two academic years", () => {
    expect(gradeAt(3, "2025-2026-1", new Date(2027, 8, 6))).toBe(5);
  });

  it("clamps to entry grade when entry semester is in the future", () => {
    expect(gradeAt(3, "2026-2027-1", new Date(2025, 8, 6))).toBe(3);
  });
});

describe("semesterTerm", () => {
  it("reports autumn for Sep-Dec and Jan-Feb, spring for Mar-Aug", () => {
    expect(semesterTerm(new Date(2026, 8, 6))).toBe(1);
    expect(semesterTerm(new Date(2027, 0, 15))).toBe(1);
    expect(semesterTerm(new Date(2026, 4, 1))).toBe(2);
  });
});

describe("semesterOfDate", () => {
  it("derives the semester a date belongs to", () => {
    expect(semesterOfDate("2026-11-05")).toBe("2026-2027-1");
    expect(semesterOfDate("2027-01-15")).toBe("2026-2027-1");
    expect(semesterOfDate("2026-05-01")).toBe("2025-2026-2");
  });
});

describe("gradeLabel / classCurrentLabel", () => {
  it("renders Chinese grade names", () => {
    expect(gradeLabel(1)).toBe("一年级");
    expect(gradeLabel(6)).toBe("六年级");
    expect(gradeLabel(7)).toBe("7年级");
  });

  it("renders current grade and term for a registered class", () => {
    expect(classCurrentLabel(3, "2025-2026-1", new Date(2026, 8, 6))).toBe(
      "四年级 · 上学期"
    );
    expect(classCurrentLabel(3, "2025-2026-1", new Date(2026, 4, 1))).toBe(
      "三年级 · 下学期"
    );
  });

  it("returns null when grade or semester is missing", () => {
    expect(classCurrentLabel(null, "2025-2026-1")).toBeNull();
    expect(classCurrentLabel(3, null)).toBeNull();
  });
});

describe("upgradedClasses", () => {
  const at = new Date(2026, 8, 6); // 2026 秋季

  it("flags registered classes that have advanced a grade", () => {
    const notices = upgradedClasses(
      [
        { name: "升了", entry_grade: 3, entry_semester: "2025-2026-1", archived_at: null },
        { name: "没升", entry_grade: 3, entry_semester: "2026-2027-1", archived_at: null },
        { name: "已归档", entry_grade: 3, entry_semester: "2025-2026-1", archived_at: "2026-09-01" },
        { name: "没登记", entry_grade: null, entry_semester: null },
      ],
      at
    );
    expect(notices.map((n) => n.name)).toEqual(["升了"]);
    expect(notices[0].grade).toBe(4);
    expect(notices[0].label).toBe("四年级 · 上学期");
  });
});
