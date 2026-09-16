import { describe, expect, it } from "vitest";
import { archiveClass, restoreClass } from "../src/lib/db";
import { searchGlobal, type GlobalSearchGroup, type SearchEntity } from "../src/lib/global-search";

/**
 * 全局搜索聚合层：vitest 下 isTauri() 为 false，自动走 db.ts 的内存演示数据，无需 mock。
 * 演示数据：三年级二班（林知远 / 苏晚）、一条班级合影、批考试与几条日程备忘。
 */
function group(groups: GlobalSearchGroup[], entity: SearchEntity) {
  return groups.find((g) => g.entity === entity);
}

describe("global search aggregation", () => {
  it("hits students by name and by student number with a jump route", async () => {
    const byName = await searchGlobal("林知远");
    expect(byName.map((g) => g.entity)).toEqual(["student"]);
    expect(byName[0]!.results[0]).toMatchObject({ title: "林知远", entity: "student" });
    expect(byName[0]!.results[0]!.subtitle).toContain("20230001");
    expect(byName[0]!.results[0]!.subtitle).toContain("三年级二班");
    expect(byName[0]!.results[0]!.route).toEqual({
      name: "student-detail",
      params: { id: String(byName[0]!.results[0]!.id) },
    });

    const byNo = await searchGlobal("20230002");
    expect(group(byNo, "student")?.results.map((r) => r.title)).toEqual(["苏晚"]);
  });

  it("marks archived classes in the subtitle without hiding them", async () => {
    const before = group(await searchGlobal("三年级一班"), "class")!.results[0]!;
    expect(before.title).toBe("三年级一班");
    expect(before.subtitle).not.toContain("已归档");

    await archiveClass("三年级一班");
    try {
      const archived = group(await searchGlobal("三年级一班"), "class")!.results[0]!;
      expect(archived.subtitle).toContain("已归档");
      expect(archived.route).toEqual({ name: "class-detail", params: { name: "三年级一班" } });
    } finally {
      await restoreClass("三年级一班");
    }
  });

  it("routes an exam result to its own class page", async () => {
    const exams = group(await searchGlobal("第一次月考"), "exam")!;
    expect(exams.results.length).toBeGreaterThan(1);

    const third = exams.results.find((r) => r.subtitle.startsWith("三年级二班"))!;
    expect(third.route).toEqual({ name: "class-detail", params: { name: "三年级二班" } });
    expect(third.subtitle).toContain("2026-09-26");
  });

  it("labels class photos and student photos differently", async () => {
    const classPhoto = group(await searchGlobal("开学集体合影"), "photo")!.results[0]!;
    expect(classPhoto.subtitle).toBe("班级照片 · 三年级二班");
    expect(classPhoto.route).toEqual({ name: "photos" });

    const studentPhoto = group(await searchGlobal("校园运动会"), "photo")!.results[0]!;
    expect(studentPhoto.subtitle).toMatch(/^学生照片 · .+/);
  });

  it("marks done memos and routes them home", async () => {
    const done = group(await searchGlobal("班委开会"), "memo")!.results[0]!;
    expect(done.subtitle).toContain("已完成");
    expect(done.route).toEqual({ name: "home" });

    const undone = group(await searchGlobal("大课间彩排"), "memo")!.results[0]!;
    expect(undone.subtitle).toContain("三年级二班");
    expect(undone.subtitle).not.toContain("已完成");
  });

  it("caps each group and keeps the fixed group order", async () => {
    const photos = group(await searchGlobal("校园运动会", 2), "photo")!;
    expect(photos.results).toHaveLength(2);

    // 关键词同时命中班级与照片时，顺序固定为 班级 → 照片
    const mixed = await searchGlobal("三年级二班");
    expect(mixed.map((g) => g.entity)).toEqual(["class", "photo"]);
  });

  it("returns nothing for a blank keyword", async () => {
    expect(await searchGlobal("   ")).toEqual([]);
  });
});