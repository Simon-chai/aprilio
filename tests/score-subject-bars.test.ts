import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ExamScorePanel from "../src/components/ExamScorePanel.vue";
import StudentScorePanel from "../src/components/StudentScorePanel.vue";
import SubjectScoreBars from "../src/components/SubjectScoreBars.vue";
import {
  createExam,
  createStudent,
  deleteExam,
  deleteStudent,
  listExamsByClass,
  listStudents,
  upsertExamScore,
} from "../src/lib/db";
import { resetScoreLevelConfig, saveScoreLevelConfig } from "../src/lib/score-config";

const CLASS_NAME = "成绩柱状图测试班";
const SINGLE_CLASS_NAME = "成绩柱状图测试班单场";

interface SeedResult {
  midterm: number;
  final: number;
  studentIds: Record<string, number>;
}

async function createClassStudent(name: string, no: string, className = CLASS_NAME): Promise<number> {
  return createStudent({
    name,
    gender: "男",
    birth_date: null,
    student_no: no,
    grade_class: className,
    id_card: null,
    address: null,
    status: "active",
    note: null,
    guardians: [],
  });
}

async function seed(): Promise<SeedResult> {
  const midterm = await createExam({ class_name: CLASS_NAME, name: "期中考试", exam_date: "2026-06-20" });
  const final = await createExam({ class_name: CLASS_NAME, name: "期末考试", exam_date: "2026-07-10" });
  const studentIds: Record<string, number> = {
    林一: await createClassStudent("林一", "9801"),
    王二: await createClassStudent("王二", "9802"),
  };
  // 期中：林一 语文90 数学80 英语70；王二 语文85 数学95 英语60
  await upsertExamScore(midterm, studentIds["林一"], "语文", 90, null);
  await upsertExamScore(midterm, studentIds["林一"], "数学", 80, null);
  await upsertExamScore(midterm, studentIds["林一"], "英语", 70, null);
  await upsertExamScore(midterm, studentIds["王二"], "语文", 85, null);
  await upsertExamScore(midterm, studentIds["王二"], "数学", 95, null);
  await upsertExamScore(midterm, studentIds["王二"], "英语", 60, null);
  // 期末：林一 语文95 数学85 英语75；王二 语文80 数学90 英语65
  await upsertExamScore(final, studentIds["林一"], "语文", 95, null);
  await upsertExamScore(final, studentIds["林一"], "数学", 85, null);
  await upsertExamScore(final, studentIds["林一"], "英语", 75, null);
  await upsertExamScore(final, studentIds["王二"], "语文", 80, null);
  await upsertExamScore(final, studentIds["王二"], "数学", 90, null);
  await upsertExamScore(final, studentIds["王二"], "英语", 65, null);
  return { midterm, final, studentIds };
}

async function cleanup() {
  for (const className of [CLASS_NAME, SINGLE_CLASS_NAME]) {
    for (const e of await listExamsByClass(className)) await deleteExam(e.id);
  }
  for (const s of await listStudents()) {
    if (s.grade_class === CLASS_NAME || s.grade_class === SINGLE_CLASS_NAME) await deleteStudent(s.id);
  }
}

/** 柱子上记录的分数（按渲染顺序） */
function barScores(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("[data-test='score-bar']").map((b) => b.attributes("data-score") ?? "");
}

describe("SubjectScoreBars 可复用柱状图", () => {
  it("按考试场次分组渲染每科柱子、分数与考试标签", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        groups: [
          {
            label: "期中考试",
            sub: "06-20",
            items: [
              { subject: "语文", score: 90 },
              { subject: "数学", score: 80 },
            ],
          },
          {
            label: "期末考试",
            sub: "07-10",
            items: [
              { subject: "语文", score: 95 },
              { subject: "数学", score: 85 },
            ],
          },
        ],
      },
    });

    expect(wrapper.findAll("[data-test='score-bar-group']")).toHaveLength(2);
    const bars = wrapper.findAll("[data-test='score-bar']");
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.attributes("data-subject"))).toEqual(["语文", "数学", "语文", "数学"]);
    expect(barScores(wrapper)).toEqual(["90", "80", "95", "85"]);

    // 场次标签与分数文本
    expect(wrapper.text()).toContain("期中考试");
    expect(wrapper.text()).toContain("期末考试");
    expect(wrapper.text()).toContain("90");
    expect(wrapper.text()).toContain("95");

    // 图例：每科一个色块（跨场次同科同色）
    const legend = wrapper.get("[data-test='subject-bars-legend']");
    expect(legend.text()).toContain("语文");
    expect(legend.text()).toContain("数学");
  });

  it("铺满模式：科目列均分宽度、柱子在列内居中（不挤在一角）", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        fill: true,
        groups: [
          {
            label: "期中考试",
            items: [
              { subject: "语文", score: 90 },
              { subject: "数学", score: 80 },
              { subject: "英语", score: 70 },
            ],
          },
        ],
      },
    });

    const columns = wrapper.findAll("[data-test='score-bar-column']");
    expect(columns).toHaveLength(3);
    for (const column of columns) {
      expect(column.classes()).toContain("flex-1");
    }
    // 柱子宽度随列宽自适应，但有上限（不会拉成大方块）
    expect(wrapper.get("[data-test='score-bar']").attributes("style")).toContain("max-width");
  });

  it("高分柱不被数值标签压扁：列高留出标签空间，柱高按本次区间放大差距", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        fill: true,
        groups: [
          {
            label: "期中考试",
            items: [
              { subject: "语文", score: 100 },
              { subject: "数学", score: 90 },
            ],
          },
        ],
      },
    });

    // 列高 = 柱区 112 + 标签 18：标签与柱子互不挤占
    const columns = wrapper.findAll("[data-test='score-bar-column']");
    expect(columns[0]!.attributes("style")).toContain("130px");

    const bars = wrapper.findAll("[data-test='score-bar']");
    const heights = bars.map((bar) =>
      Number(/height:\s*(\d+)px/.exec(bar.attributes("style") ?? "")?.[1] ?? 0)
    );
    // 只有 100 与 90 两科时基准抬到 85 分：90 分的柱只剩三成高，差距一眼可见
    expect(heights).toEqual([112, 37]);
    // 柱子不参与 flex 收缩，高度只由分数与基准决定
    expect(bars.every((bar) => bar.classes().includes("shrink-0"))).toBe(true);
  });

  it("show-label=false 时隐藏场次标签（卡片头部已有场次信息）", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        fill: true,
        showLabel: false,
        groups: [{ label: "期中考试", sub: "06-20", items: [{ subject: "语文", score: 90 }] }],
      },
    });
    expect(wrapper.text()).not.toContain("期中考试");
    expect(wrapper.text()).not.toContain("06-20");
    expect(wrapper.text()).toContain("语文");
  });

  it("等级制 / 缺考不画数值柱，只保留文字", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        groups: [
          {
            label: "单元测验",
            items: [
              { subject: "语文", score: null, grade: "缺考" },
              { subject: "数学", score: 88 },
            ],
          },
        ],
      },
    });

    const bars = wrapper.findAll("[data-test='score-bar']");
    expect(bars).toHaveLength(1);
    expect(bars[0].attributes("data-subject")).toBe("数学");
    expect(wrapper.text()).toContain("缺考");
    expect(wrapper.text()).toContain("88");
  });

  it("紧凑模式（悬浮卡片用）不渲染图例", () => {
    const wrapper = mount(SubjectScoreBars, {
      props: {
        compact: true,
        groups: [{ label: "期中考试", items: [{ subject: "语文", score: 90 }] }],
      },
    });
    expect(wrapper.find("[data-test='subject-bars-legend']").exists()).toBe(false);
    expect(wrapper.findAll("[data-test='score-bar']")).toHaveLength(1);
  });

  it("等级模式：柱顶显示等级名，柱高按档位代表值（同等级等高）", () => {
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
      const wrapper = mount(SubjectScoreBars, {
        props: {
          groups: [
            {
              label: "期中考试",
              items: [
                { subject: "语文", score: 95 },
                { subject: "数学", score: 92 },
                { subject: "英语", score: 42 },
              ],
            },
          ],
        },
      });

      // 柱顶文本为等级名，不出现具体分数
      const values = wrapper.findAll("[data-test='score-bar-value']").map((v) => v.text());
      expect(values).toEqual(["优秀", "优秀", "待提高"]);
      // 同等级取同一代表值（该档最低分）：两根优秀柱等高，待提高只剩最小可见高度
      expect(barScores(wrapper)).toEqual(["90", "90", "0"]);
      const bars = wrapper.findAll("[data-test='score-bar']");
      expect(bars[0]!.attributes("style")).toContain("height: 101px"); // 112 × 0.9
      expect(bars[2]!.attributes("style")).toContain("height: 4px");
    } finally {
      resetScoreLevelConfig();
    }
  });
});

describe("学生详情页成绩栏目：按考试场次查看各科柱状图", () => {
  it("提供考试场次入口，默认最近一场，切换后柱子随之更新", async () => {
    await cleanup();
    try {
      const { midterm, studentIds } = await seed();
      const wrapper = mount(StudentScorePanel, { props: { studentId: studentIds["林一"] } });
      await flushPromises();

      const block = wrapper.get("[data-test='student-subject-bars']");
      // 场次入口：一次考试一个芯片
      const chips = block.findAll("[data-test^='subject-bars-exam-']");
      expect(chips).toHaveLength(2);

      // 默认最近一场（期末）：3 科
      expect(barScores(block)).toEqual(["95", "85", "75"]);
      expect(block.text()).toContain("语文");

      // 切到期中：柱子换成期中分数
      await block.find(`[data-test='subject-bars-exam-${midterm}']`).trigger("click");
      await flushPromises();
      expect(barScores(block)).toEqual(["90", "80", "70"]);
      expect(block.get("[data-test='subject-bars-meta']").text()).toContain("2026-06-20");
    } finally {
      await cleanup();
    }
  });

  it("只有一次考试时也有柱状图（折线图此时不出现）", async () => {
    await cleanup();
    try {
      const exam = await createExam({
        class_name: SINGLE_CLASS_NAME,
        name: "第一次月考",
        exam_date: "2026-06-10",
      });
      const studentId = await createClassStudent("单场学生", "9803", SINGLE_CLASS_NAME);
      await upsertExamScore(exam, studentId, "语文", 82, null);
      await upsertExamScore(exam, studentId, "数学", 78, null);

      const wrapper = mount(StudentScorePanel, { props: { studentId } });
      await flushPromises();

      expect(wrapper.find("[data-test='student-trend-chart']").exists()).toBe(false);
      const block = wrapper.get("[data-test='student-subject-bars']");
      expect(block.findAll("[data-test^='subject-bars-exam-']")).toHaveLength(1);
      expect(barScores(block)).toEqual(["82", "78"]);
      expect(block.text()).toContain("第一次月考");
    } finally {
      await cleanup();
    }
  });
});

describe("班级考试成绩 Tab：悬浮学生行弹出各科柱状图", () => {
  it("卡片跟随鼠标移动，移出后消失", async () => {
    await cleanup();
    try {
      const { midterm } = await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      // 默认选中期末（时间倒序第一场），切到期中核对分数
      await wrapper.get(`[data-test='exam-chip-${midterm}']`).trigger("click");
      await flushPromises();

      expect(wrapper.find("[data-test='student-score-hover-card']").exists()).toBe(false);

      const row = wrapper
        .findAll("[data-test='exam-detail-table'] tbody tr")
        .find((r) => r.text().includes("林一"));
      expect(row, "应能找到林一所在的学生行").toBeTruthy();

      await row!.trigger("mouseenter", { clientX: 100, clientY: 120 });
      const card = wrapper.get("[data-test='student-score-hover-card']");
      expect(card.text()).toContain("林一");
      expect(card.text()).toContain("期中考试");
      expect(card.findAll("[data-test='score-bar']")).toHaveLength(3);
      expect(card.text()).toContain("90");
      expect(card.text()).toContain("总分 240");
      expect(card.attributes("style")).toContain("left: 116px");

      // 鼠标移动 → 卡片跟随
      await row!.trigger("mousemove", { clientX: 400, clientY: 300 });
      expect(wrapper.get("[data-test='student-score-hover-card']").attributes("style")).toContain(
        "left: 416px",
      );
      expect(wrapper.get("[data-test='student-score-hover-card']").attributes("style")).toContain(
        "top: 316px",
      );

      await row!.trigger("mouseleave");
      expect(wrapper.find("[data-test='student-score-hover-card']").exists()).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("切换考试后悬浮卡片展示新场次的分数", async () => {
    await cleanup();
    try {
      const { midterm, final } = await seed();
      const wrapper = mount(ExamScorePanel, { props: { className: CLASS_NAME } });
      await flushPromises();

      const hoverLin = async () => {
        const row = wrapper
          .findAll("[data-test='exam-detail-table'] tbody tr")
          .find((r) => r.text().includes("林一"));
        await row!.trigger("mouseenter", { clientX: 120, clientY: 140 });
        return wrapper.get("[data-test='student-score-hover-card']");
      };

      await wrapper.get(`[data-test='exam-chip-${midterm}']`).trigger("click");
      await flushPromises();
      expect((await hoverLin()).text()).toContain("期中考试");

      await wrapper.get(`[data-test='exam-chip-${final}']`).trigger("click");
      await flushPromises();
      const card = await hoverLin();
      expect(card.text()).toContain("期末考试");
      expect(card.text()).toContain("95");
    } finally {
      await cleanup();
    }
  });
});
