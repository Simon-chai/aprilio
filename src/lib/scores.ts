/**
 * 成绩导入核心管道（与花名册导入同构：识别 → 映射 → 校验 → 落库）。
 *
 * 管道：成绩单识别（姓名列 + 科目列 + 考试名/考试时间，规则打分 + 可选 AI）
 *      → 行校验 → 学生匹配（学号 → 班级+姓名 → 全局唯一姓名，缺失可自动建档）
 *      → 考试批次幂等复用（班级+考试名+考试时间）→ 成绩逐条 upsert。
 *
 * 「导入成绩」对话框、Agent 工具 import_score_sheet，以及花名册智能导入的
 * 成绩单分流共用这条管道。设计约定见 docs/SCORE_IMPORT.md。
 */
import { isAiConfigured, loadAiConfig, type AiConfig } from "./ai";
import {
  createStudent,
  findOrCreateExam,
  isTauri,
  listStudents,
  upsertExamScore,
} from "./db";
import { localDateStr } from "./format";
import {
  combineNameDetection,
  detectFieldMapping,
  detectNameColumn,
  resolveColumn,
  type RosterTable,
} from "./roster";
import type { AgentLlm } from "../agent/types";
import type { ClassScoreOverviewRow, Exam, ExamWithStats } from "../types";

/* ------------------------------------------------------------------ */
/* 识别结果类型                                                        */
/* ------------------------------------------------------------------ */

/** 识别出的科目列（表内列序号 + 归一化科目名） */
export interface ScoreSubjectColumn {
  index: number;
  /** 表头原文 */
  header: string;
  /** 归一化科目名（「数学成绩」→「数学」） */
  name: string;
  /** header=表头关键词命中；content=数值内容特征兜底；ai=模型识别 */
  from: "header" | "content" | "ai";
}

export interface ScoreSheetDetection {
  /** 姓名列（0 起；-1 表示没有像姓名的列） */
  nameColumn: number;
  nameDetection: ReturnType<typeof detectNameColumn>;
  subjects: ScoreSubjectColumn[];
  /** 从标题行/考试日期列提取的考试名（可能为 null，由调用方兜底） */
  examName: string | null;
  /** 提取的考试时间 YYYY-MM-DD（可能为 null） */
  examDate: string | null;
  /** 班级（「班级」列首个非空值，可能为 null） */
  className: string | null;
  /** 学号列（0 起，可能 -1） */
  studentNoColumn: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ScoreRow {
  name: string;
  student_no: string;
  /** 单科成绩（空单元格跳过） */
  scores: { subject: string; score: number | null; grade: string | null }[];
}

export interface ScorePrepareResult {
  rows: ScoreRow[];
  issues: { row: number; name: string; reason: string }[];
}

export interface ScoreImportResult {
  /** 按学号/姓名匹配到已有学生的成绩写入人数 */
  students_matched: number;
  /** 成绩单里有但档案里没有、自动新建的学生数 */
  students_created: number;
  /** 写入（含覆盖更新）的成绩条数 */
  scores_written: number;
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
}

/* ------------------------------------------------------------------ */
/* 科目与成绩单元格                                                     */
/* ------------------------------------------------------------------ */

/** 表头命中即认定为科目列的关键词（含常见科别与「XX成绩/分数」写法） */
const SUBJECT_HEADER_PATTERNS = [
  "语文", "数学", "英语", "物理", "化学", "生物", "政治", "道德与法治", "道法",
  "历史", "地理", "科学", "体育", "音乐", "美术", "信息技术", "信息",
  "品德", "科学", "score", "subject",
];

/** 汇总列不作为科目导入：总分/排名等由系统按明细计算 */
const DERIVED_HEADER_PATTERNS = ["总分", "总评", "总成绩", "合计", "平均", "排名", "名次", "均分"];

/** 这些表头是花名册字段，绝不当科目列 */
const ROSTER_HEADER_EXCLUDE = [
  "学号", "编号", "学籍", "性别", "班级", "年级", "出生", "生日", "日期", "时间",
  "监护人", "家长", "父亲", "母亲", "电话", "手机", "联系", "住址", "地址",
  "备注", "身份证", "姓名", "名字", "name", "监考", "考场", "考号",
];

/** 考试日期列的表头（列内值为每行的考试时间，取首个非空值） */
const EXAM_DATE_HEADER_PATTERNS = ["考试日期", "考试时间", "考试日期时间"];

/** 标题行里的考试关键词，命中才尝试从中提取考试名 */
const EXAM_TITLE_KEYWORDS = ["期中", "期末", "月考", "单元", "统考", "联考", "模拟", "测验", "测试", "检测", "考试", "竞赛", "成绩"];

/** 标题行尾部的表类后缀，提取考试名时剥掉 */
const TITLE_SUFFIX_PATTERN = /(成绩|分数|统计|汇总|登记|名册|一览|分析)?(单|表|册)$/;

/**
 * 表头 → 归一化科目名：「数学成绩」「数学分数」→「数学」；汇总列返回 null（不导入）。
 */
export function normalizeSubjectName(header: string): string | null {
  const h = header.trim();
  if (!h) return null;
  if (DERIVED_HEADER_PATTERNS.some((k) => h.includes(k))) return null;
  // 去掉「成绩/分数/得分/卷面分」等后缀与空白
  const cleaned = h.replace(/\s+/g, "").replace(/(成绩|分数|得分|卷面分|卷面)$/, "");
  if (!cleaned) return null;
  if (cleaned.length > 12) return null;
  return cleaned;
}

/**
 * 成绩单元格解析：数字（可带小数、可带「分」）→ score；
 * 「缺考/请假/优/A」等文字 → grade；空 → null（调用方跳过）。
 */
export function parseScoreCell(raw: string): { score: number | null; grade: string | null } {
  const v = (raw ?? "").trim();
  if (!v) return { score: null, grade: null };
  const numeric = v.replace(/分\s*$/, "");
  if (/^-?\d{1,3}(\.\d{1,2})?$/.test(numeric)) {
    const n = Number(numeric);
    // 0~1000 之外的“数字”更可能是学号/年份，不当成绩
    if (n >= 0 && n <= 1000) return { score: n, grade: null };
  }
  // 文字成绩（等级/缺考等），截断超长脏数据
  return { score: null, grade: v.slice(0, 12) };
}

/** 单元格是否像成绩数字（内容特征兜底用；排除学号/年份/电话等长数字） */
function looksLikeScoreCell(value: string): boolean {
  const { score } = parseScoreCell(value);
  return score !== null;
}

/* ------------------------------------------------------------------ */
/* 成绩单识别（规则）                                                    */
/* ------------------------------------------------------------------ */

export interface DetectScoreSheetOptions {
  /** 文件名兜底：标题行没有考试信息时从文件名提取考试名 */
  fileName?: string;
}

/** 从标题行/文件名提取考试名：命中考试关键词的行，剥掉表类后缀 */
export function extractExamName(lines: string[]): string | null {
  for (const line of lines) {
    const text = (line ?? "").trim();
    if (!text || !EXAM_TITLE_KEYWORDS.some((k) => text.includes(k))) continue;
    const cleaned = text.replace(TITLE_SUFFIX_PATTERN, "").replace(/[：:，,。;；\s]+$/, "").trim();
    if (cleaned) return cleaned.slice(0, 30);
  }
  return null;
}

/** 从文本提取考试时间：支持 2026-09-01 / 2026.9.1 / 2026年9月1日 / 20260901 */
export function extractExamDate(lines: string[]): string | null {
  for (const line of lines) {
    const text = (line ?? "").trim();
    const m =
      text.match(/(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})/) ??
      text.match(/(\d{4})(\d{2})(\d{2})/);
    if (!m) continue;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * 规则识别一张表格是否为成绩单：
 * 姓名列（复用花名册识别）+ ≥1 个科目列（表头关键词或数值内容特征）。
 * 不是成绩单（没有科目列或没有姓名列）返回 null。
 */
export function detectScoreSheet(
  table: RosterTable,
  options: DetectScoreSheetOptions = {}
): ScoreSheetDetection | null {
  const nameDetection = detectNameColumn(table);
  const nameColumn = nameDetection.selected;
  if (nameColumn < 0) return null;

  const claimed = new Set<number>([nameColumn]);
  const subjects: ScoreSubjectColumn[] = [];

  table.headers.forEach((rawHeader, index) => {
    if (claimed.has(index)) return;
    const header = rawHeader.trim();
    const lower = header.toLowerCase();
    if (!header) return;

    // 花名册字段表头直接排除
    if (ROSTER_HEADER_EXCLUDE.some((k) => lower.includes(k))) {
      // 「考试日期/考试时间」列单独认领
      if (EXAM_DATE_HEADER_PATTERNS.some((k) => header.includes(k))) {
        claimed.add(index);
      }
      return;
    }
    if (EXAM_DATE_HEADER_PATTERNS.some((k) => header.includes(k))) {
      claimed.add(index);
      return;
    }

    // 表头关键词命中 → 科目列
    if (
      SUBJECT_HEADER_PATTERNS.some((k) => lower.includes(k)) ||
      /(成绩|分数|得分)$/.test(header)
    ) {
      const name = normalizeSubjectName(header);
      if (name) {
        subjects.push({ index, header, name, from: "header" });
        claimed.add(index);
      }
      return;
    }

    // 内容特征兜底：绝大多数单元格是 0~1000 的数字 → 视为科目列（无表头成绩单）
    const values = table.rows.map((r) => (r[index] ?? "").trim()).filter(Boolean);
    if (values.length >= 3 && values.filter(looksLikeScoreCell).length / values.length >= 0.6) {
      // 表头是汇总列（总分/排名等）时整列跳过，总分由系统按明细计算
      if (DERIVED_HEADER_PATTERNS.some((k) => header.includes(k))) return;
      const name = normalizeSubjectName(header) ?? `科目${index + 1}`;
      subjects.push({ index, header, name, from: "content" });
      claimed.add(index);
    }
  });

  if (!subjects.length) return null;

  // 学号列（学生匹配主键）与班级（考试归属）
  const mapping = detectFieldMapping(table, nameColumn);
  const studentNoColumn = mapping.fields.student_no ?? -1;
  const classCol = mapping.fields.grade_class ?? -1;
  const className =
    classCol >= 0
      ? (table.rows.map((r) => (r[classCol] ?? "").trim()).find(Boolean) ?? null)
      : null;

  // 考试时间：「考试日期」列首个非空值优先，其次标题行
  const dateColIndex = table.headers.findIndex((h) =>
    EXAM_DATE_HEADER_PATTERNS.some((k) => h.trim().includes(k))
  );
  const examDate =
    (dateColIndex >= 0
      ? extractExamDate([table.rows.map((r) => (r[dateColIndex] ?? "")).find(Boolean) ?? ""])
      : null) ?? extractExamDate(table.titleText ?? []);

  const titleLines = [...(table.titleText ?? [])];
  if (options.fileName) {
    titleLines.push(options.fileName.replace(/\.[^.]+$/, ""));
  }
  const examName = extractExamName(titleLines);

  const headerSubjects = subjects.filter((s) => s.from === "header").length;
  let confidence: ScoreSheetDetection["confidence"];
  let reason: string;
  if (nameDetection.confidence === "high" && headerSubjects > 0) {
    confidence = "high";
    reason = "姓名列表头明确，且科目列均按表头识别";
  } else if (headerSubjects > 0 || nameDetection.confidence !== "low") {
    confidence = "medium";
    reason = headerSubjects
      ? "科目列按表头识别，姓名列识别把握一般"
      : `科目列按内容特征识别（数值占比高），建议人工确认`;
  } else {
    confidence = "low";
    reason = "姓名列与科目列识别把握不足，建议人工确认";
  }

  return {
    nameColumn,
    nameDetection,
    subjects,
    examName,
    examDate,
    className,
    studentNoColumn,
    confidence,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* AI 识别（可选叠加）                                                   */
/* ------------------------------------------------------------------ */

export interface AiScoreDetection {
  name_column: number;
  subjects: { column: number; name: string }[];
  exam_name?: string | null;
  exam_date?: string | null;
  confidence: number;
  reason?: string;
}

/**
 * AI 识别：把标题行与各列表头/示例值交给模型，判断姓名列、科目列与考试名/时间。
 * 返回 null 表示模型不可用或输出无法解析，调用方回退规则结果。
 */
export async function aiDetectScoreSheet(
  table: RosterTable,
  llm: AgentLlm,
  config: AiConfig
): Promise<AiScoreDetection | null> {
  const titleLines = (table.titleText ?? []).join(" / ").slice(0, 80) || "（无标题行）";
  const columnLines = table.headers
    .map((header, i) => {
      const samples = [
        ...new Set(table.rows.map((r) => (r[i] ?? "").trim()).filter(Boolean)),
      ]
        .slice(0, 4)
        .map((v) => (v.length > 10 ? v.slice(0, 10) + "…" : v))
        .join("、");
      return `第${i + 1}列「${header}」：${samples || "（空）"}`;
    })
    .join("\n");

  const system =
    "你是成绩单结构分析助手。请判断表格中哪一列是学生姓名，哪些列是考试科目成绩（总分/排名/平均分等汇总列不算科目），" +
    "并从标题行提取考试名称与考试时间。" +
    '只输出一个 JSON 对象：{"name_column": 列号(从1起), "subjects": [{"column": 列号, "name": "科目名"}], ' +
    '"exam_name": "考试名或null", "exam_date": "YYYY-MM-DD或null", "confidence": 0到1的小数, "reason": "不超过20字的理由"}，' +
    "不要输出任何其他内容。";

  try {
    const res = await llm.chat({
      system,
      messages: [
        {
          role: "user",
          content: `标题行：${titleLines}\n表格共 ${table.headers.length} 列：\n${columnLines}`,
        },
      ],
      tools: [],
      config,
    });
    const match = res.content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<AiScoreDetection>;
    const nameColumn = Number(parsed.name_column);
    if (!Number.isInteger(nameColumn) || nameColumn < 1 || nameColumn > table.headers.length) {
      return null;
    }
    const subjects = (Array.isArray(parsed.subjects) ? parsed.subjects : [])
      .map((s) => ({ column: Number(s?.column) - 1, name: String(s?.name ?? "").trim() }))
      .filter(
        (s) =>
          Number.isInteger(s.column) &&
          s.column >= 0 &&
          s.column < table.headers.length &&
          s.column !== nameColumn - 1 &&
          s.name &&
          s.name.length <= 12
      );
    const examName =
      typeof parsed.exam_name === "string" && parsed.exam_name.trim()
        ? parsed.exam_name.trim().slice(0, 30)
        : null;
    const examDate =
      typeof parsed.exam_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.exam_date)
        ? parsed.exam_date
        : null;
    return {
      name_column: nameColumn - 1,
      subjects,
      exam_name: examName,
      exam_date: examDate,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 40) : "",
    };
  } catch {
    return null;
  }
}

/** 规则结果 + AI 结果合成：AI 的科目/考试信息优先，列号经规则校验防幻觉 */
export function combineScoreDetection(
  table: RosterTable,
  rule: ScoreSheetDetection,
  ai: AiScoreDetection
): ScoreSheetDetection {
  const aiSubjects: ScoreSubjectColumn[] = ai.subjects
    .filter((s) => !rule.subjects.some((r) => r.index === s.column))
    .map((s) => ({
      index: s.column,
      header: table.headers[s.column] ?? `第${s.column + 1}列`,
      name: s.name,
      from: "ai" as const,
    }));
  const subjects = [...rule.subjects, ...aiSubjects].sort((a, b) => a.index - b.index);

  const confidence =
    ai.confidence >= 0.7 && subjects.length > 0 ? ("high" as const) : rule.confidence;
  return {
    ...rule,
    subjects,
    examName: ai.exam_name ?? rule.examName,
    examDate: ai.exam_date ?? rule.examDate,
    confidence,
    reason: ai.reason || rule.reason,
  };
}

/* ------------------------------------------------------------------ */
/* 行构建                                                               */
/* ------------------------------------------------------------------ */

/**
 * 按识别结果把表格行转成成绩行：姓名缺失的行进 issues，
 * 空科目单元格跳过，文字成绩（缺考/等级）原样保留。
 */
export function prepareScoreRows(table: RosterTable, detection: ScoreSheetDetection): ScorePrepareResult {
  const rows: ScoreRow[] = [];
  const issues: ScorePrepareResult["issues"] = [];

  table.rows.forEach((cells, i) => {
    const rowNo = (table.hasHeader ? 1 : 0) + (table.titleRows ?? 0) + i + 1;
    if (cells.every((c) => !c || !c.trim())) return;

    const name = detection.nameColumn >= 0 ? (cells[detection.nameColumn] ?? "").trim() : "";
    if (!name) {
      issues.push({ row: rowNo, name: "", reason: "姓名为空" });
      return;
    }

    const student_no =
      detection.studentNoColumn >= 0 ? (cells[detection.studentNoColumn] ?? "").trim() : "";

    const scores: ScoreRow["scores"] = [];
    for (const subj of detection.subjects) {
      const parsed = parseScoreCell(cells[subj.index] ?? "");
      if (parsed.score === null && parsed.grade === null) continue;
      scores.push({ subject: subj.name, score: parsed.score, grade: parsed.grade });
    }
    if (!scores.length) {
      issues.push({ row: rowNo, name, reason: "没有可导入的成绩（科目列全为空）" });
      return;
    }

    rows.push({ name, student_no, scores });
  });

  return { rows, issues };
}

/* ------------------------------------------------------------------ */
/* 落库                                                                */
/* ------------------------------------------------------------------ */

export interface ImportScoreBatchOptions {
  /** 成绩归属班级（自动建档/按班匹配时用）；缺省按成绩单「班级」列或全局匹配 */
  className?: string;
  /** 成绩单里没有的学生是否自动建档（默认是） */
  autoCreateStudents?: boolean;
}

/**
 * 批量写入一批成绩到指定考试：
 * 学生匹配 学号 → 班级+姓名 → 全局唯一姓名；匹配不到且允许时自动建档
 * （姓名 + 班级，生成 S 前缀临时学号），让「成绩单即花名册」的场景一次跑通。
 */
export async function importScoreBatch(
  prep: ScorePrepareResult,
  exam: Pick<Exam, "id">,
  options: ImportScoreBatchOptions = {}
): Promise<ScoreImportResult> {
  const autoCreate = options.autoCreateStudents !== false;
  const className = options.className?.trim() ?? "";
  const existing = await listStudents();
  const byNo = new Map<string, { id: number; name: string; grade_class: string }>(
    existing.filter((s) => s.student_no).map((s) => [s.student_no, { id: s.id, name: s.name, grade_class: s.grade_class }]),
  );

  const result: ScoreImportResult = {
    students_matched: 0,
    students_created: 0,
    scores_written: 0,
    skipped: [...prep.issues.map((it) => ({ name: it.name || `第${it.row}行`, reason: it.reason }))],
    failed: [],
  };

  const stamp = Date.now().toString().slice(-8);
  let seq = 0;
  const createdIds = new Set<number>();

  for (const row of prep.rows) {
    let studentId = 0;

    if (row.student_no) {
      const hit = byNo.get(row.student_no);
      if (hit) {
        if (hit.name === row.name) {
          studentId = hit.id;
        } else {
          result.skipped.push({
            name: row.name,
            reason: `学号 ${row.student_no} 已对应学生「${hit.name}」，姓名不一致未导入`,
          });
          continue;
        }
      }
    }

    if (!studentId) {
      // 匹配顺序：学号 → 班级内唯一姓名 → 全局唯一姓名；都未命中按需自动建档
      const classHits = className
        ? existing.filter((s) => s.name === row.name && s.grade_class === className && !createdIds.has(s.id))
        : [];
      const globalHits = existing.filter((s) => s.name === row.name && !createdIds.has(s.id));

      if (classHits.length === 1) {
        studentId = classHits[0].id;
      } else if (!classHits.length && globalHits.length === 1) {
        studentId = globalHits[0].id;
      } else if (globalHits.length > 1) {
        result.skipped.push({
          name: row.name,
          reason: "存在多名同名学生且归属班级不明确，未导入（可指定班级后重试）",
        });
        continue;
      } else if (autoCreate) {
        const studentNo =
          row.student_no && !byNo.has(row.student_no)
            ? row.student_no
            : `S${stamp}${String(++seq).padStart(3, "0")}`;
        try {
          const newId = await createStudent({
            name: row.name,
            gender: "男",
            birth_date: null,
            student_no: studentNo,
            grade_class: className,
            id_card: null,
            address: null,
            status: "active",
            note: "成绩单导入自动建档",
            guardians: [],
          });
          studentId = newId;
          createdIds.add(newId);
          byNo.set(studentNo, { id: newId, name: row.name, grade_class: className });
          result.students_created++;
        } catch (e) {
          result.failed.push({
            name: row.name,
            reason: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
      } else {
        result.skipped.push({ name: row.name, reason: "档案中找不到该学生" });
        continue;
      }
    }

    if (studentId && !createdIds.has(studentId)) result.students_matched++;

    for (const s of row.scores) {
      try {
        await upsertExamScore(exam.id, studentId, s.subject, s.score, s.grade);
        result.scores_written++;
      } catch (e) {
        result.failed.push({
          name: `${row.name}·${s.subject}`,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* 智能导入编排（对话框与 Agent 工具共用）                                */
/* ------------------------------------------------------------------ */

export interface SmartScoreImportOptions {
  /** 成绩归属班级（班级详情页/Agent 工具传入；缺省按成绩单「班级」列） */
  className?: string;
  /** 指定考试名（覆盖自动提取） */
  examName?: string;
  /** 指定考试时间 YYYY-MM-DD（覆盖自动提取） */
  examDate?: string;
  /** 用户指定姓名列：列名文本或从 1 开始的列号（覆盖自动识别） */
  nameColumn?: string | number;
  /** 成绩单里没有的学生是否自动建档（默认是） */
  autoCreateStudents?: boolean;
  /** 只做识别与校验，不落库（对话框预览用） */
  dryRun?: boolean;
  /** 测试注入；缺省按当前环境创建 provider */
  llm?: AgentLlm;
  /** 测试注入；缺省读本机配置，未配置模型时只走规则识别 */
  config?: AiConfig;
  /** 文件名兜底提取考试名 */
  fileName?: string;
}

export type SmartScoreImportOutcome =
  | {
      status: "ok";
      table: RosterTable;
      detection: ScoreSheetDetection;
      exam: Exam;
      examCreated: boolean;
      result?: ScoreImportResult;
    }
  | { status: "not-score-sheet"; message: string }
  | { status: "need-column"; detection: ScoreSheetDetection; message: string }
  | { status: "error"; message: string };

/**
 * 智能成绩导入编排（表格入口）：成绩单识别（已配置模型时叠加 AI）→ 校验
 * → 考试批次幂等复用 → 成绩落库。置信度低且未指定姓名列时返回 need-column。
 */
export async function runSmartScoreImport(
  table: RosterTable,
  options: SmartScoreImportOptions = {}
): Promise<SmartScoreImportOutcome> {
  let detection = detectScoreSheet(table, { fileName: options.fileName });
  const config = options.config ?? loadAiConfig();
  if (isAiConfigured(config)) {
    const llm = options.llm ?? (isTauri() ? (await import("../agent/providers")).createLlm() : undefined);
    if (llm) {
      const ai = await aiDetectScoreSheet(table, llm, config);
      if (ai && ai.subjects.length) {
        detection = combineScoreDetection(
          table,
          detection ?? fallbackDetection(table, ai),
          ai
        );
      }
    }
  }

  if (!detection) {
    return {
      status: "not-score-sheet",
      message:
        "这张表格不像成绩单：没有识别到科目成绩列。如果要导入的是学生花名册，请使用「导入花名册」。",
    };
  }

  let nameColumn = detection.nameColumn;
  if (options.nameColumn !== undefined) {
    nameColumn = resolveColumn(table, options.nameColumn);
    if (nameColumn < 0) {
      const listing = table.headers.map((h, i) => `${i + 1}.${h}`).join("，");
      return {
        status: "error",
        message: `找不到姓名列「${String(options.nameColumn)}」。可用列：${listing}`,
      };
    }
    detection = { ...detection, nameColumn };
  } else if (nameColumn < 0 || detection.confidence === "low") {
    const candidates = detection.nameDetection.candidates.length
      ? detection.nameDetection.candidates.map((c) => `第${c.index + 1}列「${c.header}」`).join("、")
      : "（没有发现像姓名的列）";
    return {
      status: "need-column",
      detection,
      message: `无法可靠识别成绩单的姓名列（候选：${candidates}）。请向用户确认姓名在哪一列后，带 name_column 参数（列名或列号）重新调用。`,
    };
  }

  const prep = prepareScoreRows(table, detection);
  if (!prep.rows.length) {
    const detail = prep.issues.length
      ? `问题：${prep.issues.slice(0, 3).map((it) => `第${it.row}行 ${it.reason}`).join("；")}`
      : "";
    return { status: "error", message: `没有可导入的成绩行。${detail}` };
  }

  const examName = (options.examName ?? detection.examName ?? "未命名考试").trim() || "未命名考试";
  const examDate = options.examDate ?? detection.examDate ?? localDateStr();
  const className = (options.className ?? detection.className ?? "").trim();

  if (options.dryRun) {
    return {
      status: "ok",
      table,
      detection,
      exam: {
        id: 0,
        class_name: className,
        name: examName,
        exam_date: examDate,
        note: null,
        created_at: "",
        updated_at: "",
      },
      examCreated: false,
    };
  }

  const { exam, created } = await findOrCreateExam({
    class_name: className,
    name: examName,
    exam_date: examDate,
  });
  const result = await importScoreBatch(prep, exam, {
    className: className || undefined,
    autoCreateStudents: options.autoCreateStudents,
  });
  return { status: "ok", table, detection, exam, examCreated: created, result };
}

/** 规则识别失败但 AI 给出科目列时的最小兜底检测结果 */
function fallbackDetection(table: RosterTable, ai: AiScoreDetection): ScoreSheetDetection {
  const nameDetection = detectNameColumn(table);
  return {
    nameColumn: ai.name_column,
    nameDetection: combineNameDetection(nameDetection, {
      index: ai.name_column,
      confidence: ai.confidence,
      reason: ai.reason ?? "AI 识别",
    }),
    subjects: ai.subjects.map((s) => ({
      index: s.column,
      header: table.headers[s.column] ?? `第${s.column + 1}列`,
      name: s.name,
      from: "ai" as const,
    })),
    examName: ai.exam_name ?? null,
    examDate: ai.exam_date ?? null,
    className: null,
    studentNoColumn: -1,
    confidence: "medium",
    reason: ai.reason || "AI 识别",
  };
}

/* ------------------------------------------------------------------ */
/* 班级成绩总览（班级管理「每个学生每次成绩」矩阵）                        */
/* ------------------------------------------------------------------ */

export type { ClassScoreOverviewRow, ExamWithStats };
