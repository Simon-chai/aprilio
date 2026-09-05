/**
 * 工具：find_docs —— 文档查找（声明式注册，default export 即被容器装载）。
 *
 * 文档在构建期通过 import.meta.glob 内联（浏览器/桌面端行为一致，无运行时 IO）：
 * - docs/*.md：项目文档（含 AGENT.md —— 本助手的能力说明本身也是可检索文档）
 * 检索策略：按行做关键词命中打分，返回带标题与位置的片段。
 */
import { defineAgentTool } from "../define";

const DEFAULT_LIMIT = 6;

interface DocEntry {
  file: string;
  title: string;
  lines: string[];
}

const docModules = import.meta.glob<string>("/docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 文件名 → 首个一级标题作为文档名 */
function buildDocs(): DocEntry[] {
  return Object.entries(docModules).map(([file, raw]) => {
    const lines = raw.split(/\r?\n/);
    const heading = lines.find((l) => l.startsWith("# "));
    const name = file.split("/").pop() ?? file;
    return { file: name, title: heading ? heading.replace(/^#\s*/, "").trim() || name : name, lines };
  });
}

interface Fragment {
  doc: DocEntry;
  lineNo: number;
  text: string;
  score: number;
}

function searchFragments(docs: DocEntry[], keywords: string[]): Fragment[] {
  const hits: Fragment[] = [];
  for (const doc of docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      const line = doc.lines[i];
      const lower = line.toLowerCase();
      const matched = keywords.filter((k) => lower.includes(k.toLowerCase()));
      if (!matched.length) continue;
      // 命中越多分越高；标题行再加分
      const score = matched.length + (line.startsWith("# ") ? 2 : 0);
      hits.push({ doc, lineNo: i + 1, text: line.trim(), score });
    }
  }
  // 同文档相邻行去重：保留得分高的一行
  hits.sort((a, b) => b.score - a.score || a.doc.file.localeCompare(b.doc.file) || a.lineNo - b.lineNo);
  const picked: Fragment[] = [];
  for (const hit of hits) {
    const near = picked.some((p) => p.doc.file === hit.doc.file && Math.abs(p.lineNo - hit.lineNo) <= 1);
    if (!near) picked.push(hit);
  }
  return picked;
}

export default defineAgentTool({
  name: "find_docs",
  label: "文档检索",
  description:
    "在应用文档与帮助资料中检索内容（功能说明、操作指南、设计决策、日志排查等），是广义的数据查询。适合回答「怎么用 / 为什么 / 有哪些文档」。",
  tags: ["readonly"],
  parameters: {
    type: "object",
    properties: {
      keywords: {
        type: "string",
        description: "检索关键词，多个词用空格分隔，如「日志 排查」",
      },
      limit: {
        type: "number",
        description: "最多返回的片段数，默认 6",
      },
    },
    required: ["keywords"],
  },
  async execute(args) {
    const raw = String(args.keywords ?? "").trim();
    if (!raw) {
      return { ok: false, summary: "", error: "keywords 不能为空。" };
    }
    const keywords = raw
      .split(/[\s,，、;；]+/)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 5);
    const limit = Math.max(1, Math.min(Number(args.limit) || DEFAULT_LIMIT, 20));

    const docs = buildDocs();
    const fragments = searchFragments(docs, keywords).slice(0, limit);

    if (!fragments.length) {
      const files = docs.map((d) => d.file).join("、");
      return {
        ok: true,
        summary: `没有找到与「${raw}」相关的内容。现有文档：${files}。`,
        data: [],
      };
    }

    const body = fragments
      .map((f) => `【${f.doc.title} · ${f.doc.file}:${f.lineNo}】\n${f.text}`)
      .join("\n");
    return {
      ok: true,
      summary: `找到 ${fragments.length} 个相关片段（关键词：${keywords.join("、")}）：\n${body}`,
      data: fragments,
    };
  },
});
