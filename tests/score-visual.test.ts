import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExamScorePanel from "../src/components/ExamScorePanel.vue";
import StudentScorePanel from "../src/components/StudentScorePanel.vue";
import {
  createExam,
  createStudent,
  deleteExam,
  deleteStudent,
  listExamsByClass,
  listStudents,
  upsertExamScore,
} from "../src/lib/db";

const CLASS_NAME = "成绩可视化测试班V";

interface SeedResult {
  midterm: number;
  final: number;
  studentIds: Record<string, number>;
}

async function seed(): Promise<SeedResult> {
  const midterm = await createExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-06-20" });
  const final = await createExam({ class_name: CLASS_NAME, name: "期末考试", exam_date: "2026-07-10" });
  const studentIds: Record<string, number> = {};
  for (const [name, no] of [
    ["学生甲", "8801"],
    ["学生乙", "8802"],
    ["学生丙", "8803"],
  ] as const) {
    studentIds[name] = await createStudent({
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
  }
  // 期中：甲 170 / 乙 130 / 丙 200
  await upsertExamScore(midterm, studentIds["学生甲"], "语文", 90, null);
  await upsertExamScore(midterm, studentIds["学生甲"], "数学", 80, null);
  await upsertExamScore(midterm, studentIds["学生乙"], "语文", 70, null);
  await upsertExamScore(midterm, studentIds["学生乙"], "数学", 60, null);
  await upsertExamScore(midterm, studentIds["学生丙"], "语文", 100, null);
  await upsertExamScore(midterm, studentIds["学生丙"], "数学", 100, null);
  // 期末：甲 180 / 乙 140 / 丙 193
  await upsertExamScore(final, studentIds["学生甲"], "语文", 95, null);
  await upsertExamScore(final, studentIds["学生甲"], "数学", 85, null);
  await upsertExamScore(final, studentIds["学生乙"], "语文", 75, null);
  await upsertExamScore(final, studentIds["学生乙"], "数学", 65, null);
  await upsertExamScore(final, studentIds["学生丙"], "语文", 98, null);
  await upsertExamScore(final, studentIds["学生丙"], "数学", 95, null);
  return { midterm, final, studentIds };
}

async function cleanup() {
  for (const e of await listExamsByClass(CLASS_NAME)) await deleteExam(e.id);
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME) await deleteStudent(s.id);
  }
}

describe("班级成绩可视化", () => {
  it("展示班级统计卡、科目统计与总分排名", async () => {
    await cleanup();
    try {
      const { midterm } = await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      // 默认选中第一场（考试时间倒序 → 期末在前），切到期中核对统计
      const chip = wrapper.find(`[data-test='exam-chip-${midterm}']`);
      expect(chip.exists()).toBe(true);
      await chip.trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-test='exam-stat-strip']").exists()).toBe(true);
      // 平均总分 (170+130+200)/3 = 166.7
      expect(wrapper.get("[data-test='stat-average']").text()).toBe("166.7");
      expect(wrapper.get("[data-test='exam-stat-strip']").text()).toContain("200"); // 最高分
      expect(wrapper.get("[data-test='exam-stat-strip']").text()).toContain("130"); // 最低分

      const subjectTable = wrapper.get("[data-test='subject-stat-table']");
      expect(subjectTable.text()).toContain("语文");
      expect(subjectTable.text()).toContain("86.7"); // (90+70+100)/3

      // 明细表带排名列：丙 200 分居首
      const detail = wrapper.get("[data-test='exam-detail-table']");
      const rows = detail.findAll("tbody tr");
      const firstCells = rows.map((r) => r.findAll("td").map((c) => c.text()));
      expect(firstCells[0][0]).toBe("1");
      expect(firstCells[0][1]).toContain("学生丙");
    } finally {
      await cleanup();
    }
  });

  it("按学生总览带班级平均行", async () => {
    await cleanup();
    try {
      await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();
      await wrapper.get("[data-test='view-overview-btn']").trigger("click");
      await flushPromises();

      const table = wrapper.get("[data-test='score-overview-table']");
      expect(table.text()).toContain("班级平均");
      // 期中平均 166.7 / 期末平均 (180+140+193)/3 = 171
      expect(table.text()).toContain("166.7");
      expect(table.text()).toContain("171");
    } finally {
      await cleanup();
    }
  });

  it("成绩趋势：多次考试同时存在时展示班级均分走势与各科趋势", async () => {
    await cleanup();
    try {
      await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();
      await wrapper.get("[data-test='view-trend-btn']").trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-test='class-trend']").exists()).toBe(true);
      const chart = wrapper.get("[data-test='class-trend-chart']");
      expect(chart.text()).toContain("期中考试");
      expect(chart.text()).toContain("期末考试");

      // 平均单科分：期中 (86.7+80)/2=83.4；期末 (89.3+81.7)/2=85.5
      const trendTable = wrapper.get("[data-test='exam-trend-table']");
      expect(trendTable.text()).toContain("83.4");
      expect(trendTable.text()).toContain("85.5");

      // 各科平均分趋势矩阵
      const subjectTrend = wrapper.get("[data-test='subject-trend-table']");
      expect(subjectTrend.text()).toContain("语文");
      expect(subjectTrend.text()).toContain("数学");
      expect(subjectTrend.text()).toContain("86.7"); // 期中语文班均
      expect(subjectTrend.text()).toContain("89.3"); // 期末语文班均
    } finally {
      await cleanup();
    }
  });
});

describe("个人成绩可视化", () => {
  it("展示概览、班级排名、总分趋势与班均对比", async () => {
    await cleanup();
    try {
      const { final, studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      expect(wrapper.find("[data-test='student-score-summary']").exists()).toBe(true);
      // 默认不铺开单次考试详情
      expect(wrapper.findAll("[data-test='exam-card']")).toHaveLength(0);

      // 点击折线图上「期末考试」那一列 → 展开该次详情
      await wrapper.find(`[data-test='chart-band'][data-exam-id='${final}']`).trigger("click");
      await flushPromises();

      const totals = wrapper.findAll("[data-test='score-total']");
      expect(totals.map((t) => t.text())).toEqual(["180"]);

      // 较上次进步 +10
      expect(wrapper.get("[data-test='score-delta']").text()).toContain("10");
      // 期末班级第 2 名（丙 193 > 甲 180 > 乙 140）
      expect(wrapper.text()).toContain("班级第 2");
      // 单科与班均对比（期末语文班均 (95+75+98)/3 = 89.3）
      expect(wrapper.text()).toContain("语文 95");
      expect(wrapper.text()).toContain("班均 89.3");
    } finally {
      await cleanup();
    }
  });

  it("多次考试时展示走势图区块", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      expect(wrapper.find("[data-test='multi-exam-section']").exists()).toBe(true);
      expect(wrapper.find("[data-test='student-trend-chart']").exists()).toBe(true);
      // 矩阵已移除，由折线图承担多次考试对比
      expect(wrapper.find("[data-test='multi-exam-matrix']").exists()).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("科目成绩折线图：按大考/小考分组，每个科目一条折线，横轴按时间排序", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      // 期中 / 期末都判为大考 → 只有「大考」一张图，没有「小考」图
      expect(wrapper.find("[data-test='line-chart-major']").exists()).toBe(true);
      expect(wrapper.find("[data-test='line-chart-minor']").exists()).toBe(false);

      const chart = wrapper.get("[data-test='score-line-chart']");
      // 语文、数学各一条折线
      expect(chart.findAll("polyline")).toHaveLength(2);
      expect(chart.text()).toContain("语文");
      expect(chart.text()).toContain("数学");

      // 横轴按考试时间正序：期中在前、期末在后
      const text = chart.text();
      expect(text.indexOf("期中考试")).toBeLessThan(text.indexOf("期末考试"));

      // 数据点：学生甲 2 科 × 2 场 = 4 个
      expect(chart.findAll("[data-test='chart-point']")).toHaveLength(4);

      // 命中按「列」划分：一次考试一个热区，节点再密也能选中
      const bands = chart.findAll("[data-test='chart-band']");
      expect(bands).toHaveLength(2);

      // 悬浮期末那一列 → 提示考试名与分数（无真实坐标时取该列首个科目的点）
      await bands[bands.length - 1].trigger("mouseenter");
      const tip = wrapper.get("[data-test='chart-tooltip']");
      expect(tip.text()).toContain("期末考试");
      expect(tip.text()).toContain("语文：95 分");

      // 纵轴按数据收紧（学生甲 80~95 → 75~100），不再固定 0~100
      const domainText = chart.get("[data-test='chart-domain']").text();
      expect(domainText).toBe("纵轴 75~100");
    } finally {
      await cleanup();
    }
  });

  it("走势图按大考/小考分 Tab 切换；点击节点后详情展示在走势图下方", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const quiz = await createExam({
        class_name: CLASS_NAME,
        name: "第一单元测验",
        exam_date: "2026-06-05",
      });
      await upsertExamScore(quiz, studentIds["学生甲"], "语文", 82, null);
      await upsertExamScore(quiz, studentIds["学生甲"], "数学", 76, null);

      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      // 两个 Tab：大考 / 小考（不再并排堆在一栏）
      const tabs = wrapper.get("[data-test='chart-tabs']");
      expect(tabs.findAll("[data-test^='chart-tab-']")).toHaveLength(2);

      // 默认「大考」：只含期中 / 期末
      const majorChart = wrapper.get("[data-test='line-chart-major']");
      expect(majorChart.text()).toContain("期中考试");
      expect(majorChart.text()).toContain("期末考试");
      expect(majorChart.text()).not.toContain("第一单元测验");

      // 切到「小考」：只含单元测验，大考图不再渲染
      await wrapper.get("[data-test='chart-tab-minor']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='line-chart-major']").exists()).toBe(false);
      const minorChart = wrapper.get("[data-test='line-chart-minor']");
      expect(minorChart.text()).toContain("第一单元测验");
      expect(minorChart.text()).not.toContain("期中考试");

      // 点击小考节点 → 详情卡片出现在同一张走势图下方
      await minorChart.find(`[data-test='chart-band'][data-exam-id='${quiz}']`).trigger("click");
      await flushPromises();
      const card = minorChart.get("[data-test='exam-card']");
      expect(card.text()).toContain("第一单元测验");
      expect(card.text()).toContain("小考");
      expect(card.text()).toContain("语文 82");
    } finally {
      await cleanup();
    }
  });
});
