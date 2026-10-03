/**
 * 工具：generate_parent_summary —— 家校沟通总结（发起生成，不直接写档案）。
 *
 * 按指定时段内的学生评价生成给家长的表现总结：
 * - 单个学生 → 跳转到该生档案的「家校沟通」页签并自动开始生成，可在页签里
 *   补充个性化要求重新生成（聊天式多轮重写）、一键应用到学生档案
 * - 一键全班 → 打开班级层的批量对话框逐个生成，生成后逐个复制 / 应用
 * 是否写入学生档案（学期评语）永远由用户点击「应用到档案」确认——
 * 因此本工具本身不是写操作，无需确认门；调用前应向用户说明将要为谁生成。
 */
import {
  openParentSummaryBatch,
  openParentSummaryPanel,
  type ParentSummaryRangePreset,
} from "../../composables/useParentSummary";
import { isAiConfigured, loadAiConfig } from "../../lib/ai";
import { getStudent, isTauri, listStudents } from "../../lib/db";
import { resolveReportRange } from "../../lib/report";
import { currentSemester } from "../../lib/timetable";
import { defineAgentTool } from "../define";

/** 校验并归一时间范围参数；非法时抛出带中文提示的错误 */
function resolveRangePreset(args: Record<string, unknown>): ParentSummaryRangePreset {
  const semester = typeof args.semester === "string" ? args.semester.trim() : "";
  const start = typeof args.start === "string" ? args.start.trim() : "";
  const end = typeof args.end === "string" ? args.end.trim() : "";
  if (start || end) {
    resolveReportRange({ mode: "custom", start, end });
    return { mode: "custom", start, end };
  }
  const sem = semester || currentSemester();
  resolveReportRange({ mode: "semester", semester: sem });
  return { mode: "semester", semester: sem };
}

/** 范围展示文本（工具回执里说明生成的是哪段时间） */
function rangeTextOf(preset: ParentSummaryRangePreset): string {
  return preset.mode === "custom"
    ? `${preset.start} ~ ${preset.end}`
    : `${preset.semester} 学期`;
}

export default defineAgentTool({
  name: "generate_parent_summary",
  label: "家校沟通总结",
  description:
    "按指定时段内的学生评价，生成给家长的家校沟通表现总结。目标三选一：student_id（学生 ID）、" +
    "student_name（学生姓名，重名时工具会报出候选）、class_name（一键全班生成）；" +
    "时段可用 semester（如 2026-2027-1）或 start/end（YYYY-MM-DD）指定，缺省当前学期；" +
    "requirement 为个性化写作要求（如「多肯定课堂发言，语气温和」）。" +
    "单个学生：自动跳转到该生档案的「家校沟通」页签并开始生成，用户可在页签里补充要求重新生成、一键应用到档案；" +
    "全班：打开批量对话框逐个生成，用户在对话框里逐个复制 / 应用。" +
    "写入学生档案永远由用户确认，本工具不需要 confirm。调用前先向用户说明将为谁、哪个时段生成；" +
    "全班生成耗时较长，完成后请引导用户在对话框中逐个查看与应用。",
  tags: ["students", "communication"],
  parameters: {
    type: "object",
    properties: {
      student_id: {
        type: "number",
        description: "学生 ID（与 student_name / class_name 三选一；优先级最高）",
      },
      student_name: {
        type: "string",
        description: "学生姓名（支持部分匹配；多个命中时工具会返回候选请用户澄清）",
      },
      class_name: {
        type: "string",
        description: "班级名称：指定时对全班一键生成；单独使用即全班模式，也可用于限定学生所属班级",
      },
      semester: {
        type: "string",
        description: "学期号（如 2026-2027-1）；与 start/end 二选一，缺省当前学期",
      },
      start: {
        type: "string",
        description: "自定义起始日期（YYYY-MM-DD），与 end 搭配使用",
      },
      end: {
        type: "string",
        description: "自定义结束日期（YYYY-MM-DD），与 start 搭配使用",
      },
      requirement: {
        type: "string",
        description: "个性化写作要求（用户对总结的额外期望），可不传",
      },
    },
  },
  async execute(args, ctx) {
    if (!isTauri() || !isAiConfigured(loadAiConfig())) {
      return {
        ok: false,
        summary: "",
        error: "尚未配置 AI 模型，无法生成家校沟通总结。请先到「设置中心 · 数据与设置」配置模型后再试。",
      };
    }

    /* ---- 解析目标：student_id > student_name（可被 class_name 限定）> class_name 全班 ---- */
    const classNameArg = typeof args.class_name === "string" ? args.class_name.trim() : "";
    const studentNameArg = typeof args.student_name === "string" ? args.student_name.trim() : "";
    const studentIdArg = Number(args.student_id);

    let studentId: number | null = null;
    let studentName = "";
    let className = classNameArg;

    if (Number.isInteger(studentIdArg) && studentIdArg > 0) {
      const s = await getStudent(studentIdArg);
      if (!s) {
        return { ok: false, summary: "", error: `未找到 ID 为 ${studentIdArg} 的学生。` };
      }
      studentId = s.id;
      studentName = s.name;
      className = s.grade_class || classNameArg;
    } else if (studentNameArg) {
      let candidates = await listStudents(studentNameArg);
      if (classNameArg) candidates = candidates.filter((s) => s.grade_class === classNameArg);
      const exact = candidates.filter((s) => s.name === studentNameArg);
      const matched = exact.length ? exact : candidates;
      if (matched.length === 0) {
        return {
          ok: false,
          summary: "",
          error: classNameArg
            ? `在「${classNameArg}」没有找到叫「${studentNameArg}」的学生。`
            : `没有找到叫「${studentNameArg}」的学生。`,
        };
      }
      if (matched.length > 1) {
        const list = matched
          .slice(0, 5)
          .map((s) => `${s.name}（${s.grade_class || "未分班"}，ID ${s.id}）`)
          .join("、");
        return {
          ok: false,
          summary: "",
          error: `找到 ${matched.length} 位名为「${studentNameArg}」的学生：${list}。请向用户确认是哪一位（可提供学生 ID 或班级）后重试。`,
        };
      }
      studentId = matched[0].id;
      studentName = matched[0].name;
      className = matched[0].grade_class || classNameArg;
    }

    if (!studentId && !className) {
      return {
        ok: false,
        summary: "",
        error: "缺少生成目标：请提供 student_id / student_name（单个学生）或 class_name（一键全班）。",
      };
    }

    /* ---- 解析时段并发起：单生进学生档案页签，全班进批量对话框 ---- */
    let range: ParentSummaryRangePreset;
    try {
      range = resolveRangePreset(args);
    } catch (e) {
      return {
        ok: false,
        summary: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const requirement = typeof args.requirement === "string" ? args.requirement.trim() : "";

    const rangeText = rangeTextOf(range);
    const requirementText = requirement ? "，已带上个性化要求" : "";

    if (studentId) {
      openParentSummaryPanel({ studentId, range, autoStart: true, requirement });
      // 预设已就位：跳到学生档案，面板挂载/监听会消费预设并自动生成
      try {
        await ctx?.router?.push({ name: "student-detail", params: { id: String(studentId) } });
      } catch {
        // 跳转失败不阻断：预设仍在，用户手动进入该生档案的「家校沟通」页签即可看到生成
      }
      return {
        ok: true,
        summary: `已打开 ${studentName}（${className || "未分班"}）学生档案的「家校沟通」页签，正在生成${rangeText}的表现总结${requirementText}。完成后用户可在页签里补充个性化要求重新生成，或一键应用到学生档案。`,
        data: { student_id: studentId, class_name: className, range },
      };
    }

    openParentSummaryBatch({ className, range, autoStart: true, requirement });
    return {
      ok: true,
      summary: `已打开「家校沟通总结 · 全班批量」对话框，正在为「${className}」全班学生逐个生成${rangeText}的表现总结${requirementText}。完成后请引导用户在对话框中逐个查看与应用；需要个性化重写可进入学生档案的「家校沟通」页签。`,
      data: { class_name: className, range },
    };
  },
});
