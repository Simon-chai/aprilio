/**
 * 工具：import_student_roster —— 花名册导入（声明式注册，default export 即被容器装载）。
 *
 * 用户让 AI 助手导入花名册时走这里，底层与「导入花名册」对话框共用同一条
 * 智能导入管道（src/lib/roster.ts）：解析表格 → 根据表头与单元格内容自动识别
 * 姓名列（已配置模型时叠加 AI 识别）→ 其余列按表头映射 → 落库。
 * Excel（xlsx/xls 等）由 Rust 端 calamine 解码为矩阵（roster_read_table），
 * CSV/TSV 走文本通道（roster_read_text），语义识别始终在前端。
 *
 * 标记为写操作（dangerous: true），必须包含 confirm 参数；识别置信度低或没有
 * 发现姓名列时不落库，返回候选列让模型向用户确认后带 name_column 重试。
 */
import { isTauri } from "../../lib/db";
import { logError, logInfo } from "../../lib/logger";
import {
  loadRosterTable,
  pickRosterFile,
  runSmartImportTable,
  type LoadedRoster,
  type SmartImportOutcome,
} from "../../lib/roster";
import { defineAgentTool } from "../define";

export default defineAgentTool({
  name: "import_student_roster",
  label: "花名册导入",
  description:
    "导入学生花名册表格（XLSX/XLS/XLSM/XLSB/ODS/CSV/TSV/TXT）。使用智能导入：自动根据表头与单元格内容识别姓名列，" +
    "其余列按表头自动映射（学号/性别/班级/监护人电话等），学号已存在或同名同生日的记录自动跳过。" +
    "file_path 缺省时弹出系统文件选择框由用户选择文件。" +
    "识别置信度低时会返回候选列，需询问用户姓名在哪一列后带 name_column 参数（列名或列号）重新调用。" +
    "此工具会批量创建学生档案，必须先征得用户同意并附带 confirm:true 确认。",
  tags: ["students", "write"],
  dangerous: true,
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "花名册文件路径（Excel 或 CSV/TSV/TXT）。缺省时弹出文件选择框让用户选择",
      },
      name_column: {
        type: "string",
        description:
          "姓名列，列名文本或从 1 开始的列号（如 \"姓名\" 或 \"3\"）。缺省时自动识别；识别置信度低时必须提供",
      },
      confirm: {
        type: "boolean",
        description: "写操作确认标记：涉及批量创建学生，必须在用户明确同意后传 true",
      },
    },
    required: [],
  },
  async execute(args) {
    if (!isTauri()) {
      return {
        ok: false,
        summary: "",
        error: "浏览器演示态无法读取本地文件。请在桌面端使用，或到「学生档案」页用「导入花名册」对话框手动导入。",
      };
    }

    let loaded: LoadedRoster;
    const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
    if (filePath) {
      try {
        loaded = await loadRosterTable(filePath);
      } catch (e) {
        return { ok: false, summary: "", error: `读取花名册失败：${e instanceof Error ? e.message : String(e)}` };
      }
    } else {
      const picked = await pickRosterFile();
      if (!picked) {
        return { ok: false, summary: "", error: "用户没有选择文件，导入已取消。" };
      }
      loaded = picked;
    }

    const nameColumnArg =
      typeof args.name_column === "string" && args.name_column.trim()
        ? args.name_column.trim()
        : undefined;

    let outcome: SmartImportOutcome;
    try {
      // 不传 config：runSmartImportTable 缺省读本机模型配置，已配置模型时叠加 AI 识别
      outcome = await runSmartImportTable(loaded.table, { nameColumn: nameColumnArg });
    } catch (e) {
      logError("花名册导入失败", e);
      return { ok: false, summary: "", error: `花名册导入失败：${e instanceof Error ? e.message : String(e)}` };
    }

    if (outcome.status === "error") {
      return { ok: false, summary: "", error: outcome.message };
    }

    if (outcome.status === "need-column") {
      return { ok: false, summary: "", error: outcome.message };
    }

    const { detection, mapping, result } = outcome;
    const fileLabel = loaded.fileName;
    const sheetSuffix = loaded.kind === "table" && loaded.sheet ? `（工作表「${loaded.sheet}」）` : "";
    const detectDesc = `第${mapping.nameColumn + 1}列「${detection.candidates[0]?.header ?? ""}」（${
      detection.method === "ai" ? "AI 识别" : "规则识别"
    }，置信度${detection.confidence === "high" ? "高" : detection.confidence === "medium" ? "中" : "低"}）`;

    if (!result) {
      return { ok: false, summary: "", error: "导入流程异常：缺少导入结果。" };
    }

    const parts = [
      `已从「${fileLabel}」${sheetSuffix}导入 ${result.imported} 名学生（姓名列：${detectDesc}）`,
    ];
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
          .map((f) => `第${f.row || "?"}行 ${f.name || "空姓名"}:${f.reason}`)
          .join("；")}${result.failed.length > 3 ? " 等" : ""}）`,
      );
    }

    logInfo(`花名册导入完成：成功 ${result.imported}，跳过 ${result.skipped.length}，失败 ${result.failed.length}`);

    return {
      ok: true,
      summary: `${parts.join("。")}。`,
      data: {
        file: loaded.path,
        sheet: loaded.sheet,
        name_column: mapping.nameColumn + 1,
        detection: { method: detection.method, confidence: detection.confidence },
        imported: result.imported,
        skipped: result.skipped.length,
        failed: result.failed.length,
      },
    };
  },
});
