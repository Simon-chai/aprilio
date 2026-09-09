import { afterEach, describe, expect, it } from "vitest";
import {
  archiveClass,
  createClass,
  deleteClass,
  getClassMeta,
  listClasses,
  listTermComments,
  restoreClass,
  saveClassMeta,
  upsertTermComment,
} from "../src/lib/db";
import { createStudent, deleteStudent } from "../src/lib/db";
import type { StudentInput } from "../src/types";

const CLASS_A = "学期测试班A";
const CLASS_B = "学期测试班B";

function studentInput(name: string, studentNo: string, gradeClass: string): StudentInput {
  return {
    name,
    gender: "男",
    birth_date: null,
    student_no: studentNo,
    grade_class: gradeClass,
    id_card: null,
    address: null,
    status: "active",
    note: null,
  };
}

async function cleanup() {
  await deleteClass(CLASS_A);
  await deleteClass(CLASS_B);
}

describe("semester class meta + archive", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("saves and reads class meta idempotently", async () => {
    await createClass(CLASS_A);
    expect(await getClassMeta(CLASS_A)).toEqual({
      entry_grade: null,
      entry_semester: null,
      archived_at: null,
    });

    await saveClassMeta(CLASS_A, { entry_grade: 3, entry_semester: "2025-2026-1" });
    expect(await getClassMeta(CLASS_A)).toMatchObject({
      entry_grade: 3,
      entry_semester: "2025-2026-1",
      archived_at: null,
    });

    // 再次保存覆盖，不新增
    await saveClassMeta(CLASS_A, { entry_grade: 4, entry_semester: "2026-2027-1" });
    expect(await getClassMeta(CLASS_A)).toMatchObject({
      entry_grade: 4,
      entry_semester: "2026-2027-1",
    });
  });

  it("validates grade range and semester format", async () => {
    await createClass(CLASS_A);
    await expect(saveClassMeta(CLASS_A, { entry_grade: 0 })).rejects.toThrow("年级");
    await expect(saveClassMeta(CLASS_A, { entry_grade: 7 })).rejects.toThrow("年级");
    await expect(
      saveClassMeta(CLASS_A, { entry_semester: "2026秋" })
    ).rejects.toThrow("学期号");
  });

  it("archives and restores a class without touching its students", async () => {
    await createClass(CLASS_A);
    const sid = await createStudent(studentInput("归档学生", "SEM_001", CLASS_A));

    await archiveClass(CLASS_A);
    const archived = await getClassMeta(CLASS_A);
    expect(archived.archived_at).toBeTruthy();

    // 归档不删学生：班级仍在汇总里，但带归档标记
    const list = await listClasses();
    const summary = list.find((c) => c.name === CLASS_A);
    expect(summary?.studentCount).toBe(1);
    expect(summary?.archived_at).toBeTruthy();

    await restoreClass(CLASS_A);
    expect((await getClassMeta(CLASS_A)).archived_at).toBeNull();

    await deleteStudent(sid);
  });

  it("exposes meta on listClasses", async () => {
    await createClass(CLASS_B);
    await saveClassMeta(CLASS_B, { entry_grade: 2, entry_semester: "2025-2026-1" });
    const summary = (await listClasses()).find((c) => c.name === CLASS_B);
    expect(summary).toMatchObject({
      entry_grade: 2,
      entry_semester: "2025-2026-1",
      archived_at: null,
    });
  });
});

describe("student term comments", () => {
  let sid = 0;

  afterEach(async () => {
    if (sid) await deleteStudent(sid);
    sid = 0;
    await cleanup();
  });

  it("upserts one comment per student+semester", async () => {
    await createClass(CLASS_A);
    sid = await createStudent(studentInput("评语学生", "SEM_002", CLASS_A));

    await upsertTermComment(sid, "2026-2027-1", "本学期表现优秀", "manual");
    let comments = await listTermComments(sid);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      semester: "2026-2027-1",
      content: "本学期表现优秀",
      source: "manual",
    });

    // 同学期再写 → 覆盖不新增
    await upsertTermComment(sid, "2026-2027-1", "更新后的评语", "ai");
    comments = await listTermComments(sid);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ content: "更新后的评语", source: "ai" });

    // 另一学期 → 新增
    await upsertTermComment(sid, "2025-2026-2", "上一学期评语", "manual");
    comments = await listTermComments(sid);
    expect(comments).toHaveLength(2);
  });

  it("rejects empty semester and empty content", async () => {
    await createClass(CLASS_A);
    sid = await createStudent(studentInput("评语校验", "SEM_003", CLASS_A));
    await expect(upsertTermComment(sid, "", "内容", "manual")).rejects.toThrow("学期");
    await expect(upsertTermComment(sid, "2026-2027-1", "  ", "manual")).rejects.toThrow("评语");
  });
});
