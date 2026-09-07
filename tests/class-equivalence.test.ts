import { describe, expect, it } from "vitest";
import {
  addClassPhoto,
  createClass,
  createStudent,
  getClassSummary,
  listClasses,
  listPhotosByClass,
  listStudents,
  renameClass,
} from "../src/lib/db";
import type { StudentInput } from "../src/types";

/** 花名册无班级列（或未选预设班级）时的入参形态：grade_class 留空，落进虚拟「未分班」分组 */
function importedInput(name: string, studentNo: string, gradeClass = ""): StudentInput {
  return {
    name,
    gender: "男",
    birth_date: "2017-06-01",
    student_no: studentNo,
    grade_class: gradeClass,
    id_card: null,
    address: null,
    status: "active",
    note: null,
  };
}

describe("新建班级 与 「未分班导入后重命名」 的终态一致性", () => {
  it("两条路径收敛出相同的数据组成（学生/照片/班级汇总）", async () => {
    const className = "对比三年二班";

    // 路径 A：页面新建班级，学生直接建到班里，公共照片挂在班级名下
    await createClass(className);
    const idA = await createStudent(importedInput("路径A学生", "EQA_001", className));
    await addClassPhoto(className, "eq-path-a.jpg", "路径A合影", "2026-09-01");

    // 路径 B：智能导入未带班级 → 学生进入虚拟「未分班」→ 重命名为目标班级
    const idB = await createStudent(importedInput("路径B学生", "EQB_001"));
    await addClassPhoto("未分班", "eq-path-b.jpg", "路径B合影", "2026-09-01");
    await renameClass("未分班", className);

    // 终态 1：班级列表无「未分班」残留，目标班级合并了两条路径的学生与照片
    const classes = await listClasses();
    expect(classes.some((c) => c.name === "未分班")).toBe(false);
    const summary = await getClassSummary(className);
    expect(summary?.studentCount).toBe(2);
    expect(summary?.classPhotoCount).toBe(2);

    // 终态 2：两名学生的 grade_class 完全一致
    const rows = await listStudents("", className);
    expect(rows.find((s) => s.id === idA)?.grade_class).toBe(className);
    expect(rows.find((s) => s.id === idB)?.grade_class).toBe(className);

    // 终态 3：公共照片的 grade_class 去噪字段一致，且都能被改名后的班级查到
    const publicPhotos = await listPhotosByClass(className, "public");
    expect(publicPhotos.map((p) => p.file_name).sort()).toEqual(["eq-path-a.jpg", "eq-path-b.jpg"]);
    expect(publicPhotos.every((p) => p.grade_class === className && p.student_id === null)).toBe(true);
  });
});
