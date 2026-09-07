import { describe, expect, it } from "vitest";
import {
  createExam,
  createStudent,
  deleteClass,
  deleteExam,
  deleteStudent,
  findExam,
  findOrCreateExam,
  getClassScoreOverview,
  getExam,
  getExamScores,
  listExamsByClass,
  listRecycleItems,
  listStudentExamScores,
  listStudents,
  purgeRecycleItem,
  updateExam,
  upsertExamScore,
} from "../src/lib/db";

const CLASS_NAME = "成绩测试班B";

async function makeStudent(name: string, studentNo: string): Promise<number> {
  return createStudent({
    name,
    gender: "男",
    birth_date: null,
    student_no: studentNo,
    grade_class: CLASS_NAME,
    id_card: null,
    address: null,
    status: "active",
    note: null,
    guardians: [],
  });
}

async function cleanup() {
  // 学生删除连带成绩；考试单独清；班级删除进回收站的需要彻底清
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME) await deleteStudent(s.id);
  }
  for (const e of await listExamsByClass(CLASS_NAME)) {
    await deleteExam(e.id);
  }
  for (const item of await listRecycleItems()) {
    if (item.label === CLASS_NAME) await purgeRecycleItem(item.id);
  }
}

describe("exam batches", () => {
  it("creates, finds and reuses exam batches by class+name+date", async () => {
    await cleanup();
    try {
      const id = await createExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-06-20" });
      expect(id).toBeGreaterThan(0);

      const found = await findExam(CLASS_NAME, "期中考试", "2026-06-20");
      expect(found?.id).toBe(id);
      expect(await findExam(CLASS_NAME, "期中考试", "2026-06-21")).toBeNull();

      const reused = await findOrCreateExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-06-20" });
      expect(reused.created).toBe(false);
      expect(reused.exam.id).toBe(id);

      const created = await findOrCreateExam({ class_name: CLASS_NAME, name: "期末考试", exam_date: "2026-07-01" });
      expect(created.created).toBe(true);

      await expect(createExam({ class_name: CLASS_NAME, name: "", exam_date: "2026-06-20" })).rejects.toThrow(
        "考试名称不能为空"
      );
      await expect(
        createExam({ class_name: CLASS_NAME, name: "坏日期", exam_date: "2026/06/20" })
      ).rejects.toThrow("考试时间格式应为 YYYY-MM-DD");

      const list = await listExamsByClass(CLASS_NAME);
      expect(list.map((e) => e.name)).toEqual(["期末考试", "期中考试"]); // 按时间倒序
    } finally {
      await cleanup();
    }
  });

  it("updates and deletes exam batches", async () => {
    await cleanup();
    try {
      const id = await createExam({ class_name: CLASS_NAME, name: "单元测验", exam_date: "2026-05-01" });
      await updateExam(id, { name: "第一单元测验", exam_date: "2026-05-02", note: "口算" });
      const exam = await getExam(id);
      expect(exam?.name).toBe("第一单元测验");
      expect(exam?.exam_date).toBe("2026-05-02");
      expect(exam?.note).toBe("口算");

      const sid = await makeStudent("赵小", "8801");
      await upsertExamScore(id, sid, "数学", 95, null);
      await deleteExam(id);
      expect(await getExam(id)).toBeNull();
      expect(await listStudentExamScores(sid)).toHaveLength(0); // 成绩随批次删除
    } finally {
      await cleanup();
    }
  });
});

describe("exam scores", () => {
  it("upserts scores per exam+student+subject and keeps the latest value", async () => {
    await cleanup();
    try {
      const examId = await createExam({ class_name: CLASS_NAME, name: "月考", exam_date: "2026-04-15" });
      const s1 = await makeStudent("钱小", "8802");
      const s2 = await makeStudent("孙小", "8803");

      await upsertExamScore(examId, s1, "语文", 91, null);
      await upsertExamScore(examId, s1, "语文", 93, null); // 覆盖更新
      await upsertExamScore(examId, s1, "数学", null, "缺考"); // 文字成绩
      await upsertExamScore(examId, s2, "语文", 88, null);

      const rows = await getExamScores(examId);
      expect(rows).toHaveLength(3);
      const shu = rows.find((r) => r.subject === "语文" && r.student_id === s1)!;
      expect(shu.score).toBe(93);
      expect(shu.student_name).toBe("钱小");
      const quekao = rows.find((r) => r.subject === "数学")!;
      expect(quekao.score).toBeNull();
      expect(quekao.grade).toBe("缺考");

      await expect(upsertExamScore(examId, s1, " ", 90, null)).rejects.toThrow("科目名不能为空");
      await expect(upsertExamScore(examId, s1, "英语", null, null)).rejects.toThrow(
        "成绩内容为空"
      );
    } finally {
      await cleanup();
    }
  });

  it("lists a student's scores across exams ordered by exam date desc", async () => {
    await cleanup();
    try {
      const e1 = await createExam({ class_name: CLASS_NAME, name: "第一次月考", exam_date: "2026-03-01" });
      const e2 = await createExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-05-10" });
      const sid = await makeStudent("周小", "8804");
      await upsertExamScore(e1, sid, "数学", 80, null);
      await upsertExamScore(e2, sid, "数学", 90, null);
      await upsertExamScore(e2, sid, "语文", 85, null);

      const scores = await listStudentExamScores(sid);
      expect(scores).toHaveLength(3);
      expect(scores[0].exam_name).toBe("期中考试"); // 最近考试在前
      expect(scores.filter((s) => s.exam_id === e2)).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it("builds the class overview matrix with per-exam totals", async () => {
    await cleanup();
    try {
      const e1 = await createExam({ class_name: CLASS_NAME, name: "期中", exam_date: "2026-05-10" });
      const e2 = await createExam({ class_name: CLASS_NAME, name: "期末", exam_date: "2026-07-01" });
      const s1 = await makeStudent("吴小", "8805");
      const s2 = await makeStudent("郑小", "8806");

      await upsertExamScore(e1, s1, "语文", 90, null);
      await upsertExamScore(e1, s1, "数学", 85, null);
      await upsertExamScore(e2, s1, "语文", 95, null);
      await upsertExamScore(e1, s2, "音乐", null, "优"); // 等级制

      const { exams, rows } = await getClassScoreOverview(CLASS_NAME);
      expect(exams.map((e) => e.name)).toEqual(["期末", "期中"]);
      expect(rows).toHaveLength(2);

      const wu = rows.find((r) => r.student_name === "吴小")!;
      expect(wu.cells[e1].score).toBe(175); // 两科总分
      expect(wu.cells[e2].score).toBe(95);

      const zheng = rows.find((r) => r.student_name === "郑小")!;
      expect(zheng.cells[e1].score).toBeNull();
      expect(zheng.cells[e1].grade).toBe("优");
      expect(zheng.cells[e2]).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("removes a student's scores when the student is deleted", async () => {
    await cleanup();
    try {
      const examId = await createExam({ class_name: CLASS_NAME, name: "临时考试", exam_date: "2026-06-01" });
      const sid = await makeStudent("王小", "8807");
      await upsertExamScore(examId, sid, "语文", 88, null);
      expect((await getExamScores(examId)).length).toBe(1);

      await deleteStudent(sid);
      expect(await getExamScores(examId)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("removes class exams and scores when the whole class is deleted", async () => {
    await cleanup();
    try {
      const examId = await createExam({ class_name: CLASS_NAME, name: "随班删除考试", exam_date: "2026-06-02" });
      const sid = await makeStudent("冯小", "8808");
      await upsertExamScore(examId, sid, "语文", 77, null);

      await deleteClass(CLASS_NAME);

      expect(await listExamsByClass(CLASS_NAME)).toHaveLength(0);
      expect(await getExamScores(examId)).toHaveLength(0);
      expect(await listStudentExamScores(sid)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
