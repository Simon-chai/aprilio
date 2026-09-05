/**
 * 生成花名册 xlsx 测试夹具（docs/EXCEL_PARSING_EVALUATION.md 的 calamine 路线配套）。
 *
 * 用途：node scripts/gen-roster-xlsx-fixture.mjs
 * 产物：src-tauri/tests/fixtures/roster-sample.xlsx
 *
 * 夹具刻意覆盖花名册导入的关键解码路径：
 * - 「说明」占位工作表在前且只有 1 行标题（验证取第一个有数据的工作表）
 * - 共享字符串（表头与姓名）
 * - inlineStr（王五）
 * - 整数单元格（学号/电话，不能渲染成浮点）
 * - 样式化日期单元格（numFmt 164，验证 Excel 序列 → YYYY-MM-DD）
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- zip（STORE 方式，无压缩） ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

const u16 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    locals.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        u16(20), u16(0), u16(0), u16(0), u16(0x21),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBuf.length), u16(0),
        nameBuf, data,
      ]),
    );
    centrals.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += locals[locals.length - 1].length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

/* ---------- 最小 OOXML ---------- */

const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;

const contentTypes = xml(
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`,
);

const rootRels = xml(
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`,
);

const workbook = xml(
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
      `<sheet name="说明" sheetId="1" r:id="rId1"/>` +
      `<sheet name="花名册" sheetId="2" r:id="rId2"/>` +
    `</sheets>` +
  `</workbook>`,
);

const workbookRels = xml(
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`,
);

const sharedStrings = xml(
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">` +
    `<si><t>姓名</t></si><si><t>学号</t></si><si><t>出生日期</t></si><si><t>监护人电话</t></si>` +
    `<si><t>张三</t></si><si><t>李小红</t></si>` +
  `</sst>`,
);

const styles = xml(
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
    `<fonts count="1"><font><sz val="11"/><name val="宋体"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs>` +
  `</styleSheet>`,
);

const sheet1 = xml(
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>本表为占位说明页，只有标题行，不应被当作数据导入</t></is></c></row>` +
    `</sheetData>` +
  `</worksheet>`,
);

const sheet2 = xml(
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>` +
      `<row r="1">` +
        `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>` +
        `<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c>` +
      `</row>` +
      `<row r="2">` +
        `<c r="A2" t="s"><v>4</v></c><c r="B2"><v>20240001</v></c>` +
        `<c r="C2" s="1"><v>45658</v></c><c r="D2"><v>13800128846</v></c>` +
      `</row>` +
      `<row r="3">` +
        `<c r="A3" t="s"><v>5</v></c><c r="B3"><v>20240002</v></c>` +
        `<c r="C3" s="1"><v>42867</v></c><c r="D3"><v>13988772310</v></c>` +
      `</row>` +
      `<row r="4"><c r="A4" t="inlineStr"><is><t>王五</t></is></c></row>` +
    `</sheetData>` +
  `</worksheet>`,
);

const entries = [
  { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
  { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
  { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
  { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
  { name: "xl/sharedStrings.xml", data: Buffer.from(sharedStrings, "utf8") },
  { name: "xl/styles.xml", data: Buffer.from(styles, "utf8") },
  { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheet1, "utf8") },
  { name: "xl/worksheets/sheet2.xml", data: Buffer.from(sheet2, "utf8") },
];

const outPath = join(root, "src-tauri", "tests", "fixtures", "roster-sample.xlsx");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zipStore(entries));
console.log(`已生成 ${outPath}（${entries.length} 个成员）`);
