/**
 * 花名册导入核心管道。
 *
 * 管道：读取文件（UTF-8/GBK）→ 解析表格（分隔符嗅探、表头嗅探）
 *      → 姓名列识别（规则打分 + 可选 AI 识别）→ 字段映射 → 行校验 → 落库。
 *
 * 「导入花名册」对话框与 Agent 工具 import_student_roster 共用这条管道：
 * 用户通过 AI 助手导入时，底层走的就是智能导入（runSmartImport）。
 * 设计约定见 docs/ROSTER_IMPORT.md。
 */
import { createLlm } from "../agent/providers";
import type { AgentLlm } from "../agent/types";
import { isAiConfigured, loadAiConfig, type AiConfig } from "./ai";
import { createClass, createStudent, isTauri, listClasses, listStudents, updateStudent } from "./db";
import type { Gender, Guardian, StudentInput } from "../types";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 解析后的表格：分隔符嗅探 + 表头嗅探的产物 */
export interface RosterTable {
  /** 表头（无表头时自动生成「第N列」） */
  headers: string[];
  /** 数据行（不含表头） */
  rows: string[][];
  /** 首个表头行是否被识别（表前标题行已剔除） */
  hasHeader: boolean;
  delimiter: string;
  /** 表头前被剔除的标题行数（跨列合并标题等），用于行号换算 */
  titleRows?: number;
  /** 被剔除标题行的合并文本（每行一条），供成绩单提取考试名/考试时间 */
  titleText?: string[];
}

export type NameConfidence = "high" | "medium" | "low";

/** 姓名列候选 */
export interface NameCandidate {
  /** 列序号（0 起） */
  index: number;
  header: string;
  score: number;
  confidence: NameConfidence;
  reason: string;
}

/** 姓名列识别结果 */
export interface NameDetection {
  /** 按可能性排序的候选列 */
  candidates: NameCandidate[];
  /** 当前选中列（-1 表示没有像姓名的列） */
  selected: number;
  confidence: NameConfidence;
  /** 识别方式：rule=本地规则，ai=模型识别 */
  method: "rule" | "ai";
  reason: string;
}

/** 除姓名外可自动映射的字段 */
export type RosterField =
  | "student_no"
  | "gender"
  | "birth_date"
  | "grade_class"
  | "id_card"
  | "guardian_name"
  | "guardian_phone"
  | "address"
  | "note";

export const ROSTER_FIELD_LABELS: Record<RosterField, string> = {
  student_no: "学号",
  gender: "性别",
  birth_date: "出生日期",
  grade_class: "年级班级",
  id_card: "身份证号",
  guardian_name: "监护人",
  guardian_phone: "联系电话",
  address: "家庭住址",
  note: "备注",
};

export interface RosterMapping {
  nameColumn: number;
  /** 字段 → 列序号（0 起） */
  fields: Partial<Record<RosterField, number>>;
}

export interface RosterRowIssue {
  /** 表格中的行号（含表头偏移，从 1 起） */
  row: number;
  name: string;
  reason: string;
}

export interface RosterPrepareResult {
  rows: StudentInput[];
  issues: RosterRowIssue[];
}

export interface RosterImportResult {
  imported: number;
  /** 命中「姓名+学号」相同而用新数据覆盖更新的记录数 */
  updated: number;
  skipped: { name: string; reason: string }[];
  failed: RosterRowIssue[];
  /**
   * 未命名批次自动分班的目标班级（本次新建或复用的「未命名班级N」/「未分班」）。
   * 具名批次（表内自带班级）不填，由调用方按行内班级推断跳转。
   */
  autoClass?: string | null;
}

/* ------------------------------------------------------------------ */
/* 读取：文件选择与解码                                                 */
/* ------------------------------------------------------------------ */

const TEXT_EXTENSIONS = ["csv", "tsv", "txt"];
/** 表格通道：Rust 端 calamine 解码（docs/EXCEL_PARSING_EVALUATION.md） */
const TABLE_EXTENSIONS = ["xlsx", "xlsm", "xlsb", "xls", "ods"];

/** 载入后的花名册：表格矩阵 + 来源信息 */
export interface LoadedRoster {
  path: string;
  fileName: string;
  table: RosterTable;
  /** text=CSV/TSV 文本解析；table=Rust 端 calamine 解码的 Excel/ODS */
  kind: "text" | "table";
  /** 表格通道的工作表名（text 通道无） */
  sheet?: string;
}

export function isTableSpreadsheet(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TABLE_EXTENSIONS.includes(ext);
}

/**
 * 弹出系统文件选择框并把文件解析为表格矩阵（桌面端）。
 * 浏览器演示态返回 null——没有 Rust 解码通道，Excel 无法解析，由调用方
 * 回退到 <input type=file>（仅文本格式，decodeRosterBytes）。
 *
 * 多文件导入：支持一次选择多个文件（每文件独立识别、独立落库，
 * 成绩导入场景下每文件独立生成考试批次）。
 */
export async function pickRosterFiles(): Promise<LoadedRoster[] | null> {
  if (!isTauri()) return null;

  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "花名册表格", extensions: [...TEXT_EXTENSIONS, ...TABLE_EXTENSIONS] }],
  });
  if (!selected) return null;
  const paths = (Array.isArray(selected) ? selected : [selected]).map(String).filter(Boolean);
  if (!paths.length) return null;

  const out: LoadedRoster[] = [];
  for (const p of paths) {
    out.push(await loadRosterTable(p));
  }
  return out;
}

export async function pickRosterFile(): Promise<LoadedRoster | null> {
  const files = await pickRosterFiles();
  return files?.[0] ?? null;
}

/** 按扩展名读取并解析花名册（桌面端）：xlsx/xls 走 roster_read_table，文本走 roster_read_text */
export async function loadRosterTable(path: string): Promise<LoadedRoster> {
  if (!isTauri()) throw new Error("浏览器演示态无法读取本地文件");
  const { invoke } = await import("@tauri-apps/api/core");
  const fileName = path.split(/[\\/]/).pop() ?? path;

  if (isTableSpreadsheet(path)) {
    const grid = await invoke<{ sheet: string; rows: string[][] }>("roster_read_table", {
      source: path,
    });
    return {
      path,
      fileName,
      table: rosterTableFromGrid(grid.rows ?? []),
      kind: "table",
      sheet: grid.sheet,
    };
  }

  const res = await invoke<{ text: string; encoding: string }>("roster_read_text", { source: path });
  return { path, fileName, table: parseRosterTable(res.text), kind: "text" };
}

/** 字节 → 文本：UTF-8 严格解码，失败回退 GBK（WebView2 与 Node 均内置码表） */
export function decodeRosterBytes(buffer: ArrayBuffer | ArrayBufferView): { text: string; encoding: string } {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    try {
      return { text: new TextDecoder("gbk").decode(bytes), encoding: "gbk" };
    } catch {
      return { text: new TextDecoder("utf-8").decode(bytes), encoding: "utf-8" };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 解析：分隔符嗅探、引号感知的记录切分、表头嗅探                          */
/* ------------------------------------------------------------------ */

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

/** 取候选分隔符中首行出现次数最多者（并列时靠前者优先，逗号最常见） */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", "\t", ";", "，", "|"]) {
    const count = countOutsideQuotes(firstLine, d);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** 引号感知的整段切分：支持引号内的换行与转义引号（""），跳过全空行 */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let inQuotes = false;

  const pushCell = () => {
    record.push(cell);
    cell = "";
  };
  const pushRecord = () => {
    pushCell();
    if (record.some((c) => c.trim() !== "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === "\n") {
      pushRecord();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRecord();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || record.length) pushRecord();
  return records;
}

const HEADER_KEYWORDS = [
  "姓名", "学号", "性别", "班级", "年级", "出生", "入学", "监护人", "家长",
  "电话", "手机", "住址", "地址", "备注", "编号", "name",
];

function looksLikeHeaderRow(row: string[], totalWidth: number): boolean {
  const cells = row.map((c) => (c ?? "").trim()).filter(Boolean);
  if (cells.length === 0) return false;

  // 1. 如果表格宽度 >= 3，但本行非空单元格 <= 2，通常为跨列合并的大标题或副标题
  if (totalWidth >= 3 && cells.length <= Math.min(2, Math.floor(totalWidth / 2))) {
    return false;
  }

  // 2. 长标题特征：包含「花名册」「名单」「统计表」「登记表」「汇总表」等且文字较长
  if (cells.some((c) => /花名册|名单|统计表|登记表|汇总表/.test(c) && c.length > 4)) {
    return false;
  }

  // 3. 计算表头特征：
  // 表头单元格通常短小精悍（<= 8 字），且不包含数据状态词（如「已」「中」「未」「暂无」等）
  let exactNameMatch = false;
  let headerHits = 0;

  for (const cell of cells) {
    const lower = cell.toLowerCase();
    if (["姓名", "学生姓名", "名字", "name", "student name"].includes(lower)) {
      exactNameMatch = true;
      headerHits += 2;
      continue;
    }
    // 单元格过长或包含句子语气/状态动词，通常是备注或说明而不是表头
    if (cell.length > 8 || /已|中|暂|请|不|换/.test(cell)) {
      continue;
    }
    if (HEADER_KEYWORDS.some((k) => lower === k || lower.includes(k))) {
      headerHits += 1;
    }
  }

  // 如果有精确的姓名列，或者有至少 2 个明确的表头列
  return exactNameMatch || headerHits >= 2;
}

/**
 * 由二维记录矩阵构造表格：表头嗅探（含「姓名/学号」等关键词则首个表头行生效，
 * 否则按数据处理并生成「第N列」）。CSV 文本解析与 Rust 表格通道（xlsx/xls）
 * 共用这一步——格式解码在哪里做，语义识别始终在前端。
 *
 * 真实花名册常有跨列合并的标题行（「XX中学2026级3班花名册」）：表头行之前
 * 仅 1~2 个非空格的行按标题剔除；普通数据行不会误判（非空格数 > 2）。
 */
export function rosterTableFromGrid(records: string[][]): RosterTable {
  if (!records.length) throw new Error("表格内容为空");
  const width = Math.max(...records.map((r) => r.length));

  // 标题行的合并文本（每行一条），供成绩单提取考试名/考试时间
  const titleTextOf = (upTo: number): string[] =>
    records
      .slice(0, upTo)
      .map((row) => row.map((c) => (c ?? "").trim()).filter(Boolean).join(" "))
      .filter(Boolean);

  // 只在前 10 行内寻找表头行，避免把后续数据行中的备注文字误当成表头
  const maxSearch = Math.min(records.length, 10);
  let headerIndex = -1;
  for (let i = 0; i < maxSearch; i++) {
    if (looksLikeHeaderRow(records[i], width)) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === 0) {
    const headers = Array.from({ length: width }, (_, i) => (records[0][i] ?? "").trim());
    return { headers, rows: records.slice(1), hasHeader: true, delimiter: ",", titleText: [] };
  }

  if (headerIndex > 0) {
    const headers = Array.from({ length: width }, (_, i) => (records[headerIndex][i] ?? "").trim());
    return {
      headers,
      rows: records.slice(headerIndex + 1),
      hasHeader: true,
      delimiter: ",",
      titleRows: headerIndex,
      titleText: titleTextOf(headerIndex),
    };
  }

  return {
    headers: Array.from({ length: width }, (_, i) => `第${i + 1}列`),
    rows: records,
    hasHeader: false,
    delimiter: ",",
    titleText: [],
  };
}

/** 解析花名册文本；空表格抛错，由调用方转为友好提示 */
export function parseRosterTable(text: string): RosterTable {
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) throw new Error("表格内容为空");
  const delimiter = sniffDelimiter(clean);
  return { ...rosterTableFromGrid(splitRecords(clean, delimiter)), delimiter };
}

/* ------------------------------------------------------------------ */
/* 姓名列识别                                                          */
/* ------------------------------------------------------------------ */

const NAME_HEADER_EXACT = ["姓名", "学生姓名", "名字", "学生", "学员", "name", "student name"];
const NAME_HEADER_PARTIAL = ["姓名", "名字", "name"];
const NAME_HEADER_EXCLUDE = [
  "学号", "编号", "学籍", "电话", "手机", "联系", "日期", "时间", "住址", "地址",
  "班级", "年级", "成绩", "分数", "备注", "性别", "家长", "监护人", "邮箱", "照片",
  "父亲", "母亲", "爸爸", "妈妈", "父母",
];

/** 2~4 个汉字、无数字与标点 → 疑似中文姓名 */
function nameLikeCell(value: string): boolean {
  const v = value.trim();
  if (v.length < 2 || v.length > 4) return false;
  return /^[一-龥]+$/.test(v);
}

function scoreNameColumn(table: RosterTable, index: number): { score: number; reason: string } {
  const header = (table.headers[index] ?? "").trim();
  const lower = header.toLowerCase();

  if (NAME_HEADER_EXCLUDE.some((k) => header.includes(k))) {
    return { score: -100, reason: "" };
  }

  let score = 0;
  let reason = "";
  if (NAME_HEADER_EXACT.includes(header) || NAME_HEADER_EXACT.includes(lower)) {
    score += 60;
    reason = "表头为姓名字段";
  } else if (NAME_HEADER_PARTIAL.some((k) => lower.includes(k))) {
    score += 45;
    reason = "表头疑似姓名字段";
  }

  const values = table.rows.map((r) => (r[index] ?? "").trim()).filter(Boolean);
  if (values.length) {
    const likeRatio = values.filter(nameLikeCell).length / values.length;
    if (likeRatio > 0) score += Math.round(40 * likeRatio);
    if (likeRatio >= 0.6 && !reason) {
      reason = `${Math.round(likeRatio * 100)}% 的单元格形似中文姓名（2~4 字）`;
    }
    // 姓名在班里几乎唯一；重复率极高的列（如班级、性别）降权
    const distinctRatio = new Set(values).size / values.length;
    if (distinctRatio >= 0.9) score += 10;
    if (distinctRatio < 0.3) score -= 15;
    // 数字与长文本（学号、电话、日期、地址）降权
    const digitRatio = values.filter((v) => /\d/.test(v)).length / values.length;
    if (digitRatio > 0.5) score -= 30;
    const longRatio = values.filter((v) => v.length > 6).length / values.length;
    if (longRatio > 0.5) score -= 20;
  }

  return { score, reason: reason || (score > 0 ? "内容特征疑似姓名" : "") };
}

function confidenceOfScore(score: number): NameConfidence {
  if (score >= 60) return "high";
  if (score >= 32) return "medium";
  return "low";
}

/** 规则识别：按表头关键词 + 单元格内容特征给每列打分，返回候选排序 */
export function detectNameColumn(table: RosterTable): NameDetection {
  const candidates: NameCandidate[] = [];
  for (let i = 0; i < table.headers.length; i++) {
    const { score, reason } = scoreNameColumn(table, i);
    if (score <= 0) continue;
    candidates.push({
      index: i,
      header: table.headers[i],
      score,
      confidence: confidenceOfScore(score),
      reason,
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const top = candidates[0];
  return {
    candidates: candidates.slice(0, 4),
    selected: top ? top.index : -1,
    confidence: top ? top.confidence : "low",
    method: "rule",
    reason: top?.reason || "没有找到像姓名的列",
  };
}

/**
 * AI 识别：把各列表头与示例值交给模型判断哪一列最可能是学生姓名。
 * 返回 null 表示模型不可用 / 输出无法解析，调用方回退规则结果。
 */
export async function aiDetectNameColumn(
  table: RosterTable,
  llm: AgentLlm,
  config: AiConfig,
): Promise<{ index: number; confidence: number; reason: string } | null> {
  const columnLines = table.headers
    .map((header, i) => {
      const samples = [
        ...new Set(table.rows.map((r) => (r[i] ?? "").trim()).filter(Boolean)),
      ]
        .slice(0, 5)
        .map((v) => (v.length > 12 ? v.slice(0, 12) + "…" : v))
        .join("、");
      return `第${i + 1}列「${header}」：${samples || "（空）"}`;
    })
    .join("\n");

  const system =
    "你是表格结构分析助手。用户会给出一张表格各列的表头与示例值，" +
    "请判断哪一列最有可能是「学生姓名」。只输出一个 JSON 对象：" +
    '{"column": 列号(从1开始的数字), "confidence": 0到1的小数, "reason": "不超过20字的理由"}，' +
    "不要输出任何其他内容。";

  try {
    const res = await llm.chat({
      system,
      messages: [{ role: "user", content: `表格共 ${table.headers.length} 列：\n${columnLines}` }],
      tools: [],
      config,
    });
    const match = res.content.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { column?: unknown; confidence?: unknown; reason?: unknown };
    const column = Number(parsed.column);
    if (!Number.isInteger(column) || column < 1 || column > table.headers.length) return null;
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 40) : "";
    return { index: column - 1, confidence, reason };
  } catch {
    return null;
  }
}

/** 规则结果 + AI 结果合成：AI 选择优先，置信度结合规则分数校准 */
export function combineNameDetection(
  rule: NameDetection,
  ai: { index: number; confidence: number; reason: string } | null,
): NameDetection {
  if (!ai) return { ...rule, method: "rule" };

  const matched = rule.candidates.find((c) => c.index === ai.index);
  // 规则未给出正向信号的列（score ≤ 0，不在候选里）无论 AI 多自信都降为 low，
  // 让确认流程兜底；规则与 AI 一致且 AI 自信时才给 high。
  let confidence: NameConfidence;
  if (matched && ai.confidence >= 0.7) confidence = "high";
  else if (matched) confidence = "medium";
  else confidence = "low";

  const header = rule.candidates.find((c) => c.index === ai.index)?.header ?? `第${ai.index + 1}列`;
  const aiCandidate: NameCandidate = {
    index: ai.index,
    header,
    score: matched?.score ?? 0,
    confidence,
    reason: ai.reason || "AI 根据表头与内容判断",
  };
  const candidates = [aiCandidate, ...rule.candidates.filter((c) => c.index !== ai.index)].slice(0, 4);

  return {
    candidates,
    selected: ai.index,
    confidence,
    method: "ai",
    reason: aiCandidate.reason,
  };
}

/* ------------------------------------------------------------------ */
/* 字段映射与行构建                                                     */
/* ------------------------------------------------------------------ */

/** 表头关键词 → 字段。顺序即优先级：「家长电话」先按电话匹配而不是监护人 */
const FIELD_HEADER_PATTERNS: [RosterField, string[]][] = [
  ["student_no", ["学号", "学籍号", "编号", "student no", "student id"]],
  ["gender", ["性别", "gender"]],
  ["birth_date", ["出生", "生日", "birth"]],
  ["grade_class", ["班级", "年级", "class"]],
  ["id_card", ["身份证", "证件", "idcard", "id card"]],
  ["guardian_phone", ["电话", "手机", "联系方式", "phone", "mobile"]],
  [
    "guardian_name",
    [
      "监护人", "家长", "父亲", "母亲", "爸爸", "妈妈", "父母",
      "guardian", "parent", "father", "mother",
    ],
  ],
  ["address", ["住址", "地址", "address"]],
  ["note", ["备注", "note", "remark"]],
];

/** 自动映射除姓名列外的可识别字段；识别不了的列忽略 */
export function detectFieldMapping(table: RosterTable, nameColumn: number): RosterMapping {
  const fields: Partial<Record<RosterField, number>> = {};
  const claimed = new Set<number>([nameColumn]);

  table.headers.forEach((rawHeader, index) => {
    if (claimed.has(index)) return;
    const header = rawHeader.trim().toLowerCase();
    if (!header) return;
    for (const [field, patterns] of FIELD_HEADER_PATTERNS) {
      if (fields[field] !== undefined) continue;
      if (patterns.some((p) => header === p || header.includes(p))) {
        fields[field] = index;
        claimed.add(index);
        return;
      }
    }
  });

  // 基于列内容特征的嗅探兜底（无表头或表头非标准时）
  for (let index = 0; index < table.headers.length; index++) {
    if (claimed.has(index)) continue;
    const values = table.rows.map((r) => (r[index] ?? "").trim()).filter(Boolean);
    if (!values.length) continue;

    // 性别特征：绝大多数为 男/女/男生/女生/male/female 等
    if (fields.gender === undefined) {
      const genderHits = values.filter((v) =>
        /^(男|女|男生|女生|男孩|女孩|男宝|女宝|male|female|m|f|boy|girl)$/i.test(v)
      ).length;
      if (genderHits / values.length >= 0.6) {
        fields.gender = index;
        claimed.add(index);
        continue;
      }
    }

    // 电话特征：绝大多数为 11 位手机号或座机
    if (fields.guardian_phone === undefined) {
      const phoneHits = values.filter((v) =>
        /^1[3-9]\d{9}$/.test(v) || /^\d{3,4}-?\d{7,8}$/.test(v)
      ).length;
      if (phoneHits / values.length >= 0.6) {
        fields.guardian_phone = index;
        claimed.add(index);
        continue;
      }
    }

    // 出生日期特征：绝大多数为有效日期格式
    if (fields.birth_date === undefined) {
      const dateHits = values.filter((v) =>
        /^\d{4}[-/.年]\d{1,2}([-/.月]\d{1,2})?/.test(v) ||
        (/^(\d{4})(\d{2})(\d{2})$/.test(v) && Number(v.slice(0, 4)) >= 1990 && Number(v.slice(0, 4)) <= 2030)
      ).length;
      if (dateHits / values.length >= 0.6) {
        fields.birth_date = index;
        claimed.add(index);
        continue;
      }
    }

    // 身份证特征：15 位纯数字或 18 位（末位可为 X）
    if (fields.id_card === undefined) {
      const idHits = values.filter((v) => /^(?:\d{15}|\d{17}[\dXx])$/.test(v)).length;
      if (idHits / values.length >= 0.6) {
        fields.id_card = index;
        claimed.add(index);
      }
    }
  }

  return { nameColumn, fields };
}

function normalizeGender(value: string): Gender {
  const v = value.trim().toLowerCase();
  if (["女", "女生", "女孩", "女宝", "female", "f", "girl"].includes(v)) return "女";
  return "男";
}

/** 2017-5-12 / 2017.5.12 / 2017/5/12 / 2017年5月12日 / 20170512 → 2017-05-12；无法解析时原样保留 */
function normalizeDate(value: string): string {
  const s = value.trim().replace(/日|号/g, "").replace(/年|月|\/|\./g, "-").replace(/-+$/, "");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) {
    const y = Number(m2[1]);
    const month = Number(m2[2]);
    const d = Number(m2[3]);
    if (y >= 1900 && y <= 2100 && month >= 1 && month <= 12 && d >= 1 && d <= 31) {
      return `${m2[1]}-${m2[2]}-${m2[3]}`;
    }
  }
  return value.trim();
}

/** 身份证号归一：去空白，末位 x 转大写 */
function normalizeIdCard(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * 按映射把表格行转成学生输入：姓名缺失/表内学号重复的行进 issues，
 * 其余进入待导入列表。单行失败不影响整批。
 */
export function prepareRosterRows(table: RosterTable, mapping: RosterMapping): RosterPrepareResult {
  const rows: StudentInput[] = [];
  const issues: RosterRowIssue[] = [];
  const seenNos = new Set<string>();

  const cellOf = (cells: string[], column?: number) =>
    column === undefined ? "" : (cells[column] ?? "").trim();

  table.rows.forEach((cells, i) => {
    // 表格内行号（含表头与被剔除的标题行偏移，从 1 起）
    const rowNo = (table.hasHeader ? 1 : 0) + (table.titleRows ?? 0) + i + 1;
    if (cells.every((c) => !c || !c.trim())) return;

    const name = cellOf(cells, mapping.nameColumn);
    if (!name) {
      issues.push({ row: rowNo, name: "", reason: "姓名为空" });
      return;
    }
    if (name.length > 20) {
      issues.push({ row: rowNo, name, reason: "姓名内容异常（超过 20 字）" });
      return;
    }

    const studentNo = cellOf(cells, mapping.fields.student_no);
    if (studentNo) {
      if (seenNos.has(studentNo)) {
        issues.push({ row: rowNo, name, reason: `学号 ${studentNo} 在表内重复` });
        return;
      }
      seenNos.add(studentNo);
    }

    const gName = cellOf(cells, mapping.fields.guardian_name);
    const gPhone = cellOf(cells, mapping.fields.guardian_phone);
    const guardians: Guardian[] = (gName || gPhone)
      ? [{ name: gName || "监护人", phone: gPhone, relation: "监护人", is_primary: true }]
      : [];

    rows.push({
      name,
      gender: normalizeGender(cellOf(cells, mapping.fields.gender)),
      birth_date: normalizeDate(cellOf(cells, mapping.fields.birth_date)) || null,
      student_no: studentNo,
      grade_class: cellOf(cells, mapping.fields.grade_class),
      id_card: normalizeIdCard(cellOf(cells, mapping.fields.id_card)) || null,
      address: cellOf(cells, mapping.fields.address) || null,
      status: "active",
      note: cellOf(cells, mapping.fields.note) || null,
      guardians,
    });
  });

  return { rows, issues };
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

/** 未命名批次自动分班的前缀：无班级信息的整批导入每次新建「未命名班级N」，不再并入「未分班」 */
export const UNNAMED_CLASS_PREFIX = "未命名班级";

/** 整批行都没有填写班级（去空白后全空）→ 视为未命名批次，需自动分班 */
export function isUnnamedBatch(rows: StudentInput[]): boolean {
  return rows.length > 0 && rows.every((r) => !(r.grade_class ?? "").trim());
}

/** 在已有班级名集合之外取最小的可用序号：未命名班级1、2、3…… */
export function suggestUnnamedClassName(existingNames: Set<string>): string {
  let n = 1;
  while (existingNames.has(`${UNNAMED_CLASS_PREFIX}${n}`)) n++;
  return `${UNNAMED_CLASS_PREFIX}${n}`;
}

/** 查出现有班级并分配一个新的未命名班级名（含显式建班与学生行带出的隐式班级） */
export async function allocateUnnamedClassName(): Promise<string> {
  const classes = await listClasses();
  const names = new Set(classes.map((c) => c.name));
  const next = suggestUnnamedClassName(names);
  // 显式建班占位，避免并发导入撞名；失败静默（学生行本身也能带出班级）
  try {
    await createClass(next);
  } catch {
    /* 忽略 */
  }
  return next;
}

function normalizeClassName(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "未分班" ? "" : trimmed;
}

/**
 * 批量导入学生：学号已存在且姓名相同 → 用新上传的数据覆盖该记录
 * （保留原记录 id，照片、表现记录等关联不受影响）；学号已存在但姓名不同
 * → 跳过并提示，避免把新学生覆盖到他人档案上；无学号时按「姓名+出生日期」
 * 兜底跳过，并生成 R 前缀临时学号。
 *
 * 未命名批次（整批无班级）自动分班：互不相交的两批不再并入同一个「未分班」，
 * 全新一批新建「未命名班级N」；重导入/追增命中同一原班级时复用原班级，
 * 存量学生的原班级不会被清空覆盖。
 */
export async function importRosterStudents(prep: RosterPrepareResult): Promise<RosterImportResult> {
  const existing = await listStudents();
  const existingByNo = new Map<string, { id: number; name: string; grade_class: string }>(
    existing
      .filter((s) => s.student_no)
      .map((s) => [s.student_no, { id: s.id, name: s.name, grade_class: s.grade_class ?? "" }]),
  );
  const existingNameBirth = new Map<string, string>(
    existing
      .filter((s) => s.birth_date)
      .map((s) => [`${s.name}|${s.birth_date}`, s.grade_class ?? ""]),
  );

  const result: RosterImportResult = {
    imported: 0,
    updated: 0,
    skipped: [],
    failed: [...prep.issues],
    autoClass: null,
  };

  // 非未命名批次：保持原行为（行内显式班级落库，更新时可随新表迁移班级）
  if (!isUnnamedBatch(prep.rows)) {
    const nameBirthSet = new Set(existingNameBirth.keys());
    const stamp = Date.now().toString().slice(-8);
    let seq = 0;
    for (const row of prep.rows) {
      if (row.student_no) {
        const hit = existingByNo.get(row.student_no);
        if (hit) {
          if (hit.name === row.name) {
            try {
              await updateStudent(hit.id, row);
              if (row.birth_date) nameBirthSet.add(`${row.name}|${row.birth_date}`);
              result.updated++;
            } catch (e) {
              result.failed.push({
                row: 0,
                name: row.name,
                reason: e instanceof Error ? e.message : String(e),
              });
            }
          } else {
            result.skipped.push({
              name: row.name,
              reason: `学号 ${row.student_no} 已对应学生「${hit.name}」，姓名不一致未覆盖`,
            });
          }
          continue;
        }
      } else if (row.birth_date && nameBirthSet.has(`${row.name}|${row.birth_date}`)) {
        result.skipped.push({ name: row.name, reason: "同名同出生日期的记录已存在" });
        continue;
      }

      let studentNo = row.student_no;
      if (!studentNo) {
        do {
          studentNo = `R${stamp}${String(++seq).padStart(3, "0")}`;
        } while (existingByNo.has(studentNo));
      }

      try {
        const newId = await createStudent({ ...row, student_no: studentNo });
        existingByNo.set(studentNo, { id: newId, name: row.name, grade_class: row.grade_class });
        if (row.birth_date) nameBirthSet.add(`${row.name}|${row.birth_date}`);
        result.imported++;
      } catch (e) {
        result.failed.push({
          row: 0,
          name: row.name,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }

  // 未命名批次：先分类（命中存量 vs 全新），再决定新行去向，避免两批无辜合并
  const matchedClasses = new Set<string>();
  const newRows: StudentInput[] = [];
  for (const row of prep.rows) {
    if (row.student_no) {
      const hit = existingByNo.get(row.student_no);
      if (hit) {
        // 姓名不一致的行最终会跳过，不计入命中班级，避免干扰新行去向
        if (hit.name === row.name) {
          matchedClasses.add(normalizeClassName(hit.grade_class));
        }
        continue;
      }
      newRows.push(row);
    } else if (row.birth_date && existingNameBirth.has(`${row.name}|${row.birth_date}`)) {
      matchedClasses.add(normalizeClassName(existingNameBirth.get(`${row.name}|${row.birth_date}`)));
    } else {
      newRows.push(row);
    }
  }

  let targetForNew = "";
  if (newRows.length === 0) {
    // 纯重导入：没有新行，不分配；跳转复用唯一的原班级
    if (matchedClasses.size === 1) {
      const single = [...matchedClasses][0];
      result.autoClass = single ? single : "未分班";
    } else {
      result.autoClass = null;
    }
  } else if (matchedClasses.size === 0) {
    // 全新一批：分配新班级，两次导入自然分成两个班
    targetForNew = await allocateUnnamedClassName();
    result.autoClass = targetForNew;
  } else if (matchedClasses.size === 1) {
    const single = [...matchedClasses][0];
    if (single) {
      // 追增到同一原班级：新行并入该班
      targetForNew = single;
      result.autoClass = single;
    } else {
      // 存量全在 legacy「未分班」：新行留在未分班，与命中的老同学保持同组
      targetForNew = "";
      result.autoClass = "未分班";
    }
  } else {
    // 命中横跨多个原班级：新行单立一个新班，存量各留原位不搬家
    targetForNew = await allocateUnnamedClassName();
    result.autoClass = targetForNew;
  }

  const stamp = Date.now().toString().slice(-8);
  let seq = 0;
  const touchNameBirth = (name: string, birth: string | null, gradeClass: string) => {
    if (birth) existingNameBirth.set(`${name}|${birth}`, gradeClass);
  };

  for (const row of prep.rows) {
    if (row.student_no) {
      const hit = existingByNo.get(row.student_no);
      if (hit) {
        if (hit.name === row.name) {
          // 未命名重导入不搬家：保留存量班级，不用空值覆盖
          const effective = { ...row, grade_class: hit.grade_class ?? "" };
          try {
            await updateStudent(hit.id, effective);
            touchNameBirth(row.name, row.birth_date, hit.grade_class ?? "");
            result.updated++;
          } catch (e) {
            result.failed.push({
              row: 0,
              name: row.name,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        } else {
          result.skipped.push({
            name: row.name,
            reason: `学号 ${row.student_no} 已对应学生「${hit.name}」，姓名不一致未覆盖`,
          });
        }
        continue;
      }
    } else if (row.birth_date && existingNameBirth.has(`${row.name}|${row.birth_date}`)) {
      result.skipped.push({ name: row.name, reason: "同名同出生日期的记录已存在" });
      continue;
    }

    const effective: StudentInput = { ...row, grade_class: targetForNew };
    let studentNo = effective.student_no;
    if (!studentNo) {
      do {
        studentNo = `R${stamp}${String(++seq).padStart(3, "0")}`;
      } while (existingByNo.has(studentNo));
    }

    try {
      const newId = await createStudent({ ...effective, student_no: studentNo });
      existingByNo.set(studentNo, { id: newId, name: effective.name, grade_class: targetForNew });
      touchNameBirth(effective.name, effective.birth_date, targetForNew);
      result.imported++;
    } catch (e) {
      result.failed.push({
        row: 0,
        name: row.name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* 智能导入编排（对话框与 Agent 工具共用）                                */
/* ------------------------------------------------------------------ */

export interface SmartImportOptions {
  /** 用户指定姓名列：列名文本或从 1 开始的列号（覆盖自动识别） */
  nameColumn?: string | number;
  /** 只做解析与识别，不落库（对话框预览用） */
  dryRun?: boolean;
  /** 测试注入；缺省按当前环境创建 provider */
  llm?: AgentLlm;
  /** 测试注入；缺省读本机配置，未配置模型时只走规则识别 */
  config?: AiConfig;
}

export type SmartImportOutcome =
  | {
      status: "ok";
      table: RosterTable;
      detection: NameDetection;
      mapping: RosterMapping;
      result?: RosterImportResult;
    }
  | { status: "need-column"; detection: NameDetection; message: string }
  | { status: "error"; message: string };

/** 列说明（列名文本或从 1 起列号）→ 0 起列号；找不到返回 -1。成绩导入管道复用 */
export function resolveColumn(table: RosterTable, spec: string | number): number {
  if (typeof spec === "number" || /^\d+$/.test(String(spec).trim())) {
    const index = Number(spec) - 1;
    return index >= 0 && index < table.headers.length ? index : -1;
  }
  const text = String(spec).trim();
  if (!text) return -1;
  const exact = table.headers.findIndex((h) => h.trim() === text);
  if (exact >= 0) return exact;
  return table.headers.findIndex((h) => h.trim() && h.trim().includes(text));
}

/**
 * 智能导入编排（表格入口）：规则识别（已配置模型时叠加 AI 识别）→ 映射 → 校验
 * →（可选）落库。置信度低且用户未指定姓名列时返回 need-column（附候选），
 * 由调用方转述给用户确认。
 */
export async function runSmartImportTable(
  table: RosterTable,
  options: SmartImportOptions = {},
): Promise<SmartImportOutcome> {
  let detection = detectNameColumn(table);
  const config = options.config ?? loadAiConfig();
  if (options.nameColumn === undefined && isAiConfigured(config)) {
    const llm = options.llm ?? createLlm();
    const ai = await aiDetectNameColumn(table, llm, config);
    if (ai) detection = combineNameDetection(detection, ai);
  }

  let nameColumn = detection.selected;
  let pinned = false;
  if (options.nameColumn !== undefined) {
    nameColumn = resolveColumn(table, options.nameColumn);
    if (nameColumn < 0) {
      const listing = table.headers.map((h, i) => `${i + 1}.${h}`).join("，");
      const hint =
        typeof options.nameColumn === "number" || /^\d+$/.test(String(options.nameColumn).trim())
          ? "（列号从 1 开始，第 1 列请传 1）"
          : "";
      return {
        status: "error",
        message: `找不到姓名列「${String(options.nameColumn)}」${hint}。可用列：${listing}`,
      };
    }
    pinned = true;
  }

  if (nameColumn < 0 || (!pinned && detection.confidence === "low")) {
    const candidates = detection.candidates.length
      ? detection.candidates.map((c) => `第${c.index + 1}列「${c.header}」`).join("、")
      : "（没有发现像姓名的列）";
    return {
      status: "need-column",
      detection,
      message: `无法可靠识别姓名列（候选：${candidates}）。请向用户确认姓名在哪一列后，带 name_column 参数（列名或列号）重新调用。`,
    };
  }

  const mapping = detectFieldMapping(table, nameColumn);
  const prep = prepareRosterRows(table, mapping);
  if (!prep.rows.length) {
    const detail = prep.issues.length
      ? `问题：${prep.issues.slice(0, 3).map((it) => `第${it.row}行 ${it.reason}`).join("；")}`
      : "";
    return { status: "error", message: `没有可导入的数据行。${detail}` };
  }

  if (options.dryRun) {
    return { status: "ok", table, detection, mapping };
  }

  const result = await importRosterStudents(prep);
  return { status: "ok", table, detection, mapping, result };
}

/** 智能导入编排（文本入口）：解析 CSV/TSV 文本后走 runSmartImportTable */
export async function runSmartImport(
  text: string,
  options: SmartImportOptions = {},
): Promise<SmartImportOutcome> {
  let table: RosterTable;
  try {
    table = parseRosterTable(text);
  } catch (e) {
    return { status: "error", message: `解析表格失败：${e instanceof Error ? e.message : String(e)}` };
  }
  return runSmartImportTable(table, options);
}

/* ------------------------------------------------------------------ */
/* 指定格式模板                                                        */
/* ------------------------------------------------------------------ */

export const ROSTER_TEMPLATE_HEADERS = [
  "姓名", "性别", "学号", "出生日期", "年级班级",
  "身份证号", "监护人", "联系电话", "家庭住址", "备注",
];

/** 模板 CSV（带 BOM，Excel 双击打开不乱码） */
export function rosterTemplateCsv(): string {
  const rows: string[][] = [
    ROSTER_TEMPLATE_HEADERS,
    ["张小三", "男", "20240001", "2017-05-12", "三年级二班", "330106201705120011", "张建国", "13800128846", "杭州市西湖区文三路128号", ""],
    ["李小红", "女", "20240002", "2017-08-03", "三年级二班", "330106201708030022", "李大红", "13988772310", "", "转学生"],
  ];
  const escape = (cell: string) =>
    /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return "\uFEFF" + rows.map((r) => r.map(escape).join(",")).join("\r\n");
}

/** 下载模板 CSV（浏览器与 WebView2 通用） */
export function downloadRosterTemplate(): void {
  const blob = new Blob([rosterTemplateCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "学生花名册模板.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 指定格式模式的表头校验：必须包含「姓名」列 */
export function validateTemplateTable(table: RosterTable): { ok: boolean; missing: string[] } {
  const hasName = table.headers.some((h) => h.trim() === "姓名" || h.trim() === "学生姓名");
  return { ok: hasName, missing: hasName ? [] : ["姓名"] };
}

/** 指定格式模式：按表头精确定位姓名列；找不到返回 -1 */
export function findNameColumnByHeader(table: RosterTable): number {
  const exact = table.headers.findIndex((h) => h.trim() === "姓名");
  if (exact >= 0) return exact;
  return table.headers.findIndex((h) => h.trim() === "学生姓名");
}
