import { describe, expect, it } from "vitest";
import { emptyStudentInput, type Guardian, type StudentInput } from "../src/types";

describe("Student and Guardian Types", () => {
  it("emptyStudentInput creates valid input with empty guardians array and gender 男", () => {
    const input = emptyStudentInput();
    expect(input.gender).toBe("男");
    expect(input.guardians).toEqual([]);
    expect(input.name).toBe("");
  });

  it("supports student with multiple guardians", () => {
    const guardians: Guardian[] = [
      { name: "李建国", phone: "13800001111", relation: "父亲", is_primary: true },
      { name: "王秀英", phone: "13900002222", relation: "母亲", is_primary: false },
    ];
    const student: StudentInput = {
      name: "李小明",
      gender: "男",
      birth_date: "2017-05-01",
      student_no: "20230001",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: "测试住址",
      status: "active",
      note: null,
      guardians,
    };
    expect(student.guardians.length).toBe(2);
    expect(student.guardians[0].relation).toBe("父亲");
  });
});
