import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Photo, ClassSummary } from "../src/types";

describe("class types", () => {
  it("defines Photo and ClassSummary interfaces correctly in src/types/index.ts", () => {
    const typesPath = path.resolve(__dirname, "../src/types/index.ts");
    const content = fs.readFileSync(typesPath, "utf-8");

    // Must define ClassSummary interface
    expect(content).toContain("export interface ClassSummary");
    expect(content).toMatch(/studentCount:\s*number;/);
    expect(content).toMatch(/maleCount:\s*number;/);
    expect(content).toMatch(/femaleCount:\s*number;/);
    expect(content).toMatch(/photoCount:\s*number;/);
    expect(content).toMatch(/classPhotoCount:\s*number;/);
    expect(content).toMatch(/studentPhotoCount:\s*number;/);

    // Photo must support class public photos (student_id: number | null, grade_class?: string | null)
    expect(content).toMatch(/student_id:\s*number\s*\|\s*null;/);
    expect(content).toMatch(/grade_class\?:\s*string\s*\|\s*null;/);
  });

  it("allows Photo to have null student_id and grade_class for class public photos", () => {
    const classPhoto: Photo = {
      id: 1,
      student_id: null,
      grade_class: "三年二班",
      file_name: "class_photo_1.jpg",
      caption: "班级合影",
      taken_at: "2026-09-01",
      created_at: "2026-09-01 10:00:00",
    };

    expect(classPhoto.student_id).toBeNull();
    expect(classPhoto.grade_class).toBe("三年二班");

    const studentPhoto: Photo = {
      id: 2,
      student_id: 10,
      grade_class: null,
      file_name: "student_photo_1.jpg",
      caption: null,
      taken_at: null,
      created_at: "2026-09-01 10:00:00",
    };

    expect(studentPhoto.student_id).toBe(10);
    expect(studentPhoto.grade_class).toBeNull();
  });

  it("verifies ClassSummary structure and properties", () => {
    const summary: ClassSummary = {
      name: "三年二班",
      studentCount: 42,
      maleCount: 22,
      femaleCount: 20,
      photoCount: 15,
      classPhotoCount: 5,
      studentPhotoCount: 10,
    };

    expect(summary.name).toBe("三年二班");
    expect(summary.studentCount).toBe(42);
    expect(summary.maleCount).toBe(22);
    expect(summary.femaleCount).toBe(20);
    expect(summary.photoCount).toBe(15);
    expect(summary.classPhotoCount).toBe(5);
    expect(summary.studentPhotoCount).toBe(10);
  });
});
