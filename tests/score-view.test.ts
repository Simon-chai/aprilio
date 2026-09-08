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
import { resetScoreLevelConfig } from "../src/lib/score-config";

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

  it("考试按大考/小考分组，默认只展开选中考试所在组", async () => {
    await cleanup();
    try {
      await seed(); // 期中考试 → 大考
      const minorExam = await createExam({
        class_name: CLASS_NAME,
        name: "第一单元测验",
        exam_date: "2026-06-10",
      });
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      expect(wrapper.find("[data-test='exam-group-major']").exists()).toBe(true);
      expect(wrapper.find("[data-test='exam-group-minor']").exists()).toBe(true);

      // 列表按时间倒序：期中(06-20) 在前 → 选中大考组，小考组默认折叠
      expect(wrapper.find(`[data-test='exam-chip-${minorExam}']`).exists()).toBe(false);

      await wrapper.get("[data-test='exam-group-minor']").trigger("click");
      await flushPromises();
      expect(wrapper.find(`[data-test='exam-chip-${minorExam}']`).exists()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("等级映射配置：改阈值后总分等级标签随之变化", async () => {
    await cleanup();
    try {
      await seed(); // 林一 95+88=183 → 平均 91.5 → 默认「优秀」
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();
      expect(wrapper.findAll("[data-test='total-level']").map((t) => t.text())).toContain("优秀");

      await wrapper.get("[data-test='level-config-btn']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='level-config-dialog']").exists()).toBe(true);

      await wrapper.get("[data-test='level-min-excellent']").setValue(95);
      await wrapper.get("[data-test='save-level-btn']").trigger("click");
      await flushPromises();

      // 91.5 < 95 → 不再判为「优秀」
      expect(wrapper.findAll("[data-test='total-level']").map((t) => t.text())).not.toContain("优秀");
    } finally {
      resetScoreLevelConfig();
      await cleanup();
    }
  });

  it("改分纠错：点击分数可修改，也可清空该科成绩", async () => {
    await cleanup();
    try {
      await seed(); // 林一 语文95 数学88
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      const openCell = async (text: string) => {
        const cell = wrapper
          .findAll("[data-test='edit-score-cell']")
          .find((c) => c.text() === text);
        expect(cell, `应能找到分数为 ${text} 的单元格`).toBeTruthy();
        await cell!.trigger("click");
        await flushPromises();
      };

      // 修改：林一语文 95 → 91
      await openCell("95");
      expect(wrapper.find("[data-test='correct-score-dialog']").exists()).toBe(true);
      await wrapper.get("[data-test='correct-score-input']").setValue("91");
      await wrapper.get("[data-test='save-correct-btn']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='correct-score-dialog']").exists()).toBe(false);
      expect(wrapper.findAll("[data-test='edit-score-cell']").map((c) => c.text())).toContain("91");
      // 总分随之更新：91 + 88 = 179
      expect(wrapper.get("[data-test='exam-detail-table']").text()).toContain("179");

      // 清空：林一数学 88 → 占位符
      await openCell("88");
      await wrapper.get("[data-test='clear-score-btn']").trigger("click");
      await flushPromises();
      expect(wrapper.findAll("[data-test='edit-score-cell']").map((c) => c.text())).toContain("—");
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
    expect(order).toEqual([
      "view-exams-btn",
      "view-overview-btn",
      "view-trend-btn",
      "import-score-btn",
      "level-config-btn",
    ]);

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
  it("默认不铺开单次考试，悬浮节点看信息、点击节点展开该次详情", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const secondExam = await createExam({ class_name: CLASS_NAME, name: "期末考试", exam_date: "2026-07-10" });
      await upsertExamScore(secondExam, studentIds[0], "语文", 97, null);

      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds[0] } });
      await flushPromises();

      // 默认只提示，不铺开任何单次考试详情
      expect(wrapper.find("[data-test='exam-detail-hint']").exists()).toBe(true);
      expect(wrapper.findAll("[data-test='exam-card']")).toHaveLength(0);

      // 悬浮热区（整列）：提示这是哪次考试、该科多少分
      const point = wrapper.find(`[data-test='chart-band'][data-exam-id='${secondExam}']`);
      expect(point.exists()).toBe(true);
      await point.trigger("mouseenter");
      const tip = wrapper.get("[data-test='chart-tooltip']");
      expect(tip.text()).toContain("期末考试");
      expect(tip.text()).toContain("语文：97 分");

      // 点击节点 → 展开该次考试详情（沿用原有卡片样式）
      await point.trigger("click");
      await flushPromises();
      const cards = wrapper.findAll("[data-test='exam-card']");
      expect(cards).toHaveLength(1);
      expect(cards[0].text()).toContain("期末考试");
      expect(cards[0].text()).toContain("语文 97");
      expect(wrapper.get("[data-test='score-total']").text()).toBe("97");

      // 再点一次收起
      await point.trigger("click");
      await flushPromises();
      expect(wrapper.findAll("[data-test='exam-card']")).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it("explains where scores come from when there are none yet", async () => {
    await cleanup();
    const students = (await listStudents()).filter((s) => s.grade_class === CLASS_NAME);
    expect(students).toHaveLength(0);

    // 新建一名本班学生（该班没有考试）→ 个人成绩面板应显示空状态
    const id = await createStudent({
      name: "无成绩学生",
      gender: "女",
      birth_date: null,
      student_no: "NOSCORE01",
      grade_class: CLASS_NAME,
      id_card: null,
      address: null,
      status: "active",
      note: null,
      guardians: [],
    });
    const wrapper = mount(StudentScorePanel, { props: { studentId: id } });
    await flushPromises();
    expect(wrapper.text()).toContain("还没有成绩记录");
    await cleanup();
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
