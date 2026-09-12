import { describe, expect, it } from "vitest";
import { semesterIndex, semesterOfDate } from "../src/lib/semester";

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

describe("semesterOfDate", () => {
  it("derives the semester a date belongs to", () => {
    expect(semesterOfDate("2026-11-05")).toBe("2026-2027-1");
    expect(semesterOfDate("2027-01-15")).toBe("2026-2027-1");
    expect(semesterOfDate("2026-05-01")).toBe("2025-2026-2");
  });
});
