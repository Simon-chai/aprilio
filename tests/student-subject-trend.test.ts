import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
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

const CLASS_NAME = "单科趋势测试班";

interface SeedResult {
  quiz: number;
  midterm: number;
  final: number;
  studentIds: Record<string, number>;
}

/**
 * 三名学生 × 三场考试（1 小考 + 2 大考）、语文 / 数学 / 英语三科。
 * 学生甲语文：小考 65（第 3）→ 期中 90（第 2）→ 期末 99（第 1）；
 * 英语只在两场大考出现（供「切 Tab 回退全部」用例）。
 */
async function seed(): Promise<SeedResult> {
  const quiz = await createExam({ class_name: CLASS_NAME, name: "第一单元测验", exam_date: "2026-06-05" });
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
  const scores: [number, Record<string, number>, Record<string, number>, Record<string, number>][] = [
    // [考试, 语文, 数学, 英语]
    [quiz, { 学生甲: 65, 学生乙: 70, 学生丙: 90 }, { 学生甲: 76, 学生乙: 66, 学生丙: 88 }, {}],
    [midterm, { 学生甲: 90, 学生乙: 70, 学生丙: 100 }, { 学生甲: 80, 学生乙: 60, 学生丙: 100 }, { 学生甲: 88, 学生乙: 78, 学生丙: 95 }],
    [final, { 学生甲: 99, 学生乙: 75, 学生丙: 98 }, { 学生甲: 85, 学生乙: 65, 学生丙: 95 }, { 学生甲: 92, 学生乙: 82, 学生丙: 90 }],
  ];
  for (const [examId, chinese, math, english] of scores) {
    for (const [name, score] of Object.entries(chinese)) {
      await upsertExamScore(examId, studentIds[name], "语文", score, null);
    }
    for (const [name, score] of Object.entries(math)) {
      await upsertExamScore(examId, studentIds[name], "数学", score, null);
    }
    for (const [name, score] of Object.entries(english)) {
      await upsertExamScore(examId, studentIds[name], "英语", score, null);
    }
  }
  return { quiz, midterm, final, studentIds };
}

async function cleanup() {
  for (const e of await listExamsByClass(CLASS_NAME)) await deleteExam(e.id);
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME) await deleteStudent(s.id);
  }
}

describe("学生单科成绩趋势", () => {
  it("默认「全部」保持全科折线，科目芯片行可切换", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      expect(wrapper.find("[data-test='subject-trend-chips']").exists()).toBe(true);
      expect(wrapper.find("[data-test='subject-chip-all']").exists()).toBe(true);
      expect(wrapper.find("[data-test='subject-chip-语文']").exists()).toBe(true);
      expect(wrapper.find("[data-test='subject-chip-英语']").exists()).toBe(true);

      // 默认全科：大考图里语文 / 数学 / 英语各一条折线，没有单科透视
      const chart = wrapper.get("[data-test='score-line-chart']");
      expect(chart.findAll("polyline")).toHaveLength(3);
      expect(wrapper.find("[data-test='subject-trend-view']").exists()).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("选单科进入透视视图：统计条、本人 vs 班级均分双线、趋势小结、历次名次", async () => {
    await cleanup();
    try {
      const { final, studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      await wrapper.get("[data-test='subject-chip-语文']").trigger("click");
      await flushPromises();

      // 标题带科目，图表切换为单科透视（大考 Tab：期中 90 → 期末 99）
      expect(wrapper.text()).toContain("大考·语文成绩走势");
      const view = wrapper.get("[data-test='subject-trend-view']");

      // 统计条：平均 (90+99)/2 = 94.5；最近名次 第 1
      const stats = view.get("[data-test='subject-trend-stats']");
      expect(stats.text()).toContain("94.5");
      expect(stats.text()).toContain("↑ 9");
      expect(stats.text()).toContain("第 1");

      // 双线：本人 + 班级均分（期末语文班均 (99+75+98)/3 = 90.7，画为虚线参照）
      const chart = view.get("[data-test='score-line-chart']");
      expect(chart.findAll("polyline")).toHaveLength(2);
      expect(chart.text()).toContain("班级均分");
      expect(chart.findAll("[data-test='chart-point']")).toHaveLength(4); // 2 场 × 2 条线
      expect(chart.findAll("[data-test='chart-band']")).toHaveLength(2);

      // 趋势小结（规则生成，口径与统计条一致）
      const summary = view.get("[data-test='subject-trend-summary']").text();
      expect(summary).toContain("语文 2 次考试平均 94.5 分");
      expect(summary).toContain("较上次进步 9 分");
      expect(summary).toContain("高于班均 8.3 分"); // 99 − 90.7
      expect(summary).toContain("班级第 1 名，较上次提升 1 名");

      // 历次名次：第 2 → 第 1，提升带 ↑ 箭头
      const ranks = view.get("[data-test='subject-trend-ranks']");
      expect(ranks.text()).toContain("第 2 名");
      expect(ranks.text()).toContain("第 1 名");
      expect(ranks.text()).toContain("↑1");

      // 点击单科图节点 → 详情卡展开并高亮该科目行，收起后回到提示
      await chart.find(`[data-test='chart-band'][data-exam-id='${final}']`).trigger("click");
      await flushPromises();
      const card = wrapper.get("[data-test='exam-card']");
      expect(card.text()).toContain("语文 99");
      expect(wrapper.get("[data-test='exam-card-active-subject']").text()).toContain("语文 99");
      await wrapper.get("[data-test='close-exam-detail']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='exam-detail-hint']").exists()).toBe(true);

      // 切回「全部」：恢复全科折线
      await wrapper.get("[data-test='subject-chip-all']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='subject-trend-view']").exists()).toBe(false);
      expect(wrapper.get("[data-test='score-line-chart']").findAll("polyline")).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  it("单科透视下切大考/小考 Tab：只统计该组考试", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      await wrapper.get("[data-test='subject-chip-语文']").trigger("click");
      await flushPromises();
      await wrapper.get("[data-test='chart-tab-minor']").trigger("click");
      await flushPromises();

      expect(wrapper.text()).toContain("小考·语文成绩走势");
      const view = wrapper.get("[data-test='subject-trend-view']");
      // 小考只有一场：平均 65、无从比较、班均 75 → 低于 10 分
      const summary = view.get("[data-test='subject-trend-summary']").text();
      expect(summary).toContain("语文 1 次考试平均 65 分");
      expect(summary).toContain("低于班均 10 分");
      expect(summary).not.toContain("较上次");
      expect(view.get("[data-test='subject-trend-ranks']").text()).toContain("第 3 名");
      expect(view.get("[data-test='score-line-chart']").findAll("[data-test='chart-band']")).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("所选科目在切换后的 Tab 没有成绩时回退「全部」", async () => {
    await cleanup();
    try {
      const { studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["学生甲"] } });
      await flushPromises();

      // 英语只在两场大考出现
      await wrapper.get("[data-test='subject-chip-英语']").trigger("click");
      await flushPromises();
      expect(wrapper.get("[data-test='subject-trend-view']").text()).toContain("英语 2 次考试平均 90 分");

      // 切到小考：英语无数据 → 自动回退全科走势
      await wrapper.get("[data-test='chart-tab-minor']").trigger("click");
      await flushPromises();
      expect(wrapper.find("[data-test='subject-trend-view']").exists()).toBe(false);
      const chart = wrapper.get("[data-test='score-line-chart']");
      expect(chart.text()).toContain("第一单元测验");
      expect(chart.text()).not.toContain("英语");
    } finally {
      await cleanup();
    }
  });
});
