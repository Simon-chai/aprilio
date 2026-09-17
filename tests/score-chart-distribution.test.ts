import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ScoreChartTypeSelect from "../src/components/ScoreChartTypeSelect.vue";
import StudentScorePanel from "../src/components/StudentScorePanel.vue";
import SubjectScoreDistribution from "../src/components/SubjectScoreDistribution.vue";
import {
  createExam,
  createStudent,
  deleteExam,
  deleteStudent,
  listExamsByClass,
  listStudents,
  upsertExamScore,
} from "../src/lib/db";
import { plotScaleOf } from "../src/lib/score-chart";
import {
  normalizeScoreChartType,
  resetScoreChartType,
  scoreChartType,
  setScoreChartType,
} from "../src/lib/score-chart-type";
import { resetScoreLevelConfig, saveScoreLevelConfig } from "../src/lib/score-config";

const STORAGE_KEY = "aprilio.score.chartType";
const CLASS_NAME = "成绩分布图测试班";

const ITEMS = [
  { subject: "语文", score: 90 },
  { subject: "数学", score: 80 },
  { subject: "英语", score: 60 },
];

/** 偏好是模块级单例：逐用例还原，避免串味 */
afterEach(() => {
  resetScoreChartType();
  localStorage.removeItem(STORAGE_KEY);
});

async function cleanup() {
  for (const e of await listExamsByClass(CLASS_NAME)) await deleteExam(e.id);
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME) await deleteStudent(s.id);
  }
}

/** 挂一个分布图并切到指定图型（偏好是全局单例，切完等一次刷新） */
async function mountChart(type: Parameters<typeof setScoreChartType>[0], items = ITEMS) {
  const wrapper = mount(SubjectScoreDistribution, { props: { items } });
  setScoreChartType(type);
  await flushPromises();
  return wrapper;
}

describe("各科成绩分布：绘图基准（动态放大差距）", () => {
  it("分数挤在高分段时基准线上抬，不再从 0 分起画", () => {
    // 最高 100、最低 90 → 基准 85~100：90 分的柱只剩三成高
    expect(plotScaleOf([90, 100])).toEqual({ floor: 85, ceiling: 100 });
    // 同分（看不出差距）也撑开 15 分窗口
    expect(plotScaleOf([95])).toEqual({ floor: 85, ceiling: 100 });
    // 低分段同样收紧上下限，而不是钉在 0~100
    expect(plotScaleOf([40, 50])).toEqual({ floor: 35, ceiling: 55 });
    // 有 0 分时仍以下限 0 收口
    expect(plotScaleOf([0, 90])).toEqual({ floor: 0, ceiling: 100 });
    // 没有任何分数时回落 0~100
    expect(plotScaleOf([])).toEqual({ floor: 0, ceiling: 100 });
  });
});

describe("各科成绩分布：图表类型偏好", () => {
  it("未知值回落柱状图，可选类型原样生效", () => {
    expect(normalizeScoreChartType("pie")).toBe("pie");
    expect(normalizeScoreChartType("radar")).toBe("radar");
    expect(normalizeScoreChartType("donut")).toBe("bar");
    expect(normalizeScoreChartType(null)).toBe("bar");
  });

  it("切换后立即生效并落本机存储（下次打开仍是它）", () => {
    setScoreChartType("pie");
    expect(scoreChartType.value).toBe("pie");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify("pie"));

    setScoreChartType("bar");
    expect(scoreChartType.value).toBe("bar");
  });
});

describe("各科成绩分布：图型下拉", () => {
  it("下拉里是五种图型，选中即改全局偏好（不再穷举胶囊）", async () => {
    const select = mount(ScoreChartTypeSelect);
    const options = select.findAll("option").map((option) => option.text());
    expect(options).toEqual(["柱状图", "条形图", "折线图", "饼状图", "辐射图"]);

    await select.get("[data-test='chart-type-select']").setValue("line");
    expect(scoreChartType.value).toBe("line");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify("line"));
  });

  it("切换一次全局生效：同页另一个图表实例同步换图", async () => {
    const first = mount(SubjectScoreDistribution, { props: { items: ITEMS } });
    const second = mount(SubjectScoreDistribution, { props: { items: ITEMS } });

    setScoreChartType("hbar");
    await flushPromises();

    expect(first.find("[data-test='subject-score-hbar']").exists()).toBe(true);
    expect(second.find("[data-test='subject-score-hbar']").exists()).toBe(true);
    expect(second.find("[data-test='subject-score-bars']").exists()).toBe(false);
  });
});

describe("各科成绩分布：各类型渲染", () => {
  it("条形图：长度按基准放大，分值列在右侧", async () => {
    const wrapper = await mountChart("hbar");

    expect(wrapper.findAll("[data-test='score-hbar-row']")).toHaveLength(3);
    // 60~90 分 → 基准 50~100：90 分八成宽、60 分只剩两成，差距被放大
    const widths = wrapper.findAll("[data-test='score-hbar']").map((bar) => bar.attributes("style") ?? "");
    expect(widths[0]).toContain("width: 80%");
    expect(widths[2]).toContain("width: 20%");
    expect(wrapper.findAll("[data-test='score-hbar-value']").map((v) => v.text())).toEqual([
      "90",
      "80",
      "60",
    ]);
  });

  it("折线图：纵轴按基准收紧，缺考断线不进点", async () => {
    const wrapper = await mountChart("line");

    const points = wrapper.findAll("[data-test='score-line-point']");
    expect(points).toHaveLength(3);
    const cyOf = (index: number) => Number(points[index]!.attributes("cy"));
    // 90 分最高（y 最小），60 分最低（y 最大）
    expect(cyOf(0)).toBeLessThan(cyOf(1));
    expect(cyOf(1)).toBeLessThan(cyOf(2));
    expect(wrapper.get("[data-test='subject-score-line']").text()).toContain("语文");

    const skipped = await mountChart("line", [
      ...ITEMS,
      { subject: "物理", score: null, grade: "缺考" },
    ]);
    expect(skipped.findAll("[data-test='score-line-point']")).toHaveLength(3);
    expect(skipped.get("[data-test='distribution-note']").text()).toContain("物理（缺考）");
  });

  it("饼状图：一科一个扇区，图例给出分值与占比", async () => {
    const wrapper = await mountChart("pie");

    expect(wrapper.findAll("[data-test='score-pie-slice']")).toHaveLength(3);
    const legend = wrapper.findAll("[data-test='score-pie-legend-item']").map((row) => row.text());
    expect(legend[0]).toContain("语文");
    expect(legend[0]).toContain("90");
    expect(legend[0]).toContain("39%"); // 90 / (90+80+60)
    expect(legend[2]).toContain("26%");
  });

  it("辐射图：一科一条轴线，少于 3 门科目给提示", async () => {
    const wrapper = await mountChart("radar");

    expect(wrapper.find("[data-test='score-radar-polygon']").exists()).toBe(true);
    expect(wrapper.findAll("[data-test='score-radar-point']")).toHaveLength(3);
    expect(wrapper.get("[data-test='subject-score-radar']").text()).toContain("语文");

    const few = await mountChart("radar", [
      { subject: "语文", score: 90 },
      { subject: "数学", score: 80 },
    ]);
    expect(few.get("[data-test='subject-score-radar']").text()).toContain("至少要 3 门");
  });

  it("图下说明带实际刻度与未计入科目；饼状图看构成不放大", async () => {
    const wrapper = await mountChart("bar", [...ITEMS, { subject: "物理", score: null, grade: "缺考" }]);
    const note = () => wrapper.get("[data-test='distribution-note']").text();

    expect(note()).toContain("柱高按本次分数区间放大");
    expect(note()).toContain("刻度 50~100 分"); // 60~90 分的放大基准
    expect(note()).toContain("未计入图形的科目：物理（缺考）");

    setScoreChartType("pie");
    await flushPromises();
    expect(note()).toContain("占比");
    expect(note()).not.toContain("刻度");
  });

  it("等级模式：图型换成档位口径，文本显示等级名", async () => {
    saveScoreLevelConfig({
      bands: [
        { key: "excellent", label: "优秀", min: 90 },
        { key: "good", label: "良好", min: 80 },
        { key: "pass", label: "及格", min: 60 },
        { key: "fail", label: "待提高", min: 0 },
      ],
      showLevelOnly: true,
    });
    try {
      const wrapper = await mountChart("hbar", [
        { subject: "语文", score: 95 },
        { subject: "数学", score: 85 },
        { subject: "英语", score: 62 },
      ]);

      // 长度按档位代表值（该档最低分）折算，文本显示等级名
      expect(wrapper.findAll("[data-test='score-hbar']").map((b) => b.attributes("data-score"))).toEqual([
        "90",
        "80",
        "60",
      ]);
      expect(wrapper.findAll("[data-test='score-hbar-value']").map((v) => v.text())).toEqual([
        "优秀",
        "良好",
        "及格",
      ]);
    } finally {
      resetScoreLevelConfig();
    }
  });
});

describe("学生详情页成绩栏目：分布图型跟随全局偏好", () => {
  async function seed(): Promise<{ studentId: number }> {
    const exam = await createExam({
      class_name: CLASS_NAME,
      name: "期中考试",
      exam_date: "2026-06-20",
    });
    const studentId = await createStudent({
      name: "分布图学生",
      gender: "男",
      birth_date: null,
      student_no: "9901",
      grade_class: CLASS_NAME,
      id_card: null,
      address: null,
      status: "active",
      note: null,
      guardians: [],
    });
    await upsertExamScore(exam, studentId, "语文", 90, null);
    await upsertExamScore(exam, studentId, "数学", 80, null);
    await upsertExamScore(exam, studentId, "英语", 70, null);
    return { studentId };
  }

  it("卡片标题右侧的下拉切换图型，立即换图并记住偏好", async () => {
    await cleanup();
    try {
      const { studentId } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId } });
      await flushPromises();

      const block = wrapper.get("[data-test='student-subject-bars']");
      expect(block.find("[data-test='chart-type-select']").exists()).toBe(true);
      expect(block.findAll("[data-test='score-bar']")).toHaveLength(3);

      await block.get("[data-test='chart-type-select']").setValue("line");
      expect(block.find("[data-test='subject-score-line']").exists()).toBe(true);
      expect(block.find("[data-test='subject-score-bars']").exists()).toBe(false);
      // 切一次就全局生效：偏好已落本机存储，其他页面（含下次打开）都按它渲染
      expect(scoreChartType.value).toBe("line");
      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify("line"));
    } finally {
      await cleanup();
    }
  });
});