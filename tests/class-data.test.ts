import { describe, expect, it } from "vitest";
import {
  addClassPhoto,
  createStudent,
  deleteStudent,
  getClassSummary,
  listClasses,
  listPhotosByClass,
  listStudents,
} from "../src/lib/db";
import type { StudentInput } from "../src/types";

describe("class data and aggregation interfaces in db", () => {
  it("listClasses returns ClassSummary[] with counts and sorted by name", async () => {
    const classes = await listClasses();
    expect(Array.isArray(classes)).toBe(true);
    expect(classes.length).toBeGreaterThan(0);

    // Verify sort order with localeCompare("zh")
    const names = classes.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "zh"));
    expect(names).toEqual(sorted);

    // Verify fields on each summary
    for (const c of classes) {
      expect(typeof c.name).toBe("string");
      expect(c.studentCount).toBeGreaterThanOrEqual(0);
      expect(c.maleCount).toBeGreaterThanOrEqual(0);
      expect(c.femaleCount).toBeGreaterThanOrEqual(0);
      expect(c.studentCount).toBe(c.maleCount + c.femaleCount);
      expect(c.photoCount).toBe(c.classPhotoCount + c.studentPhotoCount);
    }

    // Check specific seeded class: 三年级二班
    const c32 = classes.find((c) => c.name === "三年级二班");
    expect(c32).toBeDefined();
    if (!c32) return;
    expect(c32.studentCount).toBe(2);
    expect(c32.maleCount).toBe(1);
    expect(c32.femaleCount).toBe(1);
    expect(c32.classPhotoCount).toBeGreaterThanOrEqual(1);
    expect(c32.studentPhotoCount).toBeGreaterThan(0);
    expect(c32.photoCount).toBe(c32.classPhotoCount + c32.studentPhotoCount);
  });

  it("listStudents filters correctly by gradeClass including 未分班", async () => {
    const classStudents = await listStudents("", "三年级二班");
    expect(classStudents.length).toBe(2);
    expect(classStudents.every((s) => s.grade_class === "三年级二班")).toBe(true);

    // Test filter with keyword + gradeClass
    const filtered = await listStudents("知远", "三年级二班");
    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("林知远");

    // Test 未分班
    const testStudent: StudentInput = {
      name: "临时无班生",
      gender: "男",
      birth_date: "2018-02-01",
      student_no: "NO_CLASS_001",
      grade_class: "",
      enroll_date: "2026-09-01",
      guardian_name: null,
      guardian_phone: null,
      address: null,
      status: "active",
      note: null,
    };
    const createdId = await createStudent(testStudent);
    try {
      const unassigned = await listStudents("", "未分班");
      expect(unassigned.some((s) => s.id === createdId)).toBe(true);
      expect(unassigned.every((s) => !s.grade_class || s.grade_class === "未分班")).toBe(true);

      const classesWithUnassigned = await listClasses();
      const unassignedSummary = classesWithUnassigned.find((c) => c.name === "未分班");
      expect(unassignedSummary).toBeDefined();
      expect(unassignedSummary!.studentCount).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteStudent(createdId);
    }
  });

  it("getClassSummary returns summary for specified class or null if not found", async () => {
    const summary = await getClassSummary("三年级二班");
    expect(summary).not.toBeNull();
    expect(summary?.name).toBe("三年级二班");
    expect(summary?.studentCount).toBe(2);

    const notFound = await getClassSummary("不存在的班级测试");
    expect(notFound).toBeNull();
  });

  it("addClassPhoto adds a class public photo with null student_id and grade_class set", async () => {
    const beforeSummary = await getClassSummary("四年级一班");
    const beforeClassPhotoCount = beforeSummary?.classPhotoCount ?? 0;

    const photoId = await addClassPhoto(
      "四年级一班",
      "test-class-photo.jpg",
      "四年级一班集体活动",
      "2026-09-05"
    );
    expect(photoId).toBeGreaterThan(0);

    const afterSummary = await getClassSummary("四年级一班");
    expect(afterSummary?.classPhotoCount).toBe(beforeClassPhotoCount + 1);

    const classPhotos = await listPhotosByClass("四年级一班", "public");
    const added = classPhotos.find((p) => p.id === photoId);
    expect(added).toBeDefined();
    expect(added?.student_id).toBeNull();
    expect(added?.grade_class).toBe("四年级一班");
    expect(added?.file_name).toBe("test-class-photo.jpg");
    expect(added?.caption).toBe("四年级一班集体活动");
  });

  it("listPhotosByClass filters photos by all, public, and student", async () => {
    const allPhotos = await listPhotosByClass("三年级二班", "all");
    const publicPhotos = await listPhotosByClass("三年级二班", "public");
    const studentPhotos = await listPhotosByClass("三年级二班", "student");

    expect(allPhotos.length).toBe(publicPhotos.length + studentPhotos.length);
    expect(publicPhotos.every((p) => p.student_id === null && p.grade_class === "三年级二班")).toBe(true);
    expect(studentPhotos.every((p) => p.student_id !== null)).toBe(true);
  });
});
