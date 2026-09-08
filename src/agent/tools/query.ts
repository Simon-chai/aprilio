/**
 * 工具：query_data —— 数据查询（声明式注册，default export 即被容器装载）。
 *
 * 只暴露结构化参数（实体 + 过滤条件），不把裸 SQL 交给模型：
 * 避免注入与误写，也和 lib/db.ts 的查询能力对齐。
 * 浏览器演示态走内存示例数据，桌面端走 SQLite，同一套返回结构。
 */
import {
  getStats,
  listBehaviorRecords,
  listExamScores,
  listExams,
  listPhotos,
  listStudents,
} from "../../lib/db";
import { defineAgentTool } from "../define";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** 隐私注意：返回值会进入 LLM 上下文。云 API 场景的脱敏策略见 docs/AGENT.md */
export default defineAgentTool({
  name: "query_data",
  label: "数据查询",
  description:
    "查询应用数据库：学生档案（students）、照片记录（photos）、汇总统计（stats）、日常表现（behaviors）、考试批次（exams）、成绩明细（scores）。" +
    "数据分析、数量统计、条件筛选都用它；查成绩统计与排名时先用它拿到班级/考试/学生 ID，再配合 analyze 工具做深度分析。",
  tags: ["readonly"],
  parameters: {
    type: "object",
    properties: {
      entity: {
        type: "string",
        enum: ["students", "photos", "stats", "behaviors", "exams", "scores"],
        description: "查询实体",
      },
      keyword: {
        type: "string",
        description:
          "关键词：students 按姓名/学号模糊匹配；photos 按说明/文件名匹配；behaviors 按评语/维度名匹配；exams 按考试名匹配；scores 忽略；stats 忽略",
      },
      exam_type: {
        type: "string",
        enum: ["major", "minor"],
        description: "考试种类过滤，仅 exams 生效：major 大考（期中/期末）| minor 小考（单元/月考等）",
      },
      grade_class: {
        type: "string",
        description: "班级过滤，如「四年级一班」，仅 students、exams、scores 生效",
      },
      student_id: {
        type: "number",
        description: "按学生 ID 过滤，仅 photos、behaviors、scores 生效",
      },
      exam_id: {
        type: "number",
        description: "按考试批次 ID 过滤成绩明细，仅 scores 生效（先用 exams 实体拿到 ID）",
      },
      subject: {
        type: "string",
        description: "按科目过滤成绩明细，如「语文」，仅 scores 生效",
      },
      polarity: {
        type: "string",
        enum: ["praise", "improve", "neutral"],
        description: "按评价倾向过滤表现流水：praise（表扬）| improve（待改进）| neutral（中立），仅 behaviors 生效",
      },
      dimension_name: {
        type: "string",
        description: "按表现维度名称过滤，如「课堂表现」、「作业情况」，仅 behaviors 生效",
      },
      limit: {
        type: "number",
        description: "最多返回条数，默认 20，上限 100",
      },
    },
    required: ["entity"],
  },
  async execute(args) {
    const entity = String(args.entity ?? "");
    const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
    const limit = clampLimit(args.limit);

    if (entity === "students") {
      const all = await listStudents(keyword);
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const filtered = gradeClass
        ? all.filter((s) => (s.grade_class ?? "").includes(gradeClass))
        : all;
      const rows = filtered.slice(0, limit);
      return {
        ok: true,
        summary: `学生查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "photos") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const all = await listPhotos(studentId);
      const filtered = keyword
        ? all.filter(
            (p) =>
              (p.caption ?? "").includes(keyword) || p.file_name.toLowerCase().includes(keyword.toLowerCase()),
          )
        : all;
      const rows = filtered.slice(0, limit);
      return {
        ok: true,
        summary: `照片查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "stats") {
      const stats = await getStats();
      return { ok: true, summary: `应用统计：${JSON.stringify(stats)}`, data: stats };
    }

    if (entity === "exams") {
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const examType = args.exam_type === "major" || args.exam_type === "minor" ? args.exam_type : "";
      const all = await listExams(gradeClass || undefined);
      const filtered = all
        .filter((e) => (examType ? e.exam_type === examType : true))
        .filter((e) => (keyword ? e.name.includes(keyword) || e.class_name.includes(keyword) : true));
      const rows = filtered.slice(0, limit);
      const summary = rows
        .map(
          (e) =>
            `[#${e.id}] ${e.class_name || "未分班"} · ${e.name}（${e.exam_date}，${e.exam_type === "major" ? "大考" : "小考"}）· 科目 ${e.subject_count} · 成绩 ${e.score_count} 条 · 学生 ${e.student_count} 人`,
        )
        .join("\n");
      return {
        ok: true,
        summary: `考试批次查询：命中 ${filtered.length} 场，返回前 ${rows.length} 场。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "scores") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const examId = Number.isInteger(Number(args.exam_id)) ? Number(args.exam_id) : undefined;
      const gradeClass = typeof args.grade_class === "string" ? args.grade_class.trim() : "";
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      const rows = await listExamScores({
        examId,
        studentId,
        subject: subject || undefined,
        className: gradeClass || undefined,
        limit,
      });
      const summary = rows
        .map(
          (r) =>
            `${r.student_name}（${r.student_no ?? "无学号"}）· ${r.subject} · ${
              r.score !== null ? r.score : (r.grade ?? "—")
            }`,
        )
        .join("\n");
      return {
        ok: true,
        summary: `成绩明细查询：命中 ${rows.length} 条（上限 ${limit}）。\n${summary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    if (entity === "behaviors") {
      const studentId = Number.isInteger(Number(args.student_id))
        ? Number(args.student_id)
        : undefined;
      const all = await listBehaviorRecords(studentId, 100);
      const polarity = typeof args.polarity === "string" ? args.polarity.trim() : "";
      const dimensionName = typeof args.dimension_name === "string" ? args.dimension_name.trim() : "";

      const filtered = all.filter((r) => {
        if (polarity && r.type !== polarity) return false;
        if (dimensionName && r.dimension_name_snap !== dimensionName) return false;
        if (keyword && !r.comment.includes(keyword) && !r.dimension_name_snap.includes(keyword)) {
          return false;
        }
        return true;
      });

      const rows = filtered.slice(0, limit);
      const rowsSummary = rows
        .map((r) => {
          const icon = r.type === "praise" ? "👍" : r.type === "neutral" ? "➖" : "⚠️";
          const suffix = studentId === undefined ? ` (学生ID: ${r.student_id})` : "";
          return `[${r.recorded_date}] ${r.dimension_name_snap} ${icon} ${r.comment}${suffix}`;
        })
        .join("\n");

      return {
        ok: true,
        summary: `日常表现查询：命中 ${filtered.length} 条，返回前 ${rows.length} 条。\n${rowsSummary || JSON.stringify(rows)}`,
        data: rows,
      };
    }

    return {
      ok: false,
      summary: "",
      error: `未知查询实体 "${entity}"，可选：students、photos、stats、behaviors、exams、scores。`,
    };
  },
});
