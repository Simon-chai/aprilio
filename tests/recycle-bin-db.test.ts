import { describe, expect, it } from "vitest";
import {
  addBehaviorRecord,
  addClassPhoto,
  addPhoto,
  createClass,
  createStudent,
  deleteClass,
  deleteStudent,
  getStudent,
  listBehaviorDimensions,
  listBehaviorRecords,
  listClasses,
  listPhotos,
  listRecycleItems,
  listStudents,
  purgeRecycleItem,
  recycleRemainingDays,
  restoreRecycleItem,
} from "../src/lib/db";
import type { StudentInput } from "../src/types";

function buildInput(overrides: Partial<StudentInput> = {}): StudentInput {
  return {
    name: "回收站测试生",
    gender: "男",
    birth_date: "2017-06-01",
    student_no: `RC_${Math.random().toString(36).slice(2, 10)}`,
    grade_class: "回收站独立班",
    id_card: null,
    address: null,
    status: "active",
    note: null,
    guardians: [
      { name: "回收家长", phone: "13800000999", relation: "父亲", is_primary: true, occupation: "教师", tags: ["温和"] },
    ],
    ...overrides,
  };
}

describe("db 回收站（学生/班级软删除 · 恢复 · 彻底删除）", () => {
  it("删除学生进回收站，恢复后档案/监护人/照片/表现流水完整回来", async () => {
    const id = await createStudent(
      buildInput({ name: "轮回收生", student_no: "RC_STU_001" })
    );
    await addPhoto(id, "recycle-stu-1.jpg", "测试照片", "2026-09-01");
    const dims = await listBehaviorDimensions();
    await addBehaviorRecord({
      student_id: id,
      dimension_id: dims[0].id,
      dimension_name_snap: dims[0].name,
      category_snap: dims[0].category,
      type: "praise",
      comment: "表现不错",
      recorded_date: "2026-09-01",
    });

    await deleteStudent(id);
    expect(await getStudent(id)).toBeNull();

    const item = (await listRecycleItems()).find(
      (i) => i.entity_type === "student" && i.label === "轮回收生"
    );
    expect(item).toBeDefined();
    expect(item!.summary).toContain("学号 RC_STU_001");
    // 刚删除的条目剩余天数应 ≤ 保留期 7 天
    expect(recycleRemainingDays(item!)).toBeLessThanOrEqual(7);

    await restoreRecycleItem(item!.id);
    const restored = (await listStudents("RC_STU_001"))[0];
    expect(restored).toBeDefined();

    const full = await getStudent(restored.id);
    expect(full?.guardians.length).toBe(1);
    expect(full?.guardians[0].occupation).toBe("教师");
    expect(full?.guardians[0].tags).toEqual(["温和"]);
    expect((await listPhotos(restored.id)).map((p) => p.file_name)).toEqual(["recycle-stu-1.jpg"]);
    expect((await listBehaviorRecords(restored.id)).map((b) => b.comment)).toEqual(["表现不错"]);

    // 恢复后该条目从回收站消失
    const after = await listRecycleItems();
    expect(after.find((i) => i.id === item!.id)).toBeUndefined();
  });

  it("删除班级整班进回收站，恢复后班级/学生/公共照片一并还原", async () => {
    const className = "回收站测试班";
    await createClass(className);
    const s1 = await createStudent(
      buildInput({ name: "班级生A", student_no: "RC_CLS_001", grade_class: className })
    );
    const s2 = await createStudent(
      buildInput({ name: "班级生B", student_no: "RC_CLS_002", grade_class: className })
    );
    await addPhoto(s1, "recycle-member-1.jpg", "个人照", "2026-09-01");
    await addClassPhoto(className, "recycle-class-1.jpg", "班级合影", "2026-09-01");

    await deleteClass(className);
    expect((await listClasses()).find((c) => c.name === className)).toBeUndefined();
    expect(await getStudent(s1)).toBeNull();
    expect(await getStudent(s2)).toBeNull();

    const item = (await listRecycleItems()).find(
      (i) => i.entity_type === "class" && i.label === className
    );
    expect(item).toBeDefined();
    expect(item!.summary).toContain("2 名学生");
    expect(item!.summary).toContain("照片 2 张");

    await restoreRecycleItem(item!.id);
    const back = (await listClasses()).find((c) => c.name === className);
    expect(back).toBeDefined();
    expect(back!.studentCount).toBe(2);

    const photos = await listPhotos();
    expect(photos.some((p) => p.file_name === "recycle-class-1.jpg" && p.student_id === null)).toBe(true);
    const restoredA = (await listStudents("RC_CLS_001"))[0];
    expect((await listPhotos(restoredA.id)).map((p) => p.file_name)).toEqual(["recycle-member-1.jpg"]);
  });

  it("「未分班」视同普通班级：整班（含 grade_class 为空的学生）进回收站", async () => {
    const s = await createStudent(
      buildInput({ name: "未分班删除生", student_no: "RC_UNASSIGNED_001", grade_class: "" })
    );
    await deleteClass("未分班");

    expect(await getStudent(s)).toBeNull();
    const item = (await listRecycleItems()).find(
      (i) => i.entity_type === "class" && i.label === "未分班"
    );
    expect(item).toBeDefined();
    expect(item!.summary).toContain("1 名学生");
  });

  it("彻底删除单条后条目不再出现", async () => {
    const id = await createStudent(buildInput({ name: "待清空生", student_no: "RC_PURGE_001" }));
    await deleteStudent(id);
    const item = (await listRecycleItems()).find((i) => i.label === "待清空生");
    expect(item).toBeDefined();

    await purgeRecycleItem(item!.id);
    expect((await listRecycleItems()).find((i) => i.id === item!.id)).toBeUndefined();
  });

  it("新删除的条目不会被过期清理误删", async () => {
    const id = await createStudent(buildInput({ name: "新删生", student_no: "RC_FRESH_001" }));
    await deleteStudent(id);
    const items = await listRecycleItems();
    expect(items.some((i) => i.label === "新删生")).toBe(true);
  });

  it("recycleRemainingDays 按过期时间计算剩余天数", () => {
    const fmt = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const day = 24 * 60 * 60 * 1000;
    expect(recycleRemainingDays({ expire_at: fmt(new Date(Date.now() + 3 * day + 3600_000)) })).toBe(4);
    expect(recycleRemainingDays({ expire_at: fmt(new Date(Date.now() - day)) })).toBe(0);
  });
});
