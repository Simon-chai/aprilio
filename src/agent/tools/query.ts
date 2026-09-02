/**
 * 工具 2：query_data —— 数据查询（数据库查询）。
 *
 * 只暴露结构化参数（实体 + 过滤条件），不把裸 SQL 交给模型：
 * 避免注入与误写，也和 lib/db.ts 的查询能力对齐。
 * 浏览器演示态走内存示例数据，桌面端走 SQLite，同一套返回结构。
 */
import { getStats, listPhotos, listStudents } from "../../lib/db";
import type { AgentTool, ToolResult } from "../types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/** 隐私注意：返回值会进入 LLM 上下文。云 API 场景的脱敏策略见 docs/AGENT.md */
export function queryDataTool(): AgentTool {
  return {
    definition: {
      name: "query_data",
      description:
        "查询应用数据库：学生档案（students）、照片记录（photos）、汇总统计（stats）。数据分析、数量统计、条件筛选都用它。",
      parameters: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            enum: ["students", "photos", "stats"],
            description: "查询实体",
          },
          keyword: {
            type: "string",
            description: "关键词：students 按姓名/学号模糊匹配；photos 按说明/文件名匹配；stats 忽略",
          },
          grade_class: {
            type: "string",
            description: "班级过滤，如「三年级二班」，仅 students 生效",
          },
          student_id: {
            type: "number",
            description: "按学生 ID 过滤照片，仅 photos 生效",
          },
          limit: {
            type: "number",
            description: "最多返回条数，默认 20，上限 100",
          },
        },
        required: ["entity"],
      },
    },
    async execute(args): Promise<ToolResult> {
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

      return { ok: false, summary: "", error: `未知查询实体 "${entity}"，可选：students、photos、stats。` };
    },
  };
}
