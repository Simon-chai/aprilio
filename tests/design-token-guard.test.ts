import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * design-token-guard（规格 §4）：src 下全部 .vue 文件（递归）内禁止散点 hex 色值——
 * 样式色必须走 src/style.css @theme 的语义 token 与类名；图表 canvas 色集中在
 * src/lib/chart-palette.ts（.ts 文件天然不在扫描范围，沿用该先例）。
 * 对齐 schema-sync.test.ts 的对账思路：把 docs/DESIGN_SYSTEM.md 的维护约定
 * 变成测试门禁——新增 hex 不登记 @theme 就无法过 CI。
 */

const SRC_DIR = "src";

/** hex 色值字面量：#abc / #aabbcc / #aabbccdd。前后紧贴字母数字（如 URL 锚点 page.html#top）不算，避免误报 */
const HEX_RE = /(?<![0-9a-zA-Z])#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/g;

/** 豁免清单：相对 src 的 POSIX 路径 → 理由。改动这里必须同步 docs/DESIGN_SYSTEM.md */
const EXEMPT_FILES = new Map<string, string>([
  ["components/TimetableGrid.vue", "死代码待单独决策（规格 §2 非目标，本门禁不扫）"],
  ["components/TimetableCalendar.vue", "死代码待单独决策（规格 §2 非目标，本门禁不扫）"],
  ["components/FeatureIcon.vue", "首页多色插画，非 token 化对象"],
  ["views/HomeView.vue", "首页品牌装饰多色插画，非 token 化对象"],
]);

/** 已归位色值 → 建议 token（规格 §3.4 归位表；key 统一小写做大小写不敏感查找） */
const TOKEN_SUGGESTIONS: Record<string, string> = {
  "#fdeef0": "danger-soft（如 bg-danger-soft）",
  "#0066cc": "primary（如 text-primary / bg-primary）；图表 canvas 色请走 src/lib/chart-palette.ts",
  "#1d1d1f": "ink（如 text-ink）",
  "#333333": "muted（如 text-muted）",
  "#7a7a7a": "weak（如 text-weak）；图表文字色走 CHART_TEXT_WEAK",
  "#cccccc": "faint（如 text-faint）",
  "#d70015": "danger（如 text-danger）",
  "#248a3d": "praise / success",
  "#d97706": "improve",
  "#52525b": "neutral",
  "#fff": "currentColor + text-white（深底白图标）",
  "#ffffff": "currentColor + text-white（深底白图标）",
  "#000000": "ink-deep",
  "#4da5ff": "primary-on-dark-hover",
  /* 表现三态 / 分类胶囊 / AI 家族（规格 §3.4 新增 token） */
  "#e8f5e9": "praise-soft",
  "#a3e635": "praise-line",
  "#fff3e0": "improve-soft",
  "#fcd34d": "improve-line",
  "#f4f4f5": "neutral-soft",
  "#d4d4d8": "neutral-line",
  "#71717a": "neutral（微调 ①：节点点色统一用 neutral）",
  "#059669": "category-behavior",
  "#7c3aed": "category-other",
  "#6d28d9": "ai",
  "#f5f1ff": "ai-soft",
  "#e3d9ff": "ai-line",
  "#ede4ff": "ai-hover",
  /* 图表骨架色（canvas 读不到 CSS var） */
  "#e5e5e7": "CHART_AXIS_LINE（src/lib/chart-palette.ts）",
  "#a1a1a6": "CHART_AXIS_TEXT（src/lib/chart-palette.ts）",
};

/** 未登记色值的兜底指引 */
const UNKNOWN_COLOR_TIP =
  "未登记色值：请先在 src/style.css @theme 登记后用类名；图表 canvas 色走 src/lib/chart-palette.ts";

interface HexViolation {
  /** 相对 src 的文件路径 */
  file: string;
  /** 行号（1 起） */
  line: number;
  /** 命中的色值（保留原大小写） */
  hex: string;
  /** 建议 token 或兜底指引 */
  suggestion: string;
}

/** 单文件违例检测：整文件文本逐行扫（注释一并覆盖），色值大小写不敏感查建议 */
function findHexViolations(source: string, file: string): HexViolation[] {
  const violations: HexViolation[] = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(HEX_RE)) {
      violations.push({
        file,
        line: index + 1,
        hex: match[0],
        suggestion: TOKEN_SUGGESTIONS[match[0].toLowerCase()] ?? UNKNOWN_COLOR_TIP,
      });
    }
  });
  return violations;
}

/** 违例输出格式：文件:行号 + 色值 + 建议 token，可直接定位 */
function formatViolation(v: HexViolation): string {
  return `${v.file}:${v.line}  ${v.hex}  →  ${v.suggestion}`;
}

/** 递归收集 src 下全部 .vue 文件（返回相对 src 的 POSIX 路径，排序保证输出稳定） */
function collectVueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectVueFiles(full));
    else if (entry.endsWith(".vue")) out.push(relative(SRC_DIR, full).split(sep).join("/"));
  }
  return out.sort();
}

describe("design-token-guard（规格 §4：src/**/*.vue 零散点 hex）", () => {
  const allVueFiles = collectVueFiles(SRC_DIR);
  const scannedFiles = allVueFiles.filter((file) => !EXEMPT_FILES.has(file));

  it("全量扫描：豁免清单外零 hex 违例", () => {
    // 前置：扫描必须有效——cwd 变化 / 目录改名会让空扫描假绿
    expect(scannedFiles.length, "扫描到的文件数异常，请检查 src 目录与 collectVueFiles 逻辑").toBeGreaterThan(40);

    const violations = scannedFiles.flatMap((file) =>
      findHexViolations(readFileSync(join(SRC_DIR, file), "utf8"), file),
    );
    expect(
      violations.map(formatViolation),
      `src/**/*.vue 存在未归位 hex 色值（豁免外共 ${violations.length} 处）`,
    ).toEqual([]);
  });

  it("豁免清单里的文件都真实存在（改名 / 删除后需同步维护，防豁免静默失效）", () => {
    const stale = [...EXEMPT_FILES.keys()].filter((file) => !allVueFiles.includes(file));
    expect(
      stale.map((file) => `${file}（豁免理由：${EXEMPT_FILES.get(file)}）`),
      "以下豁免项已不对应真实文件，请从 EXEMPT_FILES 移除或更新：",
    ).toEqual([]);
  });

  it("违例检测逻辑可用：行号 / 色值 / 建议 token 输出（构造字符串，不依赖真实文件）", () => {
    const source = [
      '<p class="bg-[#fdeef0]">错误横幅</p>',
      "<!-- 注释里的 #0066cc 也会被扫到 -->",
      '<path stroke="#fff" />',
      '<a href="page.html#top">URL 锚点不误报</a>',
      '<div style="color:#ABCDEF">大写未登记色值</div>',
    ].join("\n");

    const violations = findHexViolations(source, "Fake.vue");

    // 定位信息：文件:行号 + 色值原样（大小写保留）
    expect(violations.map((v) => `${v.file}:${v.line} ${v.hex}`)).toEqual([
      "Fake.vue:1 #fdeef0",
      "Fake.vue:2 #0066cc",
      "Fake.vue:3 #fff",
      "Fake.vue:5 #ABCDEF",
    ]);

    // 建议输出：已知色值给出对应 token，未登记色值给兜底指引
    expect(violations[0].suggestion).toContain("danger-soft");
    expect(violations[1].suggestion).toContain("primary");
    expect(violations[2].suggestion).toContain("text-white");
    expect(violations[3].suggestion).toContain("@theme");
  });
});
