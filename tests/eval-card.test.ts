import { beforeAll, describe, expect, it } from "vitest";
import {
  addBehaviorRecord,
  addHomeworkRecord,
  createExam,
  createStudent,
  listBehaviorDimensions,
  upsertExamScore,
  upsertTermComment,
} from "../src/lib/db";
import {
  aggregateEvalCard,
  computeEvalCardStars,
  evalCardFileName,
  evalCardRange,
  isValidEvalCardRange,
  type EvalCardView,
} from "../src/lib/eval-card";
import { buildEvalCardHtml, watermarkStyleValue } from "../src/lib/eval-card-template";
import { buildForeignObjectSvg } from "../src/lib/html-to-png";
import { emptyStudentInput, type BehaviorDimension } from "../src/types";

const CLASS_NAME = "评价卡测试班";

describe("evalCardRange 周期解析", () => {
  it("本月：从月初到今天，标签为「YYYY 年 M 月」", () => {
    const range = evalCardRange("thisMonth", { start: "", end: "" }, new Date(2026, 9, 3));
    expect(range).toEqual({ start: "2026-10-01", end: "2026-10-03", label: "2026 年 10 月" });
  });

  it("上月：跨年时取上一年 12 月整月", () => {
    const range = evalCardRange("lastMonth", { start: "", end: "" }, new Date(2026, 0, 15));
    expect(range).toEqual({ start: "2025-12-01", end: "2025-12-31", label: "2025 年 12 月" });
  });

  it("本学期：秋季从 9 月 1 日起，标签走 semesterLabel", () => {
    const range = evalCardRange("thisSemester", { start: "", end: "" }, new Date(2026, 9, 3));
    expect(range.start).toBe("2026-09-01");
    expect(range.end).toBe("2026-10-03");
    expect(range.label).toBe("2026–2027 秋季学期");
  });

  it("本学期：春季从次年 3 月 1 日起", () => {
    const range = evalCardRange("thisSemester", { start: "", end: "" }, new Date(2026, 2, 10));
    expect(range.start).toBe("2026-03-01");
    expect(range.label).toBe("2025–2026 春季学期");
  });

  it("自定义：同年用 MM.DD – MM.DD，跨年带年份", () => {
    const same = evalCardRange("custom", { start: "2026-09-01", end: "2026-09-30" });
    expect(same.label).toBe("09.01 – 09.30");
    const cross = evalCardRange("custom", { start: "2025-12-01", end: "2026-01-10" });
    expect(cross.label).toBe("2025.12.01 – 2026.01.10");
  });

  it("isValidEvalCardRange：格式与先后顺序校验", () => {
    expect(isValidEvalCardRange("2026-09-01", "2026-09-30")).toBe(true);
    expect(isValidEvalCardRange("2026-09-30", "2026-09-01")).toBe(false);
    expect(isValidEvalCardRange("2026/09/01", "2026-09-30")).toBe(false);
    expect(isValidEvalCardRange("", "2026-09-30")).toBe(false);
  });
});

describe("computeEvalCardStars 星级启发式", () => {
  const base = { rankPct: null, praiseCount: 0, improveCount: 0, onTimeRate: null };

  it("无任何数据时为基础 3 星", () => {
    expect(computeEvalCardStars(base)).toBe(3);
  });

  it("排名靠前 + 表扬多 + 作业准时 → 5 星；反向表现 → 收敛到 1 星", () => {
    expect(computeEvalCardStars({ ...base, rankPct: 0.1, praiseCount: 5, onTimeRate: 0.95 })).toBe(5);
    expect(computeEvalCardStars({ ...base, rankPct: 0.9, improveCount: 3, onTimeRate: 0.5 })).toBe(1);
  });

  it("星级收敛在 1–5 之间", () => {
    expect(
      computeEvalCardStars({ rankPct: 0.05, praiseCount: 99, improveCount: 0, onTimeRate: 1 })
    ).toBe(5);
    expect(
      computeEvalCardStars({ rankPct: 0.99, praiseCount: 0, improveCount: 99, onTimeRate: 0 })
    ).toBe(1);
  });
});

describe("aggregateEvalCard 聚合（内存库全链路）", () => {
  let studentA = 0;
  let studentB = 0;

  beforeAll(async () => {
    const dims: BehaviorDimension[] = await listBehaviorDimensions();
    const dimId = (code: string): number => {
      const dim = dims.find((d) => d.code === code);
      if (!dim) throw new Error(`缺少维度 ${code}`);
      return dim.id;
    };

    studentA = await createStudent({ ...emptyStudentInput(), name: "李梓涵", grade_class: CLASS_NAME });
    studentB = await createStudent({ ...emptyStudentInput(), name: "王佑琪", grade_class: CLASS_NAME });

    // 8 月：A 280 / B 264；9 月：A 285（+5，第 1 名）/ B 270（+6，第 2 名）
    const aug = await createExam({ class_name: CLASS_NAME, name: "8月月考", exam_date: "2026-08-20" });
    const sep = await createExam({ class_name: CLASS_NAME, name: "9月月考", exam_date: "2026-09-25" });
    const augScores: Record<number, Record<string, number>> = {
      [studentA]: { 语文: 92, 数学: 96, 英语: 92 },
      [studentB]: { 语文: 88, 数学: 88, 英语: 88 },
    };
    const sepScores: Record<number, Record<string, number>> = {
      [studentA]: { 语文: 92, 数学: 98, 英语: 95 },
      [studentB]: { 语文: 90, 数学: 90, 英语: 90 },
    };
    for (const [examId, table] of [
      [aug, augScores],
      [sep, sepScores],
    ] as const) {
      for (const [sid, subjects] of Object.entries(table)) {
        for (const [subject, score] of Object.entries(subjects)) {
          await upsertExamScore(examId, Number(sid), subject, score, null);
        }
      }
    }

    const classroom = dimId("classroom");
    const labor = dimId("labor");
    const praise = (dimension_id: number, dimension_name_snap: string, recorded_date: string, comment: string) =>
      addBehaviorRecord({
        student_id: studentA,
        dimension_id,
        dimension_name_snap,
        category_snap: "behavior",
        type: "praise",
        comment,
        recorded_date,
      });
    await praise(classroom, "课堂发言", "2026-09-08", "主动帮同桌讲解数学题");
    await praise(classroom, "课堂发言", "2026-09-19", "国旗下讲话获全校表扬");
    await praise(classroom, "课堂发言", "2026-09-26", "连续一周数学作业全对，当选作业示范");
    await praise(labor, "帮助同学", "2026-09-22", "帮值日生抬水");
    await addBehaviorRecord({
      student_id: studentA,
      dimension_id: classroom,
      dimension_name_snap: "课堂纪律",
      category_snap: "behavior",
      type: "improve",
      comment: "上课偶尔走神",
      recorded_date: "2026-09-10",
    });
    // 周期外的记录不应计入
    await praise(classroom, "课堂发言", "2026-08-30", "八月的记录");

    await addHomeworkRecord({ student_id: studentA, homework_date: "2026-09-03", subject: "数学", status: "done" });
    await addHomeworkRecord({ student_id: studentA, homework_date: "2026-09-17", subject: "语文", status: "excellent" });

    await upsertTermComment(studentA, "2026-2027-1", "梓涵本学期进步明显。", "manual");
  });

  it("A 生：成绩区取周期内最近一次考试，含总分变化与排名", async () => {
    const view = await aggregateEvalCard(studentA, {
      start: "2026-09-01",
      end: "2026-09-30",
      label: "09.01 – 09.30",
    });
    expect(view.name).toBe("李梓涵");
    expect(view.className).toBe(CLASS_NAME);
    expect(view.avatarChar).toBe("梓");
    expect(view.score?.title).toBe("9月月考");
    expect(view.score?.subtitle).toBe("2026-09-25 · 班级第 1 名");
    expect(view.score?.subjects).toEqual([
      { subject: "语文", score: 92 },
      { subject: "数学", score: 98 },
      { subject: "英语", score: 95 },
    ]);
    expect(view.score?.rankNote).toBe("总分较上次提高 5 分，班级第 1 名（共 2 人）");
    expect(view.score?.noteTone).toBe("up");
    expect(view.periodLabel).toBe("09.01 – 09.30");
  });

  it("A 生：亮点标签计数、时间线倒序取表扬、作业按时率与学期评语", async () => {
    const view = await aggregateEvalCard(studentA, {
      start: "2026-09-01",
      end: "2026-09-30",
      label: "09.01 – 09.30",
    });
    // dimension_name_snap 以维度字典名为准（addBehaviorRecord 归一化）
    expect(view.tags).toEqual(["课堂表现 ×3", "劳动情况", "作业按时 2/2"]);
    expect(view.moments.map((m) => m.date)).toEqual(["09-26", "09-22", "09-19"]);
    expect(view.moments[0].text).toBe("连续一周数学作业全对，当选作业示范");
    expect(view.comment).toBe("梓涵本学期进步明显。");
    expect(view.chips).toEqual(
      expect.arrayContaining([
        { key: "study", label: "学习", value: "95" },
        { key: "behavior", label: "表现", value: "优" },
        { key: "homework", label: "作业", value: "优" },
      ])
    );
    // 排名居中(0.5)不加不减、表扬 4 次(<5)不加、待改进 1 次(<3)不减、按时率 1.0 → +1
    expect(view.stars).toBe(4);
    expect(view.ratingLabel).toBe("优秀");
  });

  it("B 生：无行为与作业数据时对应胶囊/亮点/时间线缺省，成绩仍出", async () => {
    const view = await aggregateEvalCard(studentB, {
      start: "2026-09-01",
      end: "2026-09-30",
      label: "09.01 – 09.30",
    });
    expect(view.score?.rankNote).toBe("总分较上次提高 6 分，班级第 2 名（共 2 人）");
    expect(view.tags).toEqual([]);
    expect(view.moments).toEqual([]);
    expect(view.chips.some((c) => c.key === "behavior")).toBe(false);
    expect(view.chips.some((c) => c.key === "homework")).toBe(false);
    expect(view.chips.some((c) => c.key === "study")).toBe(true);
    expect(view.comment).toBe("");
  });

  it("文件名：学生名 + 周期标签，去掉空白", () => {
    expect(evalCardFileName({ name: "李梓涵", periodLabel: "09.01 – 09.30" })).toBe(
      "评价卡片-李梓涵-09.01–09.30"
    );
  });
});

describe("buildEvalCardHtml 模板", () => {
  const baseView: EvalCardView = {
    name: '张三<script>alert(1)</script>"',
    className: "三年二班",
    avatarChar: "三",
    periodLabel: "2026 年 9 月",
    stars: 4,
    ratingLabel: "优秀",
    chips: [{ key: "study", label: "学习", value: "95" }],
    score: {
      title: "9月月考",
      subtitle: "2026-09-25 · 班级第 1 名",
      subjects: [
        { subject: "语文", score: 92 },
        { subject: "数学", score: 98 },
      ],
      rankNote: "总分较上次提高 5 分，班级第 1 名（共 2 人）",
      noteTone: "up",
    },
    tags: ["课堂发言 ×3"],
    moments: [{ date: "09-26", text: "连续一周作业全对" }],
    comment: "继续保持专注。",
    teacherName: "王老师",
    dateLabel: "2026 年 10 月 3 日",
  };

  it("用户输入全部转义，脚本标签不可直插", () => {
    const html = buildEvalCardHtml(baseView, { watermark: true, comment: "保持</textarea><b>专注" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("</textarea><b>专注");
  });

  it("水印开关：开时有平铺层且含学生名，关时无水印层", () => {
    const withWm = buildEvalCardHtml(baseView, { watermark: true, comment: "" });
    expect(withWm).toContain('class="wm"');
    expect(withWm).toContain(watermarkStyleValue(baseView.name));
    const withoutWm = buildEvalCardHtml(baseView, { watermark: false, comment: "" });
    expect(withoutWm).not.toContain('class="wm"');
    expect(withoutWm).toContain("background-image: none;");
  });

  it("星级渲染：4 星 = 4 实 1 空；成绩条宽度按分数", () => {
    const html = buildEvalCardHtml(baseView, { watermark: false, comment: "" });
    expect(html.match(/class="on"/g)).toHaveLength(4);
    expect(html.match(/class="off"/g)).toHaveLength(1);
    expect(html).toContain('style="width:92%"');
    expect(html).toContain('style="width:98%"');
  });

  it("空寄语隐藏寄语区；无成绩对象隐藏成绩区", () => {
    const noComment = buildEvalCardHtml(baseView, { watermark: false, comment: "   " });
    expect(noComment).not.toContain("老师想对你说");
    const noScore = buildEvalCardHtml({ ...baseView, score: null }, { watermark: false, comment: "" });
    expect(noScore).not.toContain("📊");
    expect(noScore).toContain("亮点时刻");
  });
});

describe("buildForeignObjectSvg 组装", () => {
  it("含 foreignObject / xhtml 命名空间 / 尺寸与样式", () => {
    const svg = buildForeignObjectSvg('<div class="card">hi</div>', ".x { color: red }", 750, 1240);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="750" height="1240">');
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain(".x { color: red }");
    expect(svg).toContain('<div class="card">hi</div>');
  });
});
