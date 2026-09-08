/**
 * 成绩单样例模拟导入。
 *
 * 用真实导入管道（parseRosterTable → runSmartScoreImport，与对话框/Agent 工具同源）
 * 跑通 docs/examples/ 下多份不同格式的成绩单，并**只把成功记录**写入
 * docs/examples/模拟导入记录.json——该文件即「保留的模拟导入记录」，
 * `npm test` 时重新生成，保证记录与样例始终一致。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearAll, listExamsByClass, listStudents } from "../src/lib/db";
import { parseRosterTable } from "../src/lib/roster";
import { runSmartScoreImport } from "../src/lib/scores";

const EXAMPLES_DIR = join(process.cwd(), "docs", "examples");
const RECORD_FILE = join(EXAMPLES_DIR, "模拟导入记录.json");

/** 样例清单：覆盖标题行/无标题、逗号/制表符、标准/等级制、汇总干扰列等格式 */
const SAMPLES: { file: string; className: string }[] = [
  { file: "成绩单-四年级一班-期中.csv", className: "四年级一班" },
  { file: "成绩单-四年级一班-期末.csv", className: "四年级一班" },
  { file: "2026年秋季第一单元测验成绩单.csv", className: "四年级一班" },
  { file: "成绩单-四年级一班-第一次月考-等级制.csv", className: "四年级一班" },
  { file: "2026年秋季学情摸底测试成绩单.tsv", className: "四年级一班" },
  { file: "成绩表样例.csv", className: "三年级二班" },
];

interface SimulationRecord {
  file: string;
  class_name: string;
  exam_name: string;
  exam_date: string;
  exam_reused: boolean;
  subjects: string[];
  students_matched: number;
  students_created: number;
  scores_written: number;
  skipped: number;
  failed: number;
}

describe("成绩单样例模拟导入", () => {
  it("导入全部样例，仅成功记录进入 docs/examples/模拟导入记录.json", async () => {
    await clearAll();

    const records: SimulationRecord[] = [];
    for (const sample of SAMPLES) {
      const text = readFileSync(join(EXAMPLES_DIR, sample.file), "utf8");
      const table = parseRosterTable(text);
      const outcome = await runSmartScoreImport(table, {
        className: sample.className,
        fileName: sample.file,
      });

      expect(outcome.status, `${sample.file} 应被识别为成绩单并导入成功`).toBe("ok");
      if (outcome.status !== "ok" || !outcome.result) continue;

      const result = outcome.result;
      expect(result.scores_written, `${sample.file} 应写入成绩`).toBeGreaterThan(0);

      records.push({
        file: sample.file,
        class_name: outcome.exam.class_name,
        exam_name: outcome.exam.name,
        exam_date: outcome.exam.exam_date,
        exam_reused: !outcome.examCreated,
        subjects: outcome.detection.subjects.map((s) => s.name),
        students_matched: result.students_matched,
        students_created: result.students_created,
        scores_written: result.scores_written,
        skipped: result.skipped.length,
        failed: result.failed.length,
      });
    }

    // 全部成功才写记录；有任何一份失败，长度对不上，测试即失败
    expect(records).toHaveLength(SAMPLES.length);
    writeFileSync(
      RECORD_FILE,
      `${JSON.stringify(
        {
          note: "成绩单样例模拟导入记录（仅保留成功项）；由 tests/score-import-simulation.test.ts 在 npm test 时重新生成",
          records,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // 落地校验：样例覆盖的班级都真的有成绩
    const gradeFour = await listStudents("", "四年级一班");
    expect(gradeFour.length).toBeGreaterThanOrEqual(10);
    expect((await listExamsByClass("四年级一班")).length).toBeGreaterThanOrEqual(5);
    expect((await listExamsByClass("三年级二班")).length).toBeGreaterThanOrEqual(1);
  });

  it("重复导入同一份成绩单：复用考试批次、不重复建档、成绩覆盖更新", async () => {
    await clearAll();
    const sample = SAMPLES[0];
    const text = readFileSync(join(EXAMPLES_DIR, sample.file), "utf8");

    const first = await runSmartScoreImport(parseRosterTable(text), {
      className: sample.className,
      fileName: sample.file,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok" || !first.result) return;
    expect(first.examCreated).toBe(true);

    const second = await runSmartScoreImport(parseRosterTable(text), {
      className: sample.className,
      fileName: sample.file,
    });
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || !second.result) return;

    expect(second.examCreated).toBe(false); // 同一考试名 + 时间 → 复用批次
    expect(second.result.students_created).toBe(0); // 学生已存在，不再重复建档
    expect(second.result.scores_written).toBe(first.result.scores_written); // 成绩覆盖更新
    expect((await listExamsByClass(sample.className)).length).toBe(1);
  });
});
