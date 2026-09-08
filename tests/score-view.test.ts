import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExamScorePanel from "../src/components/ExamScorePanel.vue";
import StudentScorePanel from "../src/components/StudentScorePanel.vue";
import ImportRosterDialog from "../src/components/ImportRosterDialog.vue";
import {
  createExam,
  createStudent,
  deleteExam,
  deleteStudent,
  listExamsByClass,
  listStudents,
  upsertExamScore,
} from "../src/lib/db";

const CLASS_NAME = "成绩测试班C";
const SCORE_SHEET =
  "三年级二班2026年秋季期中考试成绩单\n姓名,学号,语文,数学,英语,总分\n林一,9701,95,88,92,275\n王二,9702,85,90.5,78,253.5";

async function seed(): Promise<{ examId: number; studentIds: number[] }> {
  const examId = await createExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-06-20" });
  const studentIds: number[] = [];
  const names = [
    ["林一", "9701"],
    ["王二", "9702"],
  ] as const;
  for (const [name, no] of names) {
    const id = await createStudent({
      name,
      gender: "男",
      birth_date: null,
      student_no: no,
      grade_class: CLASS_NAME,
      id_card: null,
      address: null,
      status: "active",
      note: null,
      guardians: [],
    });
    studentIds.push(id);
  }
  await upsertExamScore(examId, studentIds[0], "语文", 95, null);
  await upsertExamScore(examId, studentIds[0], "数学", 88, null);
  await upsertExamScore(examId, studentIds[1], "语文", 85, null);
  await upsertExamScore(examId, studentIds[1], "数学", 90.5, null);
  return { examId, studentIds };
}

async function cleanup() {
  for (const e of await listExamsByClass(CLASS_NAME)) {
    await deleteExam(e.id);
  }
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME) await deleteStudent(s.id);
  }
}

describe("ExamScorePanel", () => {
  it("renders exam chips with the detail matrix (students × subjects + totals)", async () => {
    await cleanup();
    try {
      const { examId } = await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      // 批次胶囊
      const chip = wrapper.find(`[data-test='exam-chip-${examId}']`);
      expect(chip.exists()).toBe(true);
      expect(chip.text()).toContain("期中考试");
      expect(chip.text()).toContain("2026-06-20");

      // 明细表：学生 × 科目 + 总分
      const table = wrapper.get("[data-test='exam-detail-table']");
      const text = table.text();
      expect(text).toContain("语文");
      expect(text).toContain("数学");
      expect(text).toContain("林一");
      expect(text).toContain("95");
      expect(text).toContain("90.5");
      expect(text).toContain("183"); // 林一总分 95+88

      // 编辑/删除入口存在
      expect(wrapper.find("[data-test='edit-exam-btn']").exists()).toBe(true);
      expect(wrapper.find("[data-test='delete-exam-btn']").exists()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("switches to the student-overview matrix (each student × each exam total)", async () => {
    await cleanup();
    try {
      await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      await wrapper.get("[data-test='view-overview-btn']").trigger("click");
      await flushPromises();

      const table = wrapper.get("[data-test='score-overview-table']");
      const text = table.text();
      expect(text).toContain("林一");
      expect(text).toContain("175"); // 95 + 88 (语文 + 数学)
      expect(text).toContain("175.5"); // 85 + 90.5
      // 未参加第二个批次显示占位（此班只有一场考试，检查占位符渲染逻辑不报错即可）
    } finally {
      await cleanup();
    }
  });

  it("shows the empty state before any scores are imported", async () => {
    await cleanup();
    const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
    await flushPromises();
    expect(wrapper.text()).toContain("暂无考试成绩");
    expect(wrapper.find("[data-test='import-score-btn']").exists()).toBe(true);
    await cleanup();
  });

  it("「导入成绩」紧挨视角切换右侧：与「按学生总览」同组且是相邻兄弟", async () => {
    await cleanup();
    const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
    await flushPromises();

    const actions = wrapper.get("[data-test='score-toolbar-actions']");
    const order = Array.from(actions.element.querySelectorAll("[data-test]")).map((el) =>
      el.getAttribute("data-test"),
    );
    expect(order).toEqual(["view-exams-btn", "view-overview-btn", "import-score-btn"]);

    // 图标紧跟 segmented 控件（相邻兄弟节点），不是行首也不被推到行尾
    const kids = Array.from(actions.element.children);
    const toggleIdx = kids.findIndex((el) => el.querySelector("[data-test='view-overview-btn']"));
    const importIdx = kids.findIndex((el) => el.getAttribute("data-test") === "import-score-btn");
    expect(toggleIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBe(toggleIdx + 1);
    await cleanup();
  });
});

describe("StudentScorePanel", () => {
  it("groups a student's scores by exam with totals, latest exam first", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const secondExam = await createExam({ class_name: CLASS_NAME, name: "期末考试", exam_date: "2026-07-10" });
      await upsertExamScore(secondExam, studentIds[0], "语文", 97, null);

      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds[0] } });
      await flushPromises();

      const text = wrapper.text();
      // 期末（最近）在前
      expect(text.indexOf("期末考试")).toBeLessThan(text.indexOf("期中考试"));
      expect(text).toContain("2026-07-10");
      expect(text).toContain("语文 97");

      const totals = wrapper.findAll("[data-test='score-total']");
      expect(totals.map((t) => t.text())).toEqual(["97", "183"]); // 单科 97；期中 95+88
    } finally {
      await cleanup();
    }
  });

  it("explains where scores come from when there are none yet", async () => {
    await cleanup();
    const students = (await listStudents()).filter((s) => s.grade_class === CLASS_NAME);
    expect(students).toHaveLength(0);
    const wrapper = mount(StudentScorePanel, { props: { studentId: 1 } });
    await flushPromises();
    expect(wrapper.text()).toContain("还没有成绩记录");
  });
});

describe("ImportRosterDialog score-sheet banner", () => {
  type Loader = { loadText: (text: string, label?: string) => Promise<void> };

  it("detects a score sheet from the roster entry and offers to switch", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText(SCORE_SHEET, "期中成绩单.csv");

    const banner = wrapper.find("[data-test='score-sheet-banner']");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("成绩单");
    expect(banner.text()).toContain("语文、数学、英语");

    // 转为成绩导入：携带已解析表格与文件名交给父视图
    await wrapper.get("[data-test='switch-to-scores-btn']").trigger("click");
    const emitted = wrapper.emitted("switch-to-scores");
    expect(emitted).toHaveLength(1);
    const payload = emitted![0][0] as { table: { headers: string[] }; fileName: string };
    expect(payload.fileName).toBe("期中成绩单.csv");
    expect(payload.table.headers).toContain("语文");
  });

  it("can be dismissed to keep importing as a roster", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText(SCORE_SHEET, "期中成绩单.csv");
    expect(wrapper.find("[data-test='score-sheet-banner']").exists()).toBe(true);

    await wrapper.findAll("button").find((b) => b.text().includes("仍按花名册导入"))!.trigger("click");
    expect(wrapper.find("[data-test='score-sheet-banner']").exists()).toBe(false);
  });

  it("does not show the banner for real rosters", async () => {
    const wrapper = mount(ImportRosterDialog, { props: { open: true } });
    await (wrapper.vm as unknown as Loader).loadText("姓名,性别,学号\n张小三,男,9601");
    expect(wrapper.find("[data-test='score-sheet-banner']").exists()).toBe(false);
  });
});
