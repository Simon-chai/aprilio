import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeRosterBytes,
  detectFieldMapping,
  detectNameColumn,
  parseRosterTable,
  prepareRosterRows,
  rosterTableFromGrid,
  runSmartImportTable,
  type RosterTable,
} from "../src/lib/roster";

const SMOKE_DIR = "D:/myspace/job/data/花名册/smoke-roster";
const hasSmokeDir = fs.existsSync(SMOKE_DIR);

const XLSX_GRIDS: Record<string, { sheet: string; rows: string[][] }> = {
  "05-合并标题.xlsx": {
    sheet: "花名册",
    rows: [
      ["XX中学2026级3班花名册", "", "", "", "", ""],
      ["姓名", "性别", "学号", "出生日期", "监护人电话", "备注"],
      ["张小明", "男", "20240001", "2017-05-12", "13800000051", "班长"],
      ["李美琪", "女", "20240002", "2017-03-24", "13800000052", ""],
      ["王志强", "M", "20240003", "2017-08-15", "13800000053", "文艺骨干"],
      ["赵若曦", "F", "20240004", "2017-11-02", "13800000054", ""],
      ["钱博文", "male", "20240005", "2017-01-09", "13800000055", "走读"],
      ["孙晓雅", "female", "20240006", "2017-06-18", "13800000056", ""],
      ["周子骞", "男", "20240007", "2017-09-21", "13800000057", ""],
      ["吴欣怡", "女", "20240008", "2017-04-30", "13800000058", "少先队员"],
      ["郑凯文", "M", "20240009", "2017-07-07", "13800000059", ""],
      ["陈思羽", "female", "20240010", "2017-12-14", "13800000060", "团员"],
    ],
  },
  "06-多工作表.xlsx": {
    sheet: "花名册",
    rows: [
      ["姓名", "性别", "学号", "出生日期", "监护人电话", "备注"],
      ["林浩宇", "男", "20240601", "2017-02-10", "13800000061", "班长"],
      ["宋佳琳", "女", "20240602", "2017-04-15", "13800000062", ""],
      ["谢晨光", "男", "20240603", "2017-06-20", "13800000063", "中队长"],
      ["唐雨婷", "女", "20240604", "2017-08-25", "13800000064", ""],
      ["许耀辉", "男", "20240605", "2017-10-30", "13800000065", "走读"],
      ["韩梦洁", "女", "20240606", "2017-12-05", "13800000066", ""],
      ["邓俊杰", "男", "20240607", "2017-01-18", "13800000067", "体育委员"],
      ["彭晓月", "女", "20240608", "2017-07-22", "13800000068", ""],
    ],
  },
  "07-脏数据.xlsx": {
    sheet: "花名册",
    rows: [
      ["姓名", "性别", "学号", "出生日期", "身份证号", "备注"],
      ["", "女", "20240701", "2017-05-12", "110101201705120011", "姓名为空测试"],
      ["陈晨", "M", "20240702", "2017.5.12", "11010120170512002X", "点号日期"],
      ["林晓", "female", "20240702", "2017年5月12日", "110101201705120038", "中文日期及学号重复"],
      ["超长姓名测试字符串这是一个用于测试超长非法姓名的样例名字啊", "男生", "20240703", "2017/5/12", "110101201705120046", "斜杠日期及超长姓名"],
      ["苏子涵", "男", "20240704", "2017.5.12", "110101201705120054", ""],
      ["白雪", "女", "20240705", "2017年5月12日", "110101201705120062", "正常数据"],
      ["彭飞", "M", "20240706", "2017/5/12", "110101201705120070", ""],
      ["潘小婷", "female", "20240707", "2017-05-12", "110101201705120089", "团员"],
      ["葛天明", "男生", "20240708", "2017.5.12", "110101201705120097", ""],
      ["奚秀英", "女", "20240709", "2017年5月12日", "11010120170512010X", ""],
      ["范伟强", "男", "20240710", "2017/5/12", "110101201705120119", "走读"],
      ["方嘉怡", "女", "20240711", "2017-05-12", "110101201705120127", ""],
    ],
  },
  "08-姓名列陷阱.xlsx": {
    sheet: "花名册",
    rows: [
      ["序号", "家长姓名", "学生姓名", "联系电话"],
      ["1", "张大山", "张小明", "13800000081"],
      ["2", "李建国", "李雷", "13800000082"],
      ["3", "王大明", "王芳", "13800000083"],
      ["4", "赵德厚", "赵敏", "13800000084"],
      ["5", "钱富贵", "钱多多", "13800000085"],
      ["6", "孙长林", "孙悟空", "13800000086"],
      ["7", "周培生", "周杰", "13800000087"],
      ["8", "吴有才", "吴悠", "13800000088"],
    ],
  },
};

function loadCsvTable(fileName: string): RosterTable {
  const filePath = path.join(SMOKE_DIR, fileName);
  const buf = fs.readFileSync(filePath);
  const decoded = decodeRosterBytes(buf);
  return parseRosterTable(decoded.text);
}

describe.runIf(hasSmokeDir)("Smoke Roster Evaluation", () => {
  it("01-标准模板-utf8bom.csv", async () => {
    const table = loadCsvTable("01-标准模板-utf8bom.csv");
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(10);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("02-gbk编码.csv", async () => {
    const table = loadCsvTable("02-gbk编码.csv");
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(8);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("03-分号分隔-utf8.csv", async () => {
    const table = loadCsvTable("03-分号分隔-utf8.csv");
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(8);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("04-无表头.csv", async () => {
    const table = loadCsvTable("04-无表头.csv");
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.selected).toBe(1);
    expect(outcome.mapping.fields.gender).toBe(2);
    expect(outcome.mapping.fields.guardian_phone).toBe(3);
    expect(outcome.result?.imported).toBe(8);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("05-合并标题.xlsx", async () => {
    const grid = XLSX_GRIDS["05-合并标题.xlsx"];
    const table = rosterTableFromGrid(grid.rows);
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(10);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("06-多工作表.xlsx", async () => {
    const grid = XLSX_GRIDS["06-多工作表.xlsx"];
    const table = rosterTableFromGrid(grid.rows);
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(8);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("07-脏数据.xlsx", async () => {
    const grid = XLSX_GRIDS["07-脏数据.xlsx"];
    const table = rosterTableFromGrid(grid.rows);
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(0);
    expect(outcome.result?.imported).toBe(9);
    expect(outcome.result?.failed).toHaveLength(3);
  });

  it("08-姓名列陷阱.xlsx", async () => {
    const grid = XLSX_GRIDS["08-姓名列陷阱.xlsx"];
    const table = rosterTableFromGrid(grid.rows);
    const outcome = await runSmartImportTable(table);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.detection.confidence).toBe("high");
    expect(outcome.detection.selected).toBe(2);
    expect(outcome.result?.imported).toBe(8);
    expect(outcome.result?.failed).toHaveLength(0);
  });

  it("handles merged title containing class/grade keywords", () => {
    const grid = [
      ["光明小学三年级二班学生花名册", "", "", "", ""],
      ["姓名", "性别", "学号", "出生日期", "电话"],
      ["张三", "男", "20240001", "2017-05-12", "13800000001"],
    ];
    const table = rosterTableFromGrid(grid);
    expect(table.hasHeader).toBe(true);
    expect(table.headers[0]).toBe("姓名");
  });
});
