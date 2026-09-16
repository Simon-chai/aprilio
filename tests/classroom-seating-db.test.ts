import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  clearSeating,
  createStudent,
  listClassroomActivitySets,
  listSeating,
  removeSeatingStudent,
  saveClassroomActivitySet,
  upsertSeating,
} from "../src/lib/db";
import { emptyStudentInput } from "../src/types";

/**
 * 座位表（seatings，学期域）：一人一座、按格覆盖幂等、清座、学期隔离；活动组合配置同文件覆盖。
 */

const CLASS = "座位测试班甲";
const OTHER = "座位测试班乙";
const SEMESTER = "2026-2027-1";
const NEXT_SEMESTER = "2026-2027-2";

async function newStudent(name: string): Promise<number> {
  return createStudent({ ...emptyStudentInput(), name, grade_class: CLASS });
}

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  await clearAll();
});

describe("seating data access", () => {
  it("upserts seats and lists them by row then col", async () => {
    const a = await newStudent("座位甲");
    const b = await newStudent("座位乙");

    const seatA = await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 2,
      col_no: 1,
      group_no: 1,
      student_id: a,
    });
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 3,
      group_no: 3,
      student_id: b,
    });

    expect(seatA.id).toBeGreaterThan(0);
    expect(seatA.class_name).toBe(CLASS);
    expect(seatA.semester).toBe(SEMESTER);
    expect(seatA.student_id).toBe(a);
    expect(seatA.group_no).toBe(1);
    expect(seatA.created_at).toBeTruthy();

    const seats = await listSeating(CLASS, SEMESTER);
    expect(seats.map((s) => [s.row_no, s.col_no, s.student_id])).toEqual([
      [1, 3, b],
      [2, 1, a],
    ]);
    expect(await listSeating("不存在的班", SEMESTER)).toEqual([]);
  });

  it("keeps one seat per student (moving removes the old seat)", async () => {
    const a = await newStudent("换座甲");
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 1,
      student_id: a,
    });
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 3,
      col_no: 2,
      group_no: 2,
      student_id: a,
    });

    const seats = await listSeating(CLASS, SEMESTER);
    expect(seats).toHaveLength(1);
    expect([seats[0].row_no, seats[0].col_no, seats[0].group_no]).toEqual([3, 2, 2]);
  });

  it("overwrites the same cell idempotently", async () => {
    const a = await newStudent("占格甲");
    const b = await newStudent("占格乙");

    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 1,
      student_id: a,
    });
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 4,
      student_id: b,
    });

    const seats = await listSeating(CLASS, SEMESTER);
    expect(seats).toHaveLength(1);
    expect(seats[0].student_id).toBe(b);
    expect(seats[0].group_no).toBe(4);

    // 同一学生对同一格重复写：仍只有一行
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 4,
      student_id: b,
    });
    expect(await listSeating(CLASS, SEMESTER)).toHaveLength(1);
  });

  it("isolates semesters and classes", async () => {
    const a = await newStudent("学期甲");
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 1,
      student_id: a,
    });
    await upsertSeating({
      class_name: CLASS,
      semester: NEXT_SEMESTER,
      row_no: 2,
      col_no: 2,
      group_no: 2,
      student_id: a,
    });
    await upsertSeating({
      class_name: OTHER,
      semester: SEMESTER,
      row_no: 5,
      col_no: 5,
      group_no: 5,
      student_id: a,
    });

    expect((await listSeating(CLASS, SEMESTER)).map((s) => s.col_no)).toEqual([1]);
    expect((await listSeating(CLASS, NEXT_SEMESTER)).map((s) => s.col_no)).toEqual([2]);
    expect((await listSeating(OTHER, SEMESTER)).map((s) => s.col_no)).toEqual([5]);
  });

  it("removes a student's seat and clears a class semester", async () => {
    const a = await newStudent("清座甲");
    const b = await newStudent("清座乙");
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 1,
      group_no: 1,
      student_id: a,
    });
    await upsertSeating({
      class_name: CLASS,
      semester: SEMESTER,
      row_no: 1,
      col_no: 2,
      group_no: 1,
      student_id: b,
    });

    await removeSeatingStudent(CLASS, SEMESTER, a);
    expect((await listSeating(CLASS, SEMESTER)).map((s) => s.student_id)).toEqual([b]);
    // 幂等：重复移除不报错
    await expect(removeSeatingStudent(CLASS, SEMESTER, a)).resolves.toBeUndefined();

    await clearSeating(CLASS, SEMESTER);
    expect(await listSeating(CLASS, SEMESTER)).toEqual([]);
  });

  it("rejects invalid input with Chinese errors", async () => {
    const a = await newStudent("校验甲");
    const base = { class_name: CLASS, semester: SEMESTER, row_no: 1, col_no: 1, group_no: 0, student_id: a };
    await expect(upsertSeating({ ...base, class_name: " " })).rejects.toThrow("班级名不能为空");
    await expect(upsertSeating({ ...base, semester: "2026-2027" })).rejects.toThrow("学期号格式");
    await expect(upsertSeating({ ...base, row_no: 0 })).rejects.toThrow("行号");
    await expect(upsertSeating({ ...base, col_no: 0 })).rejects.toThrow("列号");
    await expect(upsertSeating({ ...base, group_no: -1 })).rejects.toThrow("组号");
  });
});

describe("classroom activity set data access", () => {
  it("saves, updates by (name, subject) and orders by sort_order", async () => {
    const picker = await saveClassroomActivitySet({
      name: "数学课",
      subject: "数学",
      activities: [{ type: "picker" }, { type: "group-race", config: { groups: 6 } }],
      sort_order: 2,
    });
    const common = await saveClassroomActivitySet({
      name: "通用",
      subject: "",
      activities: [{ type: "picker" }],
    });

    expect(picker.id).toBeGreaterThan(0);
    expect(picker.subject).toBe("数学");
    expect(picker.activities).toEqual([{ type: "picker" }, { type: "group-race", config: { groups: 6 } }]);
    expect(picker.sort_order).toBe(2);
    expect(common.sort_order).toBe(0);
    expect(common.created_at).toBeTruthy();

    const listed = await listClassroomActivitySets();
    expect(listed.map((s) => s.name)).toEqual(["通用", "数学课"]); // sort_order 升序

    // 同名同科目 = 更新而不新增
    const updated = await saveClassroomActivitySet({
      name: "数学课",
      subject: "数学",
      activities: [{ type: "digest" }],
      sort_order: 1,
    });
    expect(updated.id).toBe(picker.id);
    expect(updated.activities).toEqual([{ type: "digest" }]);
    expect(await listClassroomActivitySets()).toHaveLength(2);

    // 有 id 时按 id 更新
    const byId = await saveClassroomActivitySet({
      id: common.id,
      name: "通用改名",
      subject: "",
      activities: [{ type: "seating" }],
      sort_order: 0,
    });
    expect(byId.id).toBe(common.id);
    expect(byId.name).toBe("通用改名");
    expect(byId.activities).toEqual([{ type: "seating" }]);
    expect(await listClassroomActivitySets()).toHaveLength(2);
  });

  it("rejects invalid input with Chinese errors", async () => {
    await expect(
      saveClassroomActivitySet({ name: "  ", subject: "", activities: [] })
    ).rejects.toThrow("名称不能为空");
    await expect(
      saveClassroomActivitySet({
        name: "组合",
        subject: "",
        activities: "picker" as unknown as [],
      })
    ).rejects.toThrow("活动组合");
  });
});