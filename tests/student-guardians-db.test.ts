import { describe, expect, it } from "vitest";
import { createStudent, deleteStudent, getStudent, listStudents, updateStudent } from "../src/lib/db";
import type { StudentInput } from "../src/types";

describe("db student guardians CRUD operations", () => {
  it("creates student with multiple guardians and retrieves them via getStudent", async () => {
    const input: StudentInput = {
      name: "多监护人测试生",
      gender: "女",
      birth_date: "2017-09-01",
      student_no: "GUARD_TEST_001",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: "杭州市西湖区",
      status: "active",
      note: "测试学生",
      guardians: [
        { name: "张三", phone: "13811112222", relation: "父亲", is_primary: true },
        { name: "李四", phone: "13933334444", relation: "母亲", is_primary: false },
      ],
    };

    const id = await createStudent(input);
    expect(id).toBeGreaterThan(0);

    try {
      const student = await getStudent(id);
      expect(student).not.toBeNull();
      expect(student?.name).toBe("多监护人测试生");
      expect(student?.gender).toBe("女");
      expect(student?.guardians.length).toBe(2);
      expect(student?.guardians[0].name).toBe("张三");
      expect(student?.guardians[0].relation).toBe("父亲");
      expect(student?.guardians[0].is_primary).toBe(true);
      expect(student?.guardians[1].name).toBe("李四");

      const rows = await listStudents("多监护人测试生");
      expect(rows.length).toBe(1);
      expect(rows[0].primary_phone).toBe("13811112222");
      expect(rows[0].primary_relation).toBe("父亲");
    } finally {
      await deleteStudent(id);
    }
  });

  it("updates student guardians properly by replacing existing guardians", async () => {
    const input: StudentInput = {
      name: "更名测试生",
      gender: "男",
      birth_date: "2017-01-01",
      student_no: "GUARD_TEST_002",
      grade_class: "三年级一班",
      enroll_date: "2024-09-01",
      address: null,
      status: "active",
      note: null,
      guardians: [
        { name: "原监护人", phone: "13500000000", relation: "监护人", is_primary: true },
      ],
    };
    const id = await createStudent(input);

    try {
      await updateStudent(id, {
        ...input,
        gender: "男",
        guardians: [
          { name: "新监护人A", phone: "13611111111", relation: "父亲", is_primary: true },
          { name: "新监护人B", phone: "13622222222", relation: "母亲", is_primary: false },
          { name: "新监护人C", phone: "13633333333", relation: "爷爷", is_primary: false },
        ],
      });

      const updated = await getStudent(id);
      expect(updated?.guardians.length).toBe(3);
      expect(updated?.guardians.map((g) => g.name)).toEqual(["新监护人A", "新监护人B", "新监护人C"]);
    } finally {
      await deleteStudent(id);
    }
  });

  it("cascades delete of guardians when student is deleted", async () => {
    const id = await createStudent({
      name: "待删学生",
      gender: "男",
      birth_date: "2017-01-01",
      student_no: "GUARD_TEST_003",
      grade_class: "",
      enroll_date: null,
      address: null,
      status: "active",
      note: null,
      guardians: [{ name: "待删监护人", phone: "13000000000", relation: "其他", is_primary: true }],
    });

    await deleteStudent(id);
    const notFound = await getStudent(id);
    expect(notFound).toBeNull();
  });
});
