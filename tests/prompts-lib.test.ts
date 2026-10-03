import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { definePromptModule } from "../src/prompts/define";
import {
  bucketPromptModules,
  createPromptRegistry,
  getPromptModule,
  listPromptModules,
  scanPromptModules,
} from "../src/prompts/registry";
import {
  customizedPromptIds,
  loadPromptOverride,
  loadPromptOverrides,
  resetAllPromptOverrides,
  resetPromptOverride,
  sanitizePromptState,
  savePromptOverride,
} from "../src/prompts/store";
import {
  effectivePromptText,
  missingContractVariables,
  renderPromptText,
  resolvePrompt,
  unknownPlaceholders,
} from "../src/prompts/resolve";
import { PROMPT_IDS } from "../src/prompts/ids";
import type { PromptModule } from "../src/prompts/types";

const STORAGE_KEY = "aprilio.prompts.v1";

function mod(overrides: Partial<PromptModule> = {}): PromptModule {
  return definePromptModule({
    id: "content.demo",
    group: "content",
    label: "演示模块",
    description: "测试用",
    defaultText: "默认正文",
    ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
});

/* ------------------------------------------------------------------ */
/* definePromptModule：字段校验与归一                                    */
/* ------------------------------------------------------------------ */

describe("definePromptModule", () => {
  it("normalizes fields and trims the default text", () => {
    const m = mod({ defaultText: "  正文  " });
    expect(m.defaultText).toBe("正文");
    expect(m.variables).toEqual([]);
    expect(m.note).toBeUndefined();
  });

  it("rejects malformed specs at load time", () => {
    expect(() => mod({ id: "Bad Id" })).toThrow(/id 非法/);
    expect(() => mod({ group: "" })).toThrow(/缺少 group/);
    expect(() => mod({ label: " " })).toThrow(/缺少 label/);
    expect(() => mod({ description: "" })).toThrow(/缺少 description/);
    expect(() => mod({ defaultText: "   " })).toThrow(/默认正文为空/);
  });

  it("rejects invalid, duplicate or undocumented variables", () => {
    expect(() => mod({ variables: [{ name: "有 空格", description: "x" }] })).toThrow(/变量名非法/);
    expect(() => mod({ variables: [{ name: "a{b}", description: "x" }] })).toThrow(/变量名非法/);
    expect(() =>
      mod({
        variables: [
          { name: "甲", description: "x" },
          { name: "甲", description: "y" },
        ],
      }),
    ).toThrow(/变量重复/);
    expect(() => mod({ variables: [{ name: "甲", description: "  " }] })).toThrow(/缺少说明/);
  });
});

/* ------------------------------------------------------------------ */
/* registry：扫描、去重、分组聚合                                        */
/* ------------------------------------------------------------------ */

describe("prompt registry", () => {
  it("scans the modules/ directory and registers all shipped modules", () => {
    const modules = scanPromptModules();
    // 放文件即接入：modules/ 下有 12 个 *.prompt.ts
    expect(modules).toHaveLength(12);
    const ids = modules.map((m) => m.id).sort();
    expect(ids).toEqual(Object.values(PROMPT_IDS).sort());
  });

  it("fails fast on duplicate ids", () => {
    const a = mod();
    const b = mod({ label: "另一个" });
    expect(() => createPromptRegistry([a, b])).toThrow(/id 重复注册：content.demo/);
  });

  it("sorts modules by group order then label", () => {
    const other = mod({ id: "recognize.x", group: "recognize", label: "甲" });
    const content = mod({ id: "content.x", group: "content", label: "乙" });
    const listed = listPromptModules(createPromptRegistry([other, content]));
    expect(listed.map((m) => m.group)).toEqual(["content", "recognize"]);
  });

  it("buckets modules under their declared groups", () => {
    const buckets = bucketPromptModules();
    expect(buckets.length).toBeGreaterThanOrEqual(3);
    // 每个分组都要有模块，且模块不重复出现
    const seen = buckets.flatMap((b) => b.modules.map((m) => m.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(buckets.map((b) => b.group.id)).toEqual(["assistant", "content", "recognize"]);
  });

  it("does not lose modules whose group is not registered (fail-safe bucket)", () => {
    const stray = mod({ id: "brandnew.x", group: "brandnew", label: "新分组" });
    const buckets = bucketPromptModules(createPromptRegistry([stray]));
    expect(buckets).toHaveLength(1);
    expect(buckets[0].group.id).toBe("__other__");
    expect(buckets[0].modules[0].id).toBe("brandnew.x");
  });

  it("looks up a module by id", () => {
    expect(getPromptModule(PROMPT_IDS.termComment)?.id).toBe("content.term-comment");
    expect(getPromptModule("nope.nope")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* store：只存差异、空正文即恢复默认、坏数据回落                          */
/* ------------------------------------------------------------------ */

describe("prompt store", () => {
  it("stores only the override, then reports it as customized", () => {
    expect(loadPromptOverride("content.demo")).toBeUndefined();
    savePromptOverride("content.demo", "我的正文");
    expect(loadPromptOverride("content.demo")).toBe("我的正文");
    expect(customizedPromptIds().has("content.demo")).toBe(true);
    expect(loadPromptOverrides()["content.demo"].updated_at).not.toBe("");
  });

  it("treats a blank text as reset (deletes the override, and the key when empty)", () => {
    savePromptOverride("content.demo", "我的正文");
    savePromptOverride("content.demo", "   ");
    expect(loadPromptOverride("content.demo")).toBeUndefined();
    // 覆盖集合空了就连键一起删，不留空壳
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("resets a single module and all modules", () => {
    savePromptOverride("content.a", "A");
    savePromptOverride("content.b", "B");
    resetPromptOverride("content.a");
    expect(customizedPromptIds()).toEqual(new Set(["content.b"]));
    resetAllPromptOverrides();
    expect(customizedPromptIds().size).toBe(0);
  });

  it("is a no-op when resetting a module that has no override", () => {
    savePromptOverride("content.a", "A");
    resetPromptOverride("content.absent");
    expect(loadPromptOverride("content.a")).toBe("A");
  });

  it("sanitizes corrupt stored data into an empty override set", () => {
    // 非法结构一律回落空集：坏数据绝不影响 AI 功能
    expect(sanitizePromptState(null).overrides).toEqual({});
    expect(sanitizePromptState({ overrides: 42 }).overrides).toEqual({});
    expect(sanitizePromptState({ overrides: { a: { text: "  " } } }).overrides).toEqual({});
    expect(sanitizePromptState({ overrides: { a: "字符串" } }).overrides).toEqual({});

    localStorage.setItem(STORAGE_KEY, "{ 不是 JSON");
    expect(loadPromptOverrides()).toEqual({});
  });

  it("keeps overrides of modules that were taken offline (no destructive cleanup)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, overrides: { "retired.module": { text: "旧自定义", updated_at: "x" } } }),
    );
    expect(loadPromptOverride("retired.module")).toBe("旧自定义");
  });
});

/* ------------------------------------------------------------------ */
/* renderPromptText：占位符规则                                        */
/* ------------------------------------------------------------------ */

describe("renderPromptText", () => {
  it("substitutes declared placeholders", () => {
    expect(renderPromptText("你好{名字}。", { 名字: "张三" })).toBe("你好张三。");
  });

  it("keeps undeclared placeholders verbatim (typos stay visible)", () => {
    expect(renderPromptText("你好{名字}。", {})).toBe("你好{名字}。");
    expect(renderPromptText("你好{拼错}。", { 名字: "张三" })).toBe("你好{拼错}。");
  });

  it("drops a whole line when all of its placeholders are empty", () => {
    const text = ["第一行", "补充设定：{补充}", "最后一行"].join("\n");
    expect(renderPromptText(text, { 补充: "" })).toBe("第一行\n最后一行");
    expect(renderPromptText(text, { 补充: "  " })).toBe("第一行\n最后一行");
    expect(renderPromptText(text, { 补充: "简短" })).toBe("第一行\n补充设定：简短\n最后一行");
    // 变量完全没传 = 未声明 → 占位符原样保留，行不删
    expect(renderPromptText(text, {})).toBe(text);
  });

  it("keeps the line when only some placeholders are empty", () => {
    expect(renderPromptText("{甲}/{乙}", { 甲: "有值", 乙: "" })).toBe("有值/");
    expect(renderPromptText("{甲}/{乙}", { 甲: "有值", 乙: "值" })).toBe("有值/值");
  });

  it("does not re-substitute braces inside a value (JSON contracts are safe)", () => {
    const schema = '{"column": 列号}';
    expect(renderPromptText("结构：{输出结构}", { 输出结构: schema })).toBe(`结构：${schema}`);
  });

  it("collapses consecutive blank lines and trims the edges", () => {
    expect(renderPromptText("\n\n甲\n\n\n\n乙\n\n", {})).toBe("甲\n\n乙");
  });

  it("handles empty input", () => {
    expect(renderPromptText("", {})).toBe("");
    expect(renderPromptText("   ", {})).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* resolvePrompt：取值入口                                              */
/* ------------------------------------------------------------------ */

describe("resolvePrompt", () => {
  it("falls back to the built-in default when nothing is customized", () => {
    expect(resolvePrompt(PROMPT_IDS.termComment)).toContain("你是一位经验丰富的小学班主任");
  });

  it("injects the contract variable so the wording matches the code's limit", () => {
    expect(resolvePrompt(PROMPT_IDS.memoTitle)).toContain("不超过 12 个字");
    expect(resolvePrompt(PROMPT_IDS.behaviorComment)).toContain("不超过 25 个字");
  });

  it("injects an editable variable's default value so the shipped wording is stable", () => {
    // 写作建议是 default 值（可覆盖），不传时应当还原成出厂文案里的 120
    expect(resolvePrompt(PROMPT_IDS.termComment)).toContain("不超过 120 字");
    expect(resolvePrompt(PROMPT_IDS.termComment, { 评语字数上限: "80" })).toContain("不超过 80 字");
  });

  it("prefers the override once the user saves one", () => {
    savePromptOverride(PROMPT_IDS.termComment, "只写两句：{评语字数上限}");
    expect(resolvePrompt(PROMPT_IDS.termComment, { 评语字数上限: "50" })).toBe("只写两句：50");
    resetPromptOverride(PROMPT_IDS.termComment);
    expect(resolvePrompt(PROMPT_IDS.termComment)).toContain("你是一位经验丰富的小学班主任");
  });

  it("returns an empty string and warns for an unregistered id (never throws)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 提示词取值在 AI 调用路径上：抛错会连带让评语、导入等主流程失败
    expect(resolvePrompt("missing.module")).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("missing.module"));
    warn.mockRestore();
  });

  it("effectivePromptText uses the override only when it is non-blank", () => {
    const m = mod();
    expect(effectivePromptText(m, {})).toBe("默认正文");
    expect(effectivePromptText(m, { "content.demo": { text: "自定义", updated_at: "" } })).toBe("自定义");
    expect(effectivePromptText(m, { "content.demo": { text: "  ", updated_at: "" } })).toBe("默认正文");
  });
});

/* ------------------------------------------------------------------ */
/* 契约变量提示                                                          */
/* ------------------------------------------------------------------ */

describe("contract variable hints", () => {
  it("reports missing contract variables", () => {
    const m = mod({
      defaultText: "上限 {上限}",
      variables: [{ name: "上限", description: "x", fixedValue: "10" }],
    });
    expect(missingContractVariables(m, "没有占位符")).toEqual(["上限"]);
    expect(missingContractVariables(m, "上限 {上限}")).toEqual([]);
    // 可编辑变量不算契约：删掉它只是换措辞，不需要告警
    const editable = mod({
      defaultText: "上限 {上限}",
      variables: [{ name: "上限", description: "x", defaultValue: "10" }],
    });
    expect(missingContractVariables(editable, "没有占位符")).toEqual([]);
  });

  it("reports placeholders that the module does not declare", () => {
    const m = mod({
      defaultText: "上限 {上限}",
      variables: [{ name: "上限", description: "x", fixedValue: "10" }],
    });
    expect(unknownPlaceholders(m, "{上限} 与 {手滑}")).toEqual(["手滑"]);
    expect(unknownPlaceholders(m, "{上限}")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 零漂移：默认正文与改造前的硬编码逐字一致                                */
/* ------------------------------------------------------------------ */

describe("默认正文与改造前逐字一致（防止重构悄悄改写提示词）", () => {
  const before = JSON.parse(
    readFileSync("tests/fixtures/prompts-before.json", "utf8"),
  ) as Record<string, string>;

  const CASES: [string, string][] = [
    [PROMPT_IDS.termComment, "content.term-comment"],
    [PROMPT_IDS.evalReport, "content.eval-report"],
    [PROMPT_IDS.behaviorComment, "content.behavior-comment"],
    [PROMPT_IDS.memoTitle, "content.memo-title"],
    [PROMPT_IDS.lessonDigest, "content.lesson-digest"],
    [PROMPT_IDS.guardianTag, "recognize.guardian-tag"],
    [PROMPT_IDS.rosterNameColumn, "recognize.roster-name-column"],
    [PROMPT_IDS.rosterClassName, "recognize.roster-class-name"],
    [PROMPT_IDS.scoreSheet, "recognize.score-sheet"],
  ];

  it.each(CASES)("%s 的渲染结果与改造前一致", (id, fixtureKey) => {
    const mod = getPromptModule(id)!;
    const vars = Object.fromEntries(
      (mod.variables ?? []).map((v) => [v.name, v.fixedValue ?? v.defaultValue ?? ""]),
    );
    expect(renderPromptText(mod.defaultText, vars)).toBe(before[fixtureKey]);
  });

  it("全部静态模块无需传参就还原成改造前的文案", () => {
    // 长度上限 / 输出结构这类变量由 resolvePrompt 内部自动带上，调用方不必显式传
    for (const [, fixtureKey] of CASES) {
      const id = Object.values(PROMPT_IDS).find((v) => v === fixtureKey)!;
      expect(resolvePrompt(id), `${fixtureKey} 应与改造前逐字一致`).toBe(before[fixtureKey]);
    }
  });
});
