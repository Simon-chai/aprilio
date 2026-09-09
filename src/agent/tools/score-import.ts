/**
 * 工具：import_score_sheet —— 成绩单导入（声明式注册，default export 即被容器装载）。
 *
 * 用户让 AI 助手导入成绩单时走这里，底层与「导入成绩」对话框共用同一条智能
 * 导入管道（src/lib/scores.ts）：识别姓名列与科目列（规则 + 可选 AI）→ 从
 * 标题行提取考试名/考试时间 → 考试批次幂等复用 → 成绩落库（档案里没有的
 * 学生自动建档，学号或姓名匹配已有档案）。
 *
 * 标记为写操作（dangerous: true），必须包含 confirm 参数；姓名列置信度低时
 * 不落库，返回候选列让模型向用户确认后带 name_column 重试。
 */
import { isTauri } from "../../lib/db";
import { logError, logInfo } from "../../lib/logger";
import { loadRosterTable, pickRosterFiles, type LoadedRoster } from "../../lib/roster";
import { runSmartScoreImport, type SmartScoreImportOutcome } from "../../lib/scores";
import { applyInferredClassMeta } from "../../lib/semester-ai";
import { defineAgentTool } from "../define";

export default defineAgentTool({
  name: "import_score_sheet",
  label: "成绩单导入",
  description:
    "导入考试成绩单（XLSX/XLS/XLSM/XLSB/ODS/CSV/TSV/TXT），每文件独立生成一次考试批次并关联成绩到学生档案。" +
    "一次可导入多个文件（file_paths 数组，每文件独立识别、独立考试）；exam_name / exam_date 为统一覆盖（多文件时慎用，缺省时每文件从各自标题行提取）。" +
    "智能识别姓名列与科目列（语文/数学/英语等，总分/排名列自动忽略），" +
    "同一班级同考试名同时间的批次自动复用（重复导入只更新成绩）。" +
    "成绩单里没有的学生会自动建档（可用 auto_create_students=false 关闭）。" +
    "file_path / file_paths 缺省时弹出系统文件选择框由用户选择（可多选）。" +
    "姓名列置信度低时会返回候选列，需询问用户姓名在哪一列后带 name_column 参数（列名或列号）重新调用。" +
    "此工具会写入成绩并可能批量创建学生，必须先征得用户同意并附带 confirm:true 确认。",
  tags: ["exams", "write"],
  dangerous: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "成绩单文件路径（Excel 或 CSV/TSV/TXT）。缺省时弹出文件选择框让用户选择",
      },
      file_paths: {
        type: "array",
        items: { type: "string" },
        description: "一次导入多个成绩单文件（每文件独立生成一次考试）。与 file_path 二选一，都缺省时弹出文件选择框",
      },
      exam_name: {
        type: "string",
        description: "考试名称（如「期中考试」）。缺省时从成绩单标题行自动提取，提取不到记为「未命名考试」",
      },
      exam_date: {
        type: "string",
        description: "考试时间，格式 YYYY-MM-DD。缺省时从成绩单标题行/考试日期列自动提取，提取不到记为今天",
      },
      class_name: {
        type: "string",
        description: "成绩归属班级（如「三年级二班」）。缺省时按成绩单「班级」列，识别不到则不限定班级",
      },
      name_column: {
        type: "string",
        description:
          "姓名列，列名文本或从 1 开始的列号（如 \"姓名\" 或 \"3\"）。缺省时自动识别；识别置信度低时必须提供",
      },
      auto_create_students: {
        type: "boolean",
        description: "成绩单里的学生不在档案中时是否自动建档，默认 true。传 false 时这些学生将被跳过",
      },
      confirm: {
        type: "boolean",
        description: "写操作确认标记：涉及成绩写入与可能的学生建档，必须在用户明确同意后传 true",
      },
    },
    required: [],
  },
  async execute(args) {
    if (!isTauri()) {
      return {
        ok: false,
        summary: "",
        error:
          "浏览器演示态无法读取本地文件。请在桌面端使用，或到「班级管理」详情页的「考试成绩」标签用「导入成绩」对话框手动导入。",
      };
    }

    let loadedList: LoadedRoster[];
    const rawPaths = Array.isArray(args.file_paths)
      ? (args.file_paths as unknown[]).map((p) => String(p ?? "").trim()).filter(Boolean)
      : [];
    const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
    const paths = rawPaths.length ? rawPaths : filePath ? [filePath] : [];
    if (paths.length) {
      loadedList = [];
      for (const p of paths) {
        try {
          loadedList.push(await loadRosterTable(p));
        } catch (e) {
          return { ok: false, summary: "", error: `读取成绩单失败「${p}」：${e instanceof Error ? e.message : String(e)}` };
        }
      }
    } else {
      const picked = await pickRosterFiles();
      if (!picked || !picked.length) {
        return { ok: false, summary: "", error: "用户没有选择文件，导入已取消。" };
      }
      loadedList = picked;
    }

    const opt = (key: string): string | undefined => {
      const v = args[key];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };

    const multi = loadedList.length > 1;
    let totalWritten = 0;
    let totalMatched = 0;
    let totalCreated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    const fileLines: string[] = [];
    const metaNotes: string[] = [];

    for (const loaded of loadedList) {
      let outcome: SmartScoreImportOutcome;
      try {
        // 不传 config：runSmartScoreImport 缺省读本机模型配置，已配置模型时叠加 AI 识别
        outcome = await runSmartScoreImport(loaded.table, {
          className: opt("class_name"),
          examName: opt("exam_name"),
          examDate: opt("exam_date"),
          nameColumn: opt("name_column"),
          autoCreateStudents: args.auto_create_students === false ? false : undefined,
          fileName: loaded.fileName,
        });
      } catch (e) {
        logError("成绩单导入失败", e);
        return { ok: false, summary: "", error: `成绩单导入失败「${loaded.fileName}」：${e instanceof Error ? e.message : String(e)}` };
      }

      if (outcome.status !== "ok") {
        return { ok: false, summary: "", error: multi ? `「${loaded.fileName}」${outcome.message}` : outcome.message };
      }

      const { exam, examCreated, detection, result } = outcome;
      if (!result) {
        return { ok: false, summary: "", error: "导入流程异常：缺少导入结果。" };
      }

      totalWritten += result.scores_written;
      totalMatched += result.students_matched;
      totalCreated += result.students_created;
      totalSkipped += result.skipped.length;
      totalFailed += result.failed.length;

      const fileLabel = loaded.fileName;
      const sheetSuffix = loaded.kind === "table" && loaded.sheet ? `（工作表「${loaded.sheet}」）` : "";
      const subjectDesc = detection.subjects.map((s) => s.name).join("、");
      const classDesc = exam.class_name ? `班级「${exam.class_name}」` : "未限定班级";

      const parts = [
        `「${fileLabel}」${sheetSuffix}：${examCreated ? "创建" : "复用"}了考试「${exam.name}」（${exam.exam_date}，${classDesc}）`,
        `识别科目：${subjectDesc || "（无）"}`,
        `写入 ${result.scores_written} 条成绩（匹配已有学生 ${result.students_matched} 人`,
      ];
      if (result.students_created) parts.push(`，自动建档 ${result.students_created} 人）`);
      else parts.push("）");
      if (result.skipped.length) {
        parts.push(
          `跳过 ${result.skipped.length} 条（${result.skipped
            .slice(0, 3)
            .map((s) => `${s.name}:${s.reason}`)
            .join("；")}${result.skipped.length > 3 ? " 等" : ""}）`,
        );
      }
      if (result.failed.length) {
        parts.push(
          `失败 ${result.failed.length} 条（${result.failed
            .slice(0, 3)
            .map((f) => `${f.name}:${f.reason}`)
            .join("；")}${result.failed.length > 3 ? " 等" : ""}）`,
        );
      }
      fileLines.push(parts.join("。"));

      logInfo(
        `成绩单导入完成：考试「${exam.name}」(${exam.exam_date})，成绩 ${result.scores_written} 条，` +
          `匹配 ${result.students_matched} 人，建档 ${result.students_created} 人，跳过 ${result.skipped.length}，失败 ${result.failed.length}`,
      );

      // 导入收尾：从文件名 / 标题行识别年级与学期，补写班级元信息（失败静默）
      if (exam.class_name) {
        const guess = await applyInferredClassMeta(exam.class_name, [
          fileLabel,
          ...(loaded.table.titleText ?? []),
        ]);
        if (guess && (guess.grade != null || guess.semester != null)) {
          metaNotes.push(
            `${exam.class_name} 登记为${guess.grade != null ? `${guess.grade}年级` : ""}${guess.semester ? ` ${guess.semester}` : ""}`,
          );
        }
      }
    }
    if (metaNotes.length) {
      fileLines.push(`已识别班级信息：${[...new Set(metaNotes)].join("；")}`);
    }

    const head = multi
      ? `共导入 ${loadedList.length} 个文件：写入 ${totalWritten} 条成绩，匹配 ${totalMatched} 人，自动建档 ${totalCreated} 人，跳过 ${totalSkipped}，失败 ${totalFailed}。分文件：`
      : "已导入成绩：";
    return {
      ok: true,
      summary: `${head}${fileLines.join(multi ? "；" : "。")}。成绩已关联到学生档案，可在「班级管理 → 考试成绩」与学生详情页查看。`,
      data: {
        files: loadedList.map((l) => l.path),
        scores_written: totalWritten,
        students_matched: totalMatched,
        students_created: totalCreated,
        skipped: totalSkipped,
        failed: totalFailed,
      },
    };
  },
});
