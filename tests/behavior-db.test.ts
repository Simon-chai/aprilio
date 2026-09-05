import { describe, expect, it } from "vitest";
import {
  addBehaviorRecord,
  createBehaviorDimension,
  deleteStudent,
  listBehaviorDimensions,
  listBehaviorRecords,
  listBehaviorRecordsByClass,
  listCommentPresets,
} from "../src/lib/db";
import { localDateStr } from "../src/lib/format";
import type { BehaviorDimension, BehaviorInput, BehaviorPolarity } from "../src/types";

async function dimByCode(code: string): Promise<BehaviorDimension> {
  const dims = await listBehaviorDimensions();
  const dim = dims.find((d) => d.code === code);
  if (!dim) throw new Error(`缺少维度 ${code}`);
  return dim;
}

function buildInput(over: Partial<BehaviorInput> & { dimension_id: number }): BehaviorInput {
  return {
    student_id: 1,
    dimension_name_snap: "测试维度",
    category_snap: "study",
    type: "praise",
    comment: "测试评语",
    recorded_date: localDateStr(),
    ...over,
  };
}

describe("behavior dimensions dictionary", () => {
  it("seeds 4 system dimensions ordered by sort_order", async () => {
    const dims = await listBehaviorDimensions();
    expect(dims.map((d) => d.code)).toEqual(["homework", "exam", "classroom", "labor"]);
    expect(dims.every((d) => d.is_system === 1 && d.is_active === 1)).toBe(true);
    expect(dims.map((d) => d.category)).toEqual(["study", "study", "behavior", "behavior"]);
  });

  it("creates a custom dimension appended last; rejects blank names", async () => {
    const dim = await createBehaviorDimension("体育健康");
    expect(dim.name).toBe("体育健康");
    expect(dim.category).toBe("other");
    expect(dim.is_system).toBe(0);

    const dims = await listBehaviorDimensions();
    expect(dims[dims.length - 1].name).toBe("体育健康");
    await expect(createBehaviorDimension("   ")).rejects.toThrow("维度名称不能为空");
  });
});

describe("behavior records + comment preset self-learning loop", () => {
  it("inserts a record with dimension snapshot and seeds preset as history", async () => {
    const classroom = await dimByCode("classroom");
    const today = localDateStr();
    const id = await addBehaviorRecord(
      buildInput({
        student_id: 3,
        dimension_id: classroom.id,
        dimension_name_snap: classroom.name,
        category_snap: classroom.category,
        comment: "数学课上主动上台讲解错题",
      })
    );
    expect(id).toBeGreaterThan(0);

    const records = await listBehaviorRecords(3);
    const rec = records.find((r) => r.id === id);
    expect(rec).toBeTruthy();
    expect(rec?.dimension_name_snap).toBe("课堂表现");
    expect(rec?.category_snap).toBe("behavior");
    expect(rec?.type).toBe("praise");
    expect(rec?.recorded_date).toBe(today);

    const presets = await listCommentPresets(classroom.id, "praise");
    const mine = presets.find((p) => p.content === "数学课上主动上台讲解错题");
    expect(mine?.source).toBe("history");
    expect(mine?.use_count).toBe(1);
  });

  it("increments use_count and lifts repeated comments to the top", async () => {
    const classroom = await dimByCode("classroom");
    const input = buildInput({
      student_id: 4,
      dimension_id: classroom.id,
      dimension_name_snap: classroom.name,
      category_snap: classroom.category,
      comment: "积极举手发言",
    });
    await addBehaviorRecord(input);
    await addBehaviorRecord(input);

    const presets = await listCommentPresets(classroom.id, "praise");
    expect(presets[0].content).toBe("积极举手发言");
    expect(presets[0].use_count).toBe(2);
  });

  it("exposes per-dimension seeded presets (exam + improve)", async () => {
    const exam = await dimByCode("exam");
    const presets = await listCommentPresets(exam.id, "improve");
    const texts = presets.map((p) => p.content).join();
    expect(texts).toContain("基础计算失误较多");
    expect(texts).toContain("重点知识点有脱节");
    expect(presets.every((p) => p.source === "system")).toBe(true);
  });

  it("accepts the neutral polarity and stores it like the others", async () => {
    const classroom = await dimByCode("classroom");
    const presetsBefore = (await listCommentPresets(classroom.id, "neutral")).length;
    const id = await addBehaviorRecord(
      buildInput({
        student_id: 6,
        dimension_id: classroom.id,
        dimension_name_snap: classroom.name,
        category_snap: classroom.category,
        type: "neutral",
        comment: "课堂表现平稳",
      })
    );
    expect(id).toBeGreaterThan(0);
    const rec = (await listBehaviorRecords(6)).find((r) => r.id === id);
    expect(rec?.type).toBe("neutral");

    const presets = await listCommentPresets(classroom.id, "neutral");
    expect(presets.find((p) => p.content === "课堂表现平稳")?.source).toBe("history");
    // 至少有一条系统预置中立评语（seed）
    expect(presets.length).toBeGreaterThanOrEqual(presetsBefore + 1);
  });

  it("rejects future dates, blank comments and bad polarity", async () => {
    const homework = await dimByCode("homework");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await expect(
      addBehaviorRecord(
        buildInput({ dimension_id: homework.id, recorded_date: localDateStr(tomorrow) })
      )
    ).rejects.toThrow("不能录入未来日期");
    await expect(
      addBehaviorRecord(buildInput({ dimension_id: homework.id, comment: "   " }))
    ).rejects.toThrow("评语内容不能为空");
    await expect(
      addBehaviorRecord(
        buildInput({ dimension_id: homework.id, type: "great" as BehaviorPolarity })
      )
    ).rejects.toThrow("评价倾向不合法");
  });

  it("removes behavior records when the student is deleted (cascade)", async () => {
    const labor = await dimByCode("labor");
    await addBehaviorRecord(
      buildInput({
        student_id: 5,
        dimension_id: labor.id,
        dimension_name_snap: labor.name,
        category_snap: labor.category,
        type: "improve",
        comment: "值日未完成提前离开",
      })
    );
    expect((await listBehaviorRecords(5)).length).toBeGreaterThan(0);

    await deleteStudent(5);
    expect(await listBehaviorRecords(5)).toEqual([]);
  });

  it("listBehaviorRecordsByClass returns records for students in target class and attaches student snapshot", async () => {
    const homework = await dimByCode("homework");
    const classroom = await dimByCode("classroom");

    // 为三年级二班学生 1 (林知远) 写入一条记录
    await addBehaviorRecord(
      buildInput({
        student_id: 1,
        dimension_id: homework.id,
        dimension_name_snap: homework.name,
        category_snap: homework.category,
        type: "praise",
        comment: "作业书写极其工整",
      })
    );

    // 为四年级一班学生 3 (陈嘉树) 写入一条记录
    await addBehaviorRecord(
      buildInput({
        student_id: 3,
        dimension_id: classroom.id,
        dimension_name_snap: classroom.name,
        category_snap: classroom.category,
        type: "praise",
        comment: "四年级发言积极",
      })
    );

    const classRecords = await listBehaviorRecordsByClass("三年级二班");
    expect(classRecords.length).toBeGreaterThan(0);
    for (const r of classRecords) {
      expect(["林知远", "苏晚"]).toContain(r.student_name);
      expect(r.student_name).toBeTruthy();
    }
    // 跨班级学生陈嘉树不应该出现在三年级二班
    expect(classRecords.some((r) => r.student_name === "陈嘉树")).toBe(false);
  });
});
