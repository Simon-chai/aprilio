import { describe, expect, it } from "vitest";
import {
  aiDetectNameColumn,
  aiInferClassName,
  combineNameDetection,
  decodeRosterBytes,
  detectFieldMapping,
  detectNameColumn,
  findNameColumnByHeader,
  importRosterStudents,
  isTableSpreadsheet,
  isUnnamedBatch,
  parseRosterTable,
  prepareRosterRows,
  rosterTableFromGrid,
  rosterTemplateCsv,
  runSmartImport,
  runSmartImportTable,
  suggestUnnamedClassName,
  validateTemplateTable,
  UNNAMED_CLASS_PREFIX,
} from "../src/lib/roster";
import { deleteClass, deleteStudent, listStudents } from "../src/lib/db";
import type { AiConfig } from "../src/lib/ai";
import type { AgentLlm, NameDetection } from "../src/agent/types";

const ctx = { router: {} as never };

/** 未配置模型：runSmartImport / aiDetect 只走规则识别 */
const NO_AI_CONFIG: AiConfig = {
  provider: "openai",
  model: "test",
  apiKey: "",
  baseUrl: "",
  temperature: 0,
  systemPrompt: "",
};

const AI_CONFIG: AiConfig = { ...NO_AI_CONFIG, apiKey: "test-key" };

const TEMPLATE_TEXT = [
  "姓名,性别,学号,出生日期,年级班级,监护人,联系电话",
  "张小三,男,9000001,2017-05-12,三年级二班,张建国,13800128846",
  "李小红,女,9000002,2017.8.3,三年级二班,李大红,13988772310",
].join("\n");

/** 清理导入测试产生的学生，保持内存库对其他用例无污染 */
async function cleanupByNos(nos: string[]) {
  const set = new Set(nos);
  const all = await listStudents();
  for (const s of all) {
    if (set.has(s.student_no)) await deleteStudent(s.id);
  }
}

describe("parseRosterTable", () => {
  it("parses CSV with header, quoted cells and CRLF", () => {
    const text = '姓名,备注\r\n"张三, Jr.",你好\r\n李四,"说""嗨"""';
    const table = parseRosterTable(text);
    expect(table.hasHeader).toBe(true);
    expect(table.headers).toEqual(["姓名", "备注"]);
    expect(table.rows).toEqual([
      ["张三, Jr.", "你好"],
      ["李四", '说"嗨"'],
    ]);
  });

  it("sniffs semicolon and tab delimiters", () => {
    expect(parseRosterTable("姓名;学号\n张三;1").delimiter).toBe(";");
    expect(parseRosterTable("姓名\t学号\n张三\t1").delimiter).toBe("\t");
  });

  it("strips BOM and skips blank lines", () => {
    const table = parseRosterTable("\uFEFF姓名,学号\n\n张三,1\n\n");
    expect(table.headers).toEqual(["姓名", "学号"]);
    expect(table.rows).toEqual([["张三", "1"]]);
  });

  it("synthesizes headers when the first row looks like data", () => {
    const table = parseRosterTable("张三,男,20240001\n李四,女,20240002");
    expect(table.hasHeader).toBe(false);
    expect(table.headers).toEqual(["第1列", "第2列", "第3列"]);
    expect(table.rows).toHaveLength(2);
  });

  it("rejects empty content", () => {
    expect(() => parseRosterTable("   \n  ")).toThrow(/为空/);
  });
});

describe("decodeRosterBytes", () => {
  it("decodes UTF-8 first", () => {
    const bytes = new TextEncoder().encode("姓名,张三");
    expect(decodeRosterBytes(bytes.buffer as ArrayBuffer)).toEqual({
      text: "姓名,张三",
      encoding: "utf-8",
    });
  });

  it("falls back to GBK for non-UTF-8 bytes", () => {
    // 「中文」的 GBK 字节（D6D0 CEC4），不是合法 UTF-8
    const buffer = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer;
    expect(decodeRosterBytes(buffer as ArrayBuffer)).toEqual({ text: "中文", encoding: "gbk" });
  });
});

describe("detectNameColumn", () => {
  it("prefers the column whose header is 姓名", () => {
    const table = parseRosterTable(TEMPLATE_TEXT);
    const detection = detectNameColumn(table);
    expect(detection.selected).toBe(0);
    expect(detection.confidence).toBe("high");
    expect(detection.method).toBe("rule");
  });

  it("uses content heuristics when there is no header", () => {
    const table = parseRosterTable("张三,男,13800128846,三年级二班\n李四,女,13988772310,三年级二班\n王五,男,13600001111,三年级二班");
    const detection = detectNameColumn(table);
    expect(detection.selected).toBe(0);
    expect(detection.candidates[0].reason).toContain("中文姓名");
  });

  it("does not pick phone / date / class columns", () => {
    const table = parseRosterTable(
      "联系电话,出生日期,年级班级,姓名\n13800128846,2017-05-12,三年级二班,张三\n13988772310,2017-08-03,三年级二班,李四",
    );
    const detection = detectNameColumn(table);
    expect(detection.selected).toBe(3);
  });
});

describe("detectFieldMapping", () => {
  it("maps fields by header keywords and keeps 家长电话 as phone", () => {
    const table = parseRosterTable("姓名,学号,性别,出生日期,年级班级,家长电话,监护人,家庭住址,备注\n张三,1,男,2017-05-12,三二班,138,张爸,某路,转学");
    const mapping = detectFieldMapping(table, 0);
    expect(mapping.fields.student_no).toBe(1);
    expect(mapping.fields.gender).toBe(2);
    expect(mapping.fields.birth_date).toBe(3);
    expect(mapping.fields.grade_class).toBe(4);
    expect(mapping.fields.guardian_phone).toBe(5);
    expect(mapping.fields.guardian_name).toBe(6);
    expect(mapping.fields.address).toBe(7);
    expect(mapping.fields.note).toBe(8);
  });
});

describe("prepareRosterRows", () => {
  it("normalizes gender and dates, keeps optional fields", () => {
    const table = parseRosterTable(TEMPLATE_TEXT);
    const mapping = detectFieldMapping(table, 0);
    const prep = prepareRosterRows(table, mapping);
    expect(prep.issues).toEqual([]);
    expect(prep.rows[0]).toMatchObject({
      name: "张小三",
      gender: "男",
      birth_date: "2017-05-12",
      student_no: "9000001",
      grade_class: "三年级二班",
    });
    // 2017.8.3 → 2017-08-03
    expect(prep.rows[1].birth_date).toBe("2017-08-03");
    expect(prep.rows[1].gender).toBe("女");
  });

  it("reports rows with missing name or in-file duplicate student_no", () => {
    const table = parseRosterTable(
      "姓名,学号\n,9000001\n李四,9000002\n王五,9000002",
    );
    const prep = prepareRosterRows(table, detectFieldMapping(table, 0));
    expect(prep.rows.map((r) => r.name)).toEqual(["李四"]);
    expect(prep.issues).toEqual([
      { row: 2, name: "", reason: "姓名为空" },
      { row: 4, name: "王五", reason: "学号 9000002 在表内重复" },
    ]);
  });
});

describe("importRosterStudents", () => {
  const nos = ["9000011", "9000012"];

  it("imports new students and overwrites same name+no records on re-import", async () => {
    await cleanupByNos(nos);
    try {
      const first = parseRosterTable(TEMPLATE_TEXT.replace(/9000001/g, "9000011").replace(/9000002/g, "9000012"));
      const prep = prepareRosterRows(first, detectFieldMapping(first, 0));
      const result = await importRosterStudents(prep);
      expect(result.imported).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.skipped).toEqual([]);

      // 重复导入同一文件：姓名与学号均相同 → 覆盖更新，不产生重复学生，记录 id 不变
      const before = (await listStudents()).filter((s) => nos.includes(s.student_no));
      const again = await importRosterStudents(prep);
      expect(again.imported).toBe(0);
      expect(again.updated).toBe(2);
      expect(again.skipped).toEqual([]);
      const after = (await listStudents()).filter((s) => nos.includes(s.student_no));
      expect(after).toHaveLength(2);
      expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    } finally {
      await cleanupByNos(nos);
    }
  });

  it("overwrites fields with the newly uploaded data for same name+no", async () => {
    const no = "9000013";
    await cleanupByNos([no]);
    try {
      const v1 = parseRosterTable("姓名,学号,出生日期,监护人,联系电话\n覆盖测试生,9000013,2017-01-01,旧监护人,13800000001");
      await importRosterStudents(prepareRosterRows(v1, detectFieldMapping(v1, 0)));

      const v2 = parseRosterTable("姓名,学号,出生日期,监护人,联系电话\n覆盖测试生,9000013,2017-02-02,新监护人,13800000002");
      const result = await importRosterStudents(prepareRosterRows(v2, detectFieldMapping(v2, 0)));
      expect(result.updated).toBe(1);
      expect(result.imported).toBe(0);

      const [s] = (await listStudents()).filter((x) => x.student_no === no);
      expect(s.birth_date).toBe("2017-02-02");
      expect(s.guardians[0].name).toBe("新监护人");
      expect(s.guardians[0].phone).toBe("13800000002");
    } finally {
      await cleanupByNos([no]);
    }
  });

  it("skips same student_no with different name instead of overwriting", async () => {
    const no = "9000014";
    await cleanupByNos([no]);
    try {
      const v1 = parseRosterTable("姓名,学号\n学号占用者,9000014");
      await importRosterStudents(prepareRosterRows(v1, detectFieldMapping(v1, 0)));
      const before = (await listStudents()).find((s) => s.student_no === no);

      const v2 = parseRosterTable("姓名,学号\n冒名顶替者,9000014");
      const result = await importRosterStudents(prepareRosterRows(v2, detectFieldMapping(v2, 0)));
      expect(result.imported).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.skipped[0].reason).toContain("姓名不一致");

      // 原记录未被改动
      const after = (await listStudents()).find((s) => s.student_no === no);
      expect(after?.id).toBe(before?.id);
      expect(after?.name).toBe("学号占用者");
    } finally {
      await cleanupByNos([no]);
    }
  });

  it("generates student_no when the column is absent and skips same name+birth", async () => {
    const table = parseRosterTable("姓名,出生日期\n导入测试甲,2018-01-01\n导入测试乙,2018-01-02");
    const prep = prepareRosterRows(table, detectFieldMapping(table, 0));
    const result = await importRosterStudents(prep);
    expect(result.imported).toBe(2);

    try {
      const all = await listStudents();
      const created = all.filter((s) => s.name.startsWith("导入测试"));
      expect(created.every((s) => /^R\d+/.test(s.student_no))).toBe(true);

      // 无学号时按「姓名+出生日期」兜底去重
      const again = await importRosterStudents(prep);
      expect(again.imported).toBe(0);
      expect(again.skipped).toHaveLength(2);
    } finally {
      const all = await listStudents();
      for (const s of all.filter((s) => s.name.startsWith("导入测试"))) await deleteStudent(s.id);
    }
  });
});

describe("combineNameDetection", () => {
  const rule: NameDetection = {
    candidates: [
      { index: 0, header: "姓名", score: 110, confidence: "high", reason: "表头为姓名字段" },
      { index: 2, header: "名字?", score: 35, confidence: "medium", reason: "表头疑似姓名字段" },
    ],
    selected: 0,
    confidence: "high",
    method: "rule",
    reason: "表头为姓名字段",
  };

  it("keeps rule result when AI is unavailable", () => {
    expect(combineNameDetection(rule, null).method).toBe("rule");
  });

  it("trusts AI choice and calibrates confidence with rule agreement", () => {
    const combined = combineNameDetection(rule, { index: 2, confidence: 0.9, reason: "表头含义" });
    expect(combined.method).toBe("ai");
    expect(combined.selected).toBe(2);
    expect(combined.confidence).toBe("high");
    expect(combined.candidates[0].index).toBe(2);
  });

  it("downgrades confidence when AI picks a column the rule marked as non-name", () => {
    const combined = combineNameDetection(rule, { index: 4, confidence: 0.9, reason: "" });
    expect(combined.selected).toBe(4);
    expect(combined.confidence).toBe("low");
  });
});

describe("aiDetectNameColumn", () => {
  it("parses the model JSON answer", async () => {
    const llm: AgentLlm = {
      async chat() {
        return { content: '好的，结果是 {"column": 3, "confidence": 0.9, "reason": "表头为姓名"}', toolCalls: [] };
      },
    };
    const table = parseRosterTable("序号,学号,姓名\n1,01,张三");
    const ai = await aiDetectNameColumn(table, llm, AI_CONFIG);
    expect(ai).toEqual({ index: 2, confidence: 0.9, reason: "表头为姓名" });
  });

  it("returns null on malformed model output or out-of-range column", async () => {
    const bad: AgentLlm = { async chat() { return { content: "我觉得是姓名那一列", toolCalls: [] }; } };
    const outOfRange: AgentLlm = { async chat() { return { content: '{"column": 9}', toolCalls: [] }; } };
    const table = parseRosterTable("序号,学号,姓名\n1,01,张三");
    expect(await aiDetectNameColumn(table, bad, AI_CONFIG)).toBeNull();
    expect(await aiDetectNameColumn(table, outOfRange, AI_CONFIG)).toBeNull();
  });
});

/** 假模型：固定返回一段文本，用于班级推断用例 */
const llmWith = (content: string): AgentLlm => ({
  async chat() {
    return { content, toolCalls: [] };
  },
});

describe("aiInferClassName", () => {
  it("extracts the class name from the filename context", async () => {
    const llm = llmWith('{"class_name": "四8班", "confidence": 0.9, "reason": "文件名含班级"}');
    expect(await aiInferClassName(["四8班学生详细信息_模拟数据.xlsx"], llm, AI_CONFIG)).toBe("四8班");
  });

  it("rejects answers that do not look like a class name", async () => {
    // 不带「班」的文本不是班级名；超长文本视为幻觉；泛称与无法解析的回复直接放弃
    expect(await aiInferClassName(["学生详细信息.xlsx"], llmWith('{"class_name": "四年级"}'), AI_CONFIG)).toBeNull();
    expect(
      await aiInferClassName(["学生详细信息.xlsx"], llmWith('{"class_name": "一个特别特别特别特别长的班级名"}'), AI_CONFIG),
    ).toBeNull();
    expect(await aiInferClassName(["学生详细信息.xlsx"], llmWith('{"class_name": "多个班级"}'), AI_CONFIG)).toBeNull();
    expect(await aiInferClassName(["学生详细信息.xlsx"], llmWith("没有班级信息"), AI_CONFIG)).toBeNull();
  });

  it("returns null without context and does not call the model", async () => {
    let called = false;
    const llm: AgentLlm = {
      async chat() {
        called = true;
        return { content: "{}", toolCalls: [] };
      },
    };
    expect(await aiInferClassName([null, "  "], llm, AI_CONFIG)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("runSmartImport", () => {
  it("previews without writing (dryRun) and imports on the second run", async () => {
    const nos = ["9000021", "9000022"];
    await cleanupByNos(nos);
    try {
      const text = TEMPLATE_TEXT.replace(/9000001/g, "9000021").replace(/9000002/g, "9000022");

      const preview = await runSmartImport(text, { config: NO_AI_CONFIG, dryRun: true });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") return;
      expect(preview.detection.selected).toBe(0);
      expect(preview.result).toBeUndefined();
      expect((await listStudents()).filter((s) => nos.includes(s.student_no))).toHaveLength(0);

      const done = await runSmartImport(text, { config: NO_AI_CONFIG });
      expect(done.status).toBe("ok");
      if (done.status !== "ok") return;
      expect(done.result?.imported).toBe(2);
      expect(done.detection.method).toBe("rule");
      expect((await listStudents()).filter((s) => nos.includes(s.student_no))).toHaveLength(2);
    } finally {
      await cleanupByNos(nos);
    }
  });

  it("uses the AI answer for name column detection when configured", async () => {
    // 表头不含「姓名」关键词 → 规则只能靠内容；AI 指定第 3 列并命中规则候选
    const llm: AgentLlm = {
      async chat() {
        return { content: '{"column": 3, "confidence": 0.95, "reason": "内容为姓名"}', toolCalls: [] };
      },
    };
    const preview = await runSmartImport("序号,学号,学生姓名\n1,01,张三\n2,02,李四", {
      config: AI_CONFIG,
      llm,
      dryRun: true,
    });
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") return;
    expect(preview.detection.method).toBe("ai");
    expect(preview.detection.selected).toBe(2);
    expect(preview.mapping.nameColumn).toBe(2);
  });

  it("returns need-column with candidates when detection is not confident", async () => {
    // 全是数字的表：没有任何列像姓名
    const outcome = await runSmartImport("编号,金额\n1,100\n2,200", { config: NO_AI_CONFIG });
    expect(outcome.status).toBe("need-column");
    if (outcome.status !== "need-column") return;
    expect(outcome.message).toContain("name_column");
  });

  it("accepts a user-pinned name column (name text or 1-based index)", async () => {
    const nos = ["9000031"];
    await cleanupByNos(nos);
    try {
      const done = await runSmartImport("学号,学生姓名\n9000031,钉钉子", {
        config: NO_AI_CONFIG,
        nameColumn: "学生姓名",
      });
      expect(done.status).toBe("ok");

      const byIndex = await runSmartImport("学号,学生\n9000032,钉二号", {
        config: NO_AI_CONFIG,
        nameColumn: 2,
        dryRun: true,
      });
      expect(byIndex.status).toBe("ok");
    } finally {
      await cleanupByNos(nos);
    }
  });

  it("errors on unparseable content or unknown column spec", async () => {
    expect((await runSmartImport("", { config: NO_AI_CONFIG })).status).toBe("error");
    const outcome = await runSmartImport(TEMPLATE_TEXT, { config: NO_AI_CONFIG, nameColumn: "不存在列" });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") expect(outcome.message).toContain("可用列");
  });

  it("整批无班级信息时按文件名推断班级（如「四8班」），不再自动建未命名班级", async () => {
    const nos = ["9000051", "9000052"];
    const cls = "四8班";
    await cleanupByNos(nos);
    try {
      const text = "姓名,学号\n推断甲,9000051\n推断乙,9000052";
      const llm = llmWith('{"class_name": "四8班", "confidence": 0.9, "reason": "文件名含班级"}');

      const preview = await runSmartImport(text, {
        fileName: "四8班学生详细信息_模拟数据.xlsx",
        nameColumn: "姓名",
        config: AI_CONFIG,
        llm,
        dryRun: true,
      });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") return;
      expect(preview.inferredClass).toBe(cls);

      const done = await runSmartImport(text, {
        fileName: "四8班学生详细信息_模拟数据.xlsx",
        nameColumn: "姓名",
        config: AI_CONFIG,
        llm,
      });
      expect(done.status).toBe("ok");
      if (done.status !== "ok") return;
      expect(done.result?.imported).toBe(2);
      expect(done.result?.autoClass ?? null).toBeNull();
      const students = (await listStudents()).filter((s) => nos.includes(s.student_no));
      expect(students.map((s) => s.grade_class)).toEqual([cls, cls]);
    } finally {
      await cleanupByNos(nos);
      try {
        await deleteClass(cls);
      } catch {
        /* 忽略 */
      }
    }
  });

  it("模型推不出班级时保持未命名批次自动分班", async () => {
    const nos = ["9000053"];
    await cleanupByNos(nos);
    let created: string | null = null;
    try {
      const llm = llmWith('{"class_name": null, "confidence": 0, "reason": "无班级线索"}');
      const done = await runSmartImport("姓名,学号\n推断丙,9000053", {
        fileName: "学生详细信息.xlsx",
        nameColumn: "姓名",
        config: AI_CONFIG,
        llm,
      });
      expect(done.status).toBe("ok");
      if (done.status !== "ok") return;
      expect(done.inferredClass ?? null).toBeNull();
      expect(done.result?.autoClass).toMatch(/^未命名班级\d+$/);
      created = done.result?.autoClass ?? null;
    } finally {
      await cleanupByNos(nos);
      if (created) {
        try {
          await deleteClass(created);
        } catch {
          /* 忽略 */
        }
      }
    }
  });
});

describe("rosterTableFromGrid（Rust 表格通道入口）", () => {
  it("sniffs headers on a grid decoded from xlsx", () => {
    const table = rosterTableFromGrid([
      ["姓名", "学号", "出生日期"],
      ["张三", "20240001", "2025-01-01"],
      ["李小红", "20240002", "2017-05-12"],
    ]);
    expect(table.hasHeader).toBe(true);
    expect(table.headers).toEqual(["姓名", "学号", "出生日期"]);
    expect(table.rows).toHaveLength(2);
  });

  it("synthesizes headers for headerless grids and throws on empty", () => {
    const table = rosterTableFromGrid([["张三", "男"]]);
    expect(table.hasHeader).toBe(false);
    expect(table.headers).toEqual(["第1列", "第2列"]);
    expect(() => rosterTableFromGrid([])).toThrow(/为空/);
  });

  it("skips merged title rows above the header and keeps issue row numbers correct", () => {
    const table = rosterTableFromGrid([
      ["XX中学2026级3班花名册"],
      ["姓名", "学号"],
      ["张三", "20240001"],
      ["", "20240002"],
    ]);
    expect(table.hasHeader).toBe(true);
    expect(table.titleRows).toBe(1);
    expect(table.headers).toEqual(["姓名", "学号"]);
    expect(table.rows).toEqual([
      ["张三", "20240001"],
      ["", "20240002"],
    ]);

    const prep = prepareRosterRows(table, detectFieldMapping(table, 0));
    expect(prep.rows.map((r) => r.name)).toEqual(["张三"]);
    expect(prep.issues[0]).toMatchObject({ row: 4, reason: "姓名为空" });
  });

  it("stays headerless when a data row merely mentions keywords", () => {
    const table = rosterTableFromGrid([
      ["张三", "20240001", "转学手续中"],
      ["李四", "20240002", "电话已更换"],
    ]);
    expect(table.hasHeader).toBe(false);
    expect(table.rows).toHaveLength(2);
  });
});

describe("runSmartImportTable", () => {
  it("imports a grid produced by the Rust table channel", async () => {
    const nos = ["9000041"];
    await cleanupByNos(nos);
    try {
      const table = rosterTableFromGrid([
        ["姓名", "学号", "出生日期"],
        ["表格通道测试", "9000041", "2025-01-01"],
      ]);
      const outcome = await runSmartImportTable(table, { config: NO_AI_CONFIG });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.result?.imported).toBe(1);
      expect(outcome.detection.selected).toBe(0);
    } finally {
      await cleanupByNos(nos);
    }
  });
});

describe("isTableSpreadsheet", () => {
  it("routes Excel formats to the table channel", () => {
    expect(isTableSpreadsheet("D:\\花名册.xlsx")).toBe(true);
    expect(isTableSpreadsheet("C:/r/roster.XLS")).toBe(true);
    expect(isTableSpreadsheet("/tmp/ods名册.ods")).toBe(true);
    expect(isTableSpreadsheet("D:\\花名册.csv")).toBe(false);
    expect(isTableSpreadsheet("D:\\照片.png")).toBe(false);
  });
});

describe("template helpers", () => {
  it("template CSV starts with BOM, has 姓名 header and sample rows", () => {
    const csv = rosterTemplateCsv();
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const table = parseRosterTable(csv.replace(/^\uFEFF/, ""));
    expect(validateTemplateTable(table)).toEqual({ ok: true, missing: [] });
    expect(findNameColumnByHeader(table)).toBe(0);
    expect(table.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("template validation requires the 姓名 column", () => {
    const table = parseRosterTable("学号,性别\n1,男");
    expect(validateTemplateTable(table)).toEqual({ ok: false, missing: ["姓名"] });
    expect(findNameColumnByHeader(table)).toBe(-1);
  });
});

describe("未命名批次自动分班", () => {
  it("suggests the smallest free 未命名班级N", () => {
    expect(suggestUnnamedClassName(new Set())).toBe(`${UNNAMED_CLASS_PREFIX}1`);
    expect(suggestUnnamedClassName(new Set([`${UNNAMED_CLASS_PREFIX}1`]))).toBe(
      `${UNNAMED_CLASS_PREFIX}2`,
    );
    expect(
      suggestUnnamedClassName(new Set([`${UNNAMED_CLASS_PREFIX}1`, `${UNNAMED_CLASS_PREFIX}2`])),
    ).toBe(`${UNNAMED_CLASS_PREFIX}3`);
  });

  it("detects unnamed batches only when every row lacks a class", () => {
    expect(isUnnamedBatch([])).toBe(false);
    expect(isUnnamedBatch([{ grade_class: "" } as never])).toBe(true);
    expect(isUnnamedBatch([{ grade_class: "  " } as never])).toBe(true);
    expect(
      isUnnamedBatch([{ grade_class: "" } as never, { grade_class: "三年级二班" } as never]),
    ).toBe(false);
  });

  async function cleanupNosAndClass(nos: string[], autoClass?: string | null) {
    await cleanupByNos(nos);
    if (autoClass && autoClass !== "未分班") {
      try {
        await deleteClass(autoClass);
      } catch {
        /* 已清理或不存在 */
      }
    }
  }

  it("两次导入互不相交的未命名花名册 → 分成两个班", async () => {
    const nosA = ["9100101", "9100102"];
    const nosB = ["9100201", "9100202"];
    await cleanupByNos([...nosA, ...nosB]);
    let autoA: string | null | undefined;
    let autoB: string | null | undefined;
    try {
      const tableA = parseRosterTable("姓名,学号\n分班甲一,9100101\n分班甲二,9100102");
      const prepA = prepareRosterRows(tableA, detectFieldMapping(tableA, 0));
      expect(prepA.rows.every((r) => !r.grade_class)).toBe(true);
      const resultA = await importRosterStudents(prepA);
      expect(resultA.imported).toBe(2);
      autoA = resultA.autoClass;
      expect(autoA).toMatch(/^未命名班级\d+$/);

      const tableB = parseRosterTable("姓名,学号\n分班乙一,9100201\n分班乙二,9100202");
      const resultB = await importRosterStudents(
        prepareRosterRows(tableB, detectFieldMapping(tableB, 0)),
      );
      expect(resultB.imported).toBe(2);
      autoB = resultB.autoClass;
      expect(autoB).toMatch(/^未命名班级\d+$/);
      expect(autoB).not.toBe(autoA);

      const all = await listStudents();
      const classOf = (no: string) => all.find((s) => s.student_no === no)?.grade_class;
      expect(classOf("9100101")).toBe(autoA);
      expect(classOf("9100102")).toBe(autoA);
      expect(classOf("9100201")).toBe(autoB);
      expect(classOf("9100202")).toBe(autoB);
    } finally {
      await cleanupNosAndClass(nosA, autoA);
      await cleanupNosAndClass(nosB, autoB);
    }
  });

  it("重导入同一未命名花名册 → 复用原班不搬家不新建", async () => {
    const nos = ["9100301", "9100302"];
    await cleanupByNos(nos);
    let autoClass: string | null | undefined;
    try {
      const text = "姓名,学号\n复导入一,9100301\n复导入二,9100302";
      const first = await importRosterStudents(
        prepareRosterRows(parseRosterTable(text), detectFieldMapping(parseRosterTable(text), 0)),
      );
      autoClass = first.autoClass;
      expect(first.imported).toBe(2);
      const before = (await listStudents()).filter((s) => nos.includes(s.student_no));

      const table = parseRosterTable(text);
      const again = await importRosterStudents(
        prepareRosterRows(table, detectFieldMapping(table, 0)),
      );
      expect(again.imported).toBe(0);
      expect(again.updated).toBe(2);
      expect(again.autoClass).toBe(autoClass);

      const after = (await listStudents()).filter((s) => nos.includes(s.student_no));
      expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
      expect(new Set(after.map((s) => s.grade_class)).size).toBe(1);
      expect(after[0].grade_class).toBe(autoClass);
    } finally {
      await cleanupNosAndClass(nos, autoClass);
    }
  });

  it("未命名追增（命中同一原班+新行）→ 新行并入原班", async () => {
    const nos = ["9100401", "9100402", "9100403"];
    await cleanupByNos(nos);
    let autoClass: string | null | undefined;
    try {
      const v1 = parseRosterTable("姓名,学号\n追增一,9100401\n追增二,9100402");
      const r1 = await importRosterStudents(prepareRosterRows(v1, detectFieldMapping(v1, 0)));
      autoClass = r1.autoClass;
      expect(r1.imported).toBe(2);

      const v2 = parseRosterTable("姓名,学号\n追增二,9100402\n追增三,9100403");
      const r2 = await importRosterStudents(prepareRosterRows(v2, detectFieldMapping(v2, 0)));
      expect(r2.updated).toBe(1);
      expect(r2.imported).toBe(1);
      expect(r2.autoClass).toBe(autoClass);

      const all = await listStudents();
      expect(all.find((s) => s.student_no === "9100403")?.grade_class).toBe(autoClass);
    } finally {
      await cleanupNosAndClass(nos, autoClass);
    }
  });

  it("具名批次不触发自动分班（autoClass 为空）", async () => {
    const nos = ["9100501"];
    await cleanupByNos(nos);
    try {
      const table = parseRosterTable("姓名,学号,年级班级\n具名生,9100501,三年级二班");
      const result = await importRosterStudents(
        prepareRosterRows(table, detectFieldMapping(table, 0)),
      );
      expect(result.imported).toBe(1);
      expect(result.autoClass ?? null).toBeNull();
      const [s] = (await listStudents()).filter((x) => x.student_no === "9100501");
      expect(s.grade_class).toBe("三年级二班");
    } finally {
      await cleanupByNos(nos);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 详细花名册：双行分组表头 + 双监护人（学校下发格式）                    */
/* ------------------------------------------------------------------ */

/** 父表头行：监护人1/监护人2 为跨列合并单元格（只有左上角有值） */
const DETAILED_PARENT = [
  "学号", "姓名", "性别", "出生日期", "身份证号", "学籍号", "家庭住址", "籍贯",
  "监护人1", "", "", "", "监护人2", "", "", "", "备注",
];
/** 子表头行：姓名 / 联系电话 / 单位 / 职务 各两组 */
const DETAILED_SUB = [
  "", "", "", "", "", "", "", "",
  "姓名", "联系电话", "单位", "职务", "姓名", "联系电话", "单位", "职务", "",
];
const DETAILED_ROW_FULL = [
  "1", "彭阳博", "男", "2017.04.24", "441322201704241514", "G441322201704241514",
  "广东省鹤山市沙坪街道东升路翠湖花园105号1201房", "广东省鹤山市沙坪镇",
  "彭文", "18539258113", "顺丰速运鹤山营业点", "",
  "邹煜杰", "18819121777", "鹤山市农商银行", "职员",
  "",
];
const DETAILED_ROW_SINGLE = [
  "2", "郭强晨", "男", "2016.02.07", "420704201602070472", "G420704201602070472",
  "广东省鹤山市沙坪街道嘉悦名轩158号202房", "广东省鹤山市沙坪镇",
  "郭彤霞", "13914167867", "", "个体户",
  "", "", "", "",
  "特困",
];

describe("详细花名册：双行分组表头", () => {
  it("合成复合表头并把子表头行排除在数据行之外", () => {
    const table = rosterTableFromGrid([
      DETAILED_PARENT,
      DETAILED_SUB,
      DETAILED_ROW_FULL,
      DETAILED_ROW_SINGLE,
    ]);

    expect(table.hasHeader).toBe(true);
    expect(table.headerRows).toBe(2);
    expect(table.headers).toEqual([
      "学号", "姓名", "性别", "出生日期", "身份证号", "学籍号", "家庭住址", "籍贯",
      "监护人1·姓名", "监护人1·联系电话", "监护人1·单位", "监护人1·职务",
      "监护人2·姓名", "监护人2·联系电话", "监护人2·单位", "监护人2·职务",
      "备注",
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][1]).toBe("彭阳博");
  });

  it("姓名列仍取真「姓名」列，复合表头列不参与竞争", () => {
    const table = rosterTableFromGrid([DETAILED_PARENT, DETAILED_SUB, DETAILED_ROW_FULL]);
    const detection = detectNameColumn(table);
    expect(detection.selected).toBe(1);
    expect(detection.confidence).toBe("high");
  });

  it("行号换算含子表头行：第 3 行数据对应表格第 4 行", () => {
    const noName = [...DETAILED_ROW_FULL];
    noName[1] = "";
    const table = rosterTableFromGrid([DETAILED_PARENT, DETAILED_SUB, DETAILED_ROW_FULL, noName]);
    const prep = prepareRosterRows(table, detectFieldMapping(table, 1));

    expect(prep.rows).toHaveLength(1);
    expect(prep.issues).toEqual([{ row: 4, name: "", reason: "姓名为空" }]);
  });

  it("单行表头不受影响（headerRows 为 1）", () => {
    const table = rosterTableFromGrid([["姓名", "学号"], ["张三", "9001"]]);
    expect(table.headerRows).toBe(1);
    expect(table.rows).toEqual([["张三", "9001"]]);
  });
});

describe("详细花名册：字段映射与双监护人", () => {
  const table = rosterTableFromGrid([
    DETAILED_PARENT,
    DETAILED_SUB,
    DETAILED_ROW_FULL,
    DETAILED_ROW_SINGLE,
  ]);
  const mapping = detectFieldMapping(table, 1);

  it("两组监护人各自映射到独立槽位", () => {
    expect(mapping.fields).toMatchObject({
      student_no: 0,
      gender: 2,
      birth_date: 3,
      id_card: 4,
      address: 6,
      note: 16,
      guardian_name: 8,
      guardian_phone: 9,
      guardian_unit: 10,
      guardian_duty: 11,
      guardian2_name: 12,
      guardian2_phone: 13,
      guardian2_unit: 14,
      guardian2_duty: 15,
    });
  });

  it("未落库的列进入 ignored（学籍号、籍贯）", () => {
    expect(mapping.ignored.map((c) => c.header)).toEqual(["学籍号", "籍贯"]);
  });

  it("一行两位监护人，首位为主联系人，单位与职务合并进职业", () => {
    const prep = prepareRosterRows(table, mapping);
    expect(prep.issues).toEqual([]);

    const [first, second] = prep.rows;
    expect(first.birth_date).toBe("2017-04-24");
    expect(first.id_card).toBe("441322201704241514");
    expect(first.guardians).toEqual([
      {
        name: "彭文",
        phone: "18539258113",
        relation: "监护人",
        is_primary: true,
        occupation: "顺丰速运鹤山营业点",
      },
      {
        name: "邹煜杰",
        phone: "18819121777",
        relation: "监护人",
        is_primary: false,
        occupation: "鹤山市农商银行 · 职员",
      },
    ]);

    // 只有职务、第二位监护人整组为空 → 只建一位
    expect(second.note).toBe("特困");
    expect(second.guardians).toEqual([
      {
        name: "郭彤霞",
        phone: "13914167867",
        relation: "监护人",
        is_primary: true,
        occupation: "个体户",
      },
    ]);
  });
});

describe("详细花名册：学号与学籍号的优先级", () => {
  it("「学号」列出现在「学籍号」之后时仍取学号", () => {
    const table = rosterTableFromGrid([
      ["学籍号", "姓名", "学号", "备注"],
      ["G441322201704241514", "甲同学", "9001", ""],
    ]);
    expect(detectFieldMapping(table, 1).fields.student_no).toBe(2);
  });

  it("只有「学籍号」列时取其作为学号（保持既有别名行为）", () => {
    const table = rosterTableFromGrid([
      ["学籍号", "姓名", "备注"],
      ["G441322201704241514", "甲同学", ""],
    ]);
    expect(detectFieldMapping(table, 1).fields.student_no).toBe(0);
  });
});

describe("详细花名册：老式单行表头不回归", () => {
  it("「监护人 + 联系电话」仍是一位监护人（无 occupation 字段）", () => {
    const table = parseRosterTable("姓名,学号,监护人,联系电话\n甲同学,9001,张大,13800138000");
    const mapping = detectFieldMapping(table, 0);
    expect(mapping.fields.guardian_name).toBe(2);
    expect(mapping.fields.guardian_phone).toBe(3);
    expect(mapping.fields.guardian2_name).toBeUndefined();

    const [row] = prepareRosterRows(table, mapping).rows;
    expect(row.guardians).toEqual([
      { name: "张大", phone: "13800138000", relation: "监护人", is_primary: true },
    ]);
  });

  it("无任何监护人列时不建监护人", () => {
    const table = parseRosterTable("姓名,学号\n甲同学,9001");
    const [row] = prepareRosterRows(table, detectFieldMapping(table, 0)).rows;
    expect(row.guardians).toEqual([]);
  });
});
