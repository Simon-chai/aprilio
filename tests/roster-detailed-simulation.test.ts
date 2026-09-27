/**
 * 详细花名册（学校下发的「学生详细信息表」）模拟导入。
 *
 * 样例 docs/examples/详细花名册-四年级八班.tsv 是脱敏后的真实格式变体：双行分组表头
 * （监护人1/监护人2 下再分 姓名/联系电话/单位/职务）+ 学籍号、籍贯等无落点列。
 * 用真实管道（parseRosterTable → detectNameColumn → detectFieldMapping →
 * prepareRosterRows → importRosterStudents，与对话框/Agent 工具同源）跑通，
 * 断言两件事：档案字段不需要手工补录、重复导入天然幂等。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteClass, deleteStudent, listStudents } from "../src/lib/db";
import {
  detectFieldMapping,
  detectNameColumn,
  importRosterStudents,
  parseRosterTable,
  prepareRosterRows,
} from "../src/lib/roster";

const SAMPLE = join(process.cwd(), "docs", "examples", "详细花名册-四年级八班.tsv");
const SAMPLE_NOS = ["1", "2", "3", "4"];

const loadTable = () => parseRosterTable(readFileSync(SAMPLE, "utf8"));

/** 同一份样例重新走一遍完整映射（模拟「再次导入」的手工操作） */
function preparedFromSample() {
  const table = loadTable();
  const mapping = detectFieldMapping(table, detectNameColumn(table).selected);
  return prepareRosterRows(table, mapping);
}

describe("详细花名册样例模拟导入", () => {
  it("识别双行分组表头、两组监护人槽位与未落库列", () => {
    const table = loadTable();

    expect(table.hasHeader).toBe(true);
    expect(table.headerRows).toBe(2);
    expect(table.headers.slice(8, 16)).toEqual([
      "监护人1·姓名",
      "监护人1·联系电话",
      "监护人1·单位",
      "监护人1·职务",
      "监护人2·姓名",
      "监护人2·联系电话",
      "监护人2·单位",
      "监护人2·职务",
    ]);
    expect(detectNameColumn(table).selected).toBe(1);

    const mapping = detectFieldMapping(table, 1);
    expect(mapping.ignored.map((column) => column.header)).toEqual(["学籍号", "籍贯"]);

    const prep = prepareRosterRows(table, mapping);
    expect(prep.issues).toEqual([]);
    expect(prep.rows).toHaveLength(4);
  });

  it("导入后档案字段齐全（含两位监护人），重复导入幂等", async () => {
    const first = await importRosterStudents(preparedFromSample());
    const className = first.autoClass ?? "";

    try {
      expect(first.imported).toBe(4);
      expect(first.updated).toBe(0);
      expect(first.failed).toEqual([]);

      const before = await listStudents();
      const byNo = (no: string) => before.find((s) => s.student_no === no);

      const xingye = byNo("1");
      expect(xingye?.name).toBe("陆星野");
      expect(xingye?.gender).toBe("男");
      expect(xingye?.birth_date).toBe("2017-04-24");
      expect(xingye?.id_card).toBe("440784201704240011");
      expect(xingye?.address).toContain("翠湖花园");
      expect(xingye?.guardians).toHaveLength(2);
      expect(xingye?.guardians[0]).toMatchObject({
        name: "陆文山",
        phone: "13800000001",
        relation: "监护人",
        is_primary: true,
        occupation: "顺丰速运鹤山营业点",
      });
      expect(xingye?.guardians[1]).toMatchObject({
        name: "周雨桐",
        phone: "18800000002",
        is_primary: false,
        occupation: "鹤山市农商银行 · 职员",
      });

      // 只有一位家长的行不凭空造第二位监护人
      expect(byNo("2")?.guardians).toHaveLength(1);
      expect(byNo("3")?.note).toBe("单亲");
      expect(byNo("4")?.note).toBe("特困");
      expect((byNo("4")?.guardians ?? []).map((g) => g.name)).toEqual(["苏志远", "李静"]);

      // 重导入：全部走「更新」，记录 id 不变，监护人不翻倍
      const idsBefore = before.filter((s) => SAMPLE_NOS.includes(s.student_no)).map((s) => s.id).sort();
      const again = await importRosterStudents(preparedFromSample());
      expect(again.imported).toBe(0);
      expect(again.updated).toBe(4);

      const after = await listStudents();
      const idsAfter = after.filter((s) => SAMPLE_NOS.includes(s.student_no)).map((s) => s.id).sort();
      expect(idsAfter).toEqual(idsBefore);
      expect(after.find((s) => s.student_no === "1")?.guardians).toHaveLength(2);
    } finally {
      const leftover = (await listStudents()).filter((s) => SAMPLE_NOS.includes(s.student_no));
      for (const student of leftover) await deleteStudent(student.id);
      if (className) {
        try {
          await deleteClass(className);
        } catch {
          /* 已清理或不存在 */
        }
      }
    }
  });
});
