import { describe, expect, it } from "vitest";
import { parseRosterTable } from "../src/lib/roster";
import {
  detectScoreSheet,
  extractExamDate,
  extractExamName,
  normalizeSubjectName,
  parseScoreCell,
  prepareScoreRows,
  runSmartScoreImport,
} from "../src/lib/scores";
import {
  createStudent,
  deleteExam,
  deleteStudent,
  getExamScores,
  listExamsByClass,
  listStudentExamScores,
  listStudents,
} from "../src/lib/db";
import { localDateStr } from "../src/lib/format";
import type { AiConfig } from "../src/lib/ai";
import type { AgentLlm } from "../src/agent/types";

/** 未配置模型：识别只走规则 */
const NO_AI_CONFIG: AiConfig = {
  provider: "openai",
  model: "test",
  apiKey: "",
  baseUrl: "",
  temperature: 0,
  systemPrompt: "",
};

const AI_CONFIG: AiConfig = { ...NO_AI_CONFIG, apiKey: "test-key" };

/** 带标题行 + 汇总列的成绩单（典型班主任手上的表） */
const SCORE_SHEET = [
  "三年级二班2026年秋季期中考试成绩单",
  "姓名,学号,语文,数学,英语,总分",
  "林一,9901,95,88,92,275",
  "王二,9902,85,90.5,78,253.5",
  "李三,9903,缺考,70,0,70",
].join("\n");

/** 无关表格：普通花名册（不应识别为成绩单） */
const ROSTER_LIKE = [
  "姓名,性别,学号,监护人电话,年级班级",
  "张小三,男,9801,13800128846,三年级二班",
  "李小红,女,9802,13988772310,三年级二班",
].join("\n");

const TEST_CLASS = "成绩测试班A";

async function cleanupTestClass() {
  for (const s of await listStudents()) {
    if (s.grade_class === TEST_CLASS) await deleteStudent(s.id);
  }
  for (const e of await listExamsByClass(TEST_CLASS)) {
    await deleteExam(e.id);
  }
}

describe("normalizeSubjectName / parseScoreCell", () => {
  it("normalizes subject headers and rejects derived columns", () => {
    expect(normalizeSubjectName("数学成绩")).toBe("数学");
    expect(normalizeSubjectName("英语 ")).toBe("英语");
    expect(normalizeSubjectName("数学")).toBe("数学");
    expect(normalizeSubjectName("总分")).toBeNull();
    expect(normalizeSubjectName("班级排名")).toBeNull();
    expect(normalizeSubjectName("")).toBeNull();
  });

  it("parses numeric scores, text grades and skips empty cells", () => {
    expect(parseScoreCell("95")).toEqual({ score: 95, grade: null });
    expect(parseScoreCell("90.5")).toEqual({ score: 90.5, grade: null });
    expect(parseScoreCell("92分")).toEqual({ score: 92, grade: null });
    expect(parseScoreCell("缺考")).toEqual({ score: null, grade: "缺考" });
    expect(parseScoreCell("优")).toEqual({ score: null, grade: "优" });
    expect(parseScoreCell("")).toEqual({ score: null, grade: null });
    // 长数字（学号/年份）不是成绩
    expect(parseScoreCell("20240001").score).toBeNull();
    expect(parseScoreCell("2017").score).toBeNull();
  });
});

describe("extractExamName / extractExamDate", () => {
  it("extracts exam name from title lines and strips sheet suffixes", () => {
    expect(extractExamName(["三年级二班2026年秋季期中考试成绩单"])).toBe(
      "三年级二班2026年秋季期中考试"
    );
    expect(extractExamName(["期末考试分数表"])).toBe("期末考试");
    expect(extractExamName(["三年级二班花名册"])).toBeNull();
  });

  it("extracts exam date in several formats", () => {
    expect(extractExamDate(["2026-09-01 开学考试"])).toBe("2026-09-01");
    expect(extractExamDate(["2026年9月1日期中考试"])).toBe("2026-09-01");
    expect(extractExamDate(["考试时间 20260901"])).toBe("2026-09-01");
    expect(extractExamDate(["期中考试成绩单"])).toBeNull();
  });
});

describe("detectScoreSheet", () => {
  it("detects name column, subject columns and exam meta from a typical sheet", () => {
    const detection = detectScoreSheet(parseRosterTable(SCORE_SHEET))!;
    expect(detection).not.toBeNull();
    expect(detection.nameColumn).toBe(0);
    expect(detection.studentNoColumn).toBe(1);
    expect(detection.subjects.map((s) => s.name)).toEqual(["语文", "数学", "英语"]);
    expect(detection.subjects.every((s) => s.from === "header")).toBe(true);
    // 总分列是汇总列，不作为科目
    expect(detection.subjects.some((s) => s.header.includes("总分"))).toBe(false);
    expect(detection.examName).toBe("三年级二班2026年秋季期中考试");
    expect(detection.confidence).toBe("high");
  });

  it("falls back to content heuristics for headerless sheets", () => {
    const table = parseRosterTable("张三,95,88\n李四,77,80\n王五,60,90");
    const detection = detectScoreSheet(table)!;
    expect(detection.nameColumn).toBe(0);
    // 无表头表格合成「第N列」，直接作为科目名
    expect(detection.subjects.map((s) => s.name)).toEqual(["第2列", "第3列"]);
    expect(detection.subjects.every((s) => s.from === "content")).toBe(true);
  });

  it("reads exam date from a 考试日期 column", () => {
    const table = parseRosterTable(
      "姓名,考试日期,语文\n张三,2026-06-25,90\n李四,2026-06-25,88"
    );
    const detection = detectScoreSheet(table)!;
    expect(detection.examDate).toBe("2026-06-25");
  });

  it("returns null for roster-like tables", () => {
    expect(detectScoreSheet(parseRosterTable(ROSTER_LIKE))).toBeNull();
  });

  it("does not treat phone / id columns as subjects", () => {
    const table = parseRosterTable(
      "姓名,电话,身份证号\n张三,13800128846,330106201705120011\n李四,13988772310,330106201708030022"
    );
    expect(detectScoreSheet(table)).toBeNull();
  });
});

describe("prepareScoreRows", () => {
  it("keeps text grades, skips empty subject cells and reports empty names", () => {
    const detection = detectScoreSheet(parseRosterTable(SCORE_SHEET))!;
    const prep = prepareScoreRows(parseRosterTable(SCORE_SHEET), detection);
    expect(prep.rows).toHaveLength(3);

    const lin = prep.rows.find((r) => r.name === "林一")!;
    expect(lin.student_no).toBe("9901");
    expect(lin.scores).toEqual([
      { subject: "语文", score: 95, grade: null },
      { subject: "数学", score: 88, grade: null },
      { subject: "英语", score: 92, grade: null },
    ]);

    const li = prep.rows.find((r) => r.name === "李三")!;
    expect(li.scores).toEqual([
      { subject: "语文", score: null, grade: "缺考" },
      { subject: "数学", score: 70, grade: null },
      { subject: "英语", score: 0, grade: null },
    ]);

    const withEmptyName = parseRosterTable("姓名,语文\n,90\n张三,88");
    const prep2 = prepareScoreRows(withEmptyName, detectScoreSheet(withEmptyName)!);
    expect(prep2.rows).toHaveLength(1);
    expect(prep2.issues[0].reason).toContain("姓名为空");
  });
});

describe("runSmartScoreImport", () => {
  it("creates the exam batch, auto-enrolls students and writes scores", async () => {
    await cleanupTestClass();
    try {
      const outcome = await runSmartScoreImport(parseRosterTable(SCORE_SHEET), {
        className: TEST_CLASS,
        config: NO_AI_CONFIG,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok" || !outcome.result) return;

      // 考试名来自标题行，时间缺省为今天
      expect(outcome.exam.name).toBe("三年级二班2026年秋季期中考试");
      expect(outcome.exam.exam_date).toBe(localDateStr());
      expect(outcome.examCreated).toBe(true);

      // 成绩单即花名册：3 名学生全部自动建档，学号沿用成绩单里的
      const { result } = outcome;
      expect(result.students_created).toBe(3);
      expect(result.students_matched).toBe(0);
      expect(result.scores_written).toBe(9); // 3 人 × 3 科（缺考也是一条）
      expect(result.skipped).toHaveLength(0);

      const students = (await listStudents()).filter((s) => s.grade_class === TEST_CLASS);
      expect(students).toHaveLength(3);
      const wangEr = students.find((s) => s.student_no === "9902")!;
      const scores = await listStudentExamScores(wangEr.id);
      expect(scores).toHaveLength(3);
      expect(scores.every((s) => s.exam_name === "三年级二班2026年秋季期中考试")).toBe(true);
      const math = scores.find((s) => s.subject === "数学")!;
      expect(math.score).toBe(90.5);

      // 重导同一份成绩单：复用批次、只更新成绩、不重复建档
      const outcome2 = await runSmartScoreImport(parseRosterTable(SCORE_SHEET), {
        className: TEST_CLASS,
        config: NO_AI_CONFIG,
      });
      expect(outcome2.status).toBe("ok");
      if (outcome2.status !== "ok" || !outcome2.result) return;
      expect(outcome2.examCreated).toBe(false);
      expect(outcome2.exam.id).toBe(outcome.exam.id);
      expect(outcome2.result.students_created).toBe(0);
      expect(outcome2.result.students_matched).toBe(3);
      expect(outcome2.result.scores_written).toBe(9);
    } finally {
      await cleanupTestClass();
    }
  });

  it("matches existing students by student number and updates their scores", async () => {
    await cleanupTestClass();
    try {
      await createStudent({
        name: "林一",
        gender: "女",
        birth_date: null,
        student_no: "9901",
        grade_class: TEST_CLASS,
        id_card: null,
        address: null,
        status: "active",
        note: null,
        guardians: [],
      });

      const outcome = await runSmartScoreImport(parseRosterTable(SCORE_SHEET), {
        className: TEST_CLASS,
        config: NO_AI_CONFIG,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok" || !outcome.result) return;
      expect(outcome.result.students_created).toBe(2);
      expect(outcome.result.students_matched).toBe(1);
      expect(outcome.result.scores_written).toBe(9);

      const lin = (await listStudents()).find((s) => s.student_no === "9901")!;
      expect(lin.gender).toBe("女"); // 已有学生不会被成绩单覆盖性别等档案字段
      const scores = await listStudentExamScores(lin.id);
      expect(scores.find((s) => s.subject === "语文")?.score).toBe(95);
    } finally {
      await cleanupTestClass();
    }
  });

  it("rejects tables that are not score sheets", async () => {
    const outcome = await runSmartScoreImport(parseRosterTable(ROSTER_LIKE), {
      config: NO_AI_CONFIG,
    });
    expect(outcome.status).toBe("not-score-sheet");
  });

  it("asks for the name column when detection is not confident", async () => {
    // 同名重复（列内几乎不唯一）→ 姓名列内容置信度低，但科目列可识别
    const table = parseRosterTable("张三,95,88\n张三,88,77\n张三,77,66\n张三,66,55");
    const outcome = await runSmartScoreImport(table, { config: NO_AI_CONFIG });
    expect(outcome.status).toBe("need-column");
    if (outcome.status !== "need-column") return;
    expect(outcome.message).toContain("name_column");

    // 用户指定姓名列后可继续导入
    const pinned = await runSmartScoreImport(table, {
      config: NO_AI_CONFIG,
      nameColumn: 1,
      examName: "单元测验",
      examDate: "2026-06-20",
      className: TEST_CLASS,
      autoCreateStudents: false,
    });
    expect(pinned.status).toBe("ok");
    if (pinned.status === "ok") {
      expect(pinned.exam.name).toBe("单元测验");
      expect(pinned.exam.exam_date).toBe("2026-06-20");
    }
    if (pinned.status === "ok" && pinned.exam.id) await deleteExam(pinned.exam.id);
  });

  it("combines AI structure detection with rule results", async () => {
    await cleanupTestClass();
    try {
      // 模型：修正科目名（表头含「成绩」）、补出考试名与时间
      const llm: AgentLlm = {
        chat: async () => ({
          content:
            '{"name_column":1,"subjects":[{"column":3,"name":"数学"},{"column":2,"name":"语文"}],' +
            '"exam_name":"期末考试","exam_date":"2026-06-20","confidence":0.9,"reason":"表头明确"}',
          toolCalls: [],
        }),
      };
      const table = parseRosterTable("姓名,语文,数学\n张三,90,85\n李四,80,70");
      const outcome = await runSmartScoreImport(table, {
        className: TEST_CLASS,
        config: AI_CONFIG,
        llm,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.exam.name).toBe("期末考试");
      expect(outcome.exam.exam_date).toBe("2026-06-20");
      expect(outcome.detection.subjects.map((s) => s.name)).toEqual(["语文", "数学"]);
      // AI 置信度高 → 综合置信度高
      expect(outcome.detection.confidence).toBe("high");
    } finally {
      await cleanupTestClass();
    }
  });

  it("skips unknown students when auto-enroll is off", async () => {
    await cleanupTestClass();
    try {
      const outcome = await runSmartScoreImport(parseRosterTable(SCORE_SHEET), {
        className: TEST_CLASS,
        config: NO_AI_CONFIG,
        autoCreateStudents: false,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok" || !outcome.result) return;
      expect(outcome.result.scores_written).toBe(0);
      expect(outcome.result.skipped).toHaveLength(3);
      expect(outcome.result.skipped[0].reason).toContain("找不到该学生");
    } finally {
      await cleanupTestClass();
    }
  });

  it("guards against mismatched student numbers like roster import", async () => {
    await cleanupTestClass();
    try {
      // 9901 已对应「林一号」：成绩单里「林一」的 9901 行不应覆盖到他人头上
      await createStudent({
        name: "林一号",
        gender: "男",
        birth_date: null,
        student_no: "9901",
        grade_class: TEST_CLASS,
        id_card: null,
        address: null,
        status: "active",
        note: null,
        guardians: [],
      });
      const outcome = await runSmartScoreImport(parseRosterTable(SCORE_SHEET), {
        className: TEST_CLASS,
        config: NO_AI_CONFIG,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok" || !outcome.result) return;
      expect(outcome.result.skipped.some((s) => s.reason.includes("姓名不一致"))).toBe(true);
      // 林一号没有成绩，林一/王二/李三 建档后正常写入
      const linYiHao = (await listStudents()).find((s) => s.name === "林一号")!;
      expect((await getExamScores(outcome.exam.id)).some((r) => r.student_id === linYiHao.id)).toBe(false);
    } finally {
      await cleanupTestClass();
    }
  });
});
