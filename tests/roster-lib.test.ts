import { describe, expect, it } from "vitest";
import {
  aiDetectNameColumn,
  combineNameDetection,
  decodeRosterBytes,
  detectFieldMapping,
  detectNameColumn,
  findNameColumnByHeader,
  importRosterStudents,
  isTableSpreadsheet,
  parseRosterTable,
  prepareRosterRows,
  rosterTableFromGrid,
  rosterTemplateCsv,
  runSmartImport,
  runSmartImportTable,
  validateTemplateTable,
} from "../src/lib/roster";
import { deleteStudent, listStudents } from "../src/lib/db";
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

  it("imports new students and skips ones already in the database", async () => {
    await cleanupByNos(nos);
    try {
      const first = parseRosterTable(TEMPLATE_TEXT.replace(/9000001/g, "9000011").replace(/9000002/g, "9000012"));
      const result = await importRosterStudents(prepareRosterRows(first, detectFieldMapping(first, 0)));
      expect(result.imported).toBe(2);
      expect(result.skipped).toEqual([]);

      // 幂等：同一份文件重复导入 → 全部跳过
      const again = await importRosterStudents(prepareRosterRows(first, detectFieldMapping(first, 0)));
      expect(again.imported).toBe(0);
      expect(again.skipped).toHaveLength(2);
      expect(again.skipped[0].reason).toContain("已存在");
    } finally {
      await cleanupByNos(nos);
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
