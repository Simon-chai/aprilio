import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GUARDIAN_TAG_MAX_LEN,
  GUARDIAN_TAG_POLARITY_KEY,
  GUARDIAN_TAG_PRESETS_KEY,
  GUARDIAN_TAG_PRESETS_MAX,
  addGuardianTagPreset,
  ensureGuardianTagPolarities,
  loadGuardianTagPresets,
  loadTagPolarities,
  parseTagPolarities,
  removeGuardianTagPreset,
  tagChipClass,
} from "../src/lib/guardian-tags";
import { GUARDIAN_TAG_PRESETS } from "../src/types";
import type { AgentLlm } from "../src/agent/types";

beforeEach(() => {
  localStorage.clear();
});

describe("预设候选词管理", () => {
  it("无存储时回退系统默认词", () => {
    expect(loadGuardianTagPresets()).toEqual(GUARDIAN_TAG_PRESETS);
  });

  it("新增自定义预设并持久化，去重、限长", () => {
    expect(addGuardianTagPreset("  暴脾气  ")).toBe(true);
    expect(loadGuardianTagPresets()).toContain("暴脾气");
    expect(localStorage.getItem(GUARDIAN_TAG_PRESETS_KEY)).toContain("暴脾气");

    // 重复新增无效
    expect(addGuardianTagPreset("暴脾气")).toBe(false);
    // 空串无效，超长截断
    expect(addGuardianTagPreset("   ")).toBe(false);
    expect(addGuardianTagPreset("一二三四五六七八九十十一")).toBe(true);
    expect(loadGuardianTagPresets()).toContain("一二三四五六七八九十");
    expect(loadGuardianTagPresets()).not.toContain("一二三四五六七八九十十一");
    expect(loadGuardianTagPresets()).toHaveLength(GUARDIAN_TAG_PRESETS.length + 2);
  });

  it("达到上限后不再新增", () => {
    const full = Array.from({ length: GUARDIAN_TAG_PRESETS_MAX }, (_, i) => `标签${i}`);
    localStorage.setItem(GUARDIAN_TAG_PRESETS_KEY, JSON.stringify(full));
    expect(addGuardianTagPreset("新标签")).toBe(false);
    expect(loadGuardianTagPresets()).toEqual(full);
  });

  it("删除预设（含系统默认）并持久化，删除不存在的词无效", () => {
    expect(removeGuardianTagPreset("温和")).toBe(true);
    expect(loadGuardianTagPresets()).not.toContain("温和");
    expect(loadGuardianTagPresets()).toContain("严格");

    expect(removeGuardianTagPreset("不存在的词")).toBe(false);
  });

  it("损坏的存储回退默认词", () => {
    localStorage.setItem(GUARDIAN_TAG_PRESETS_KEY, "{not json");
    expect(loadGuardianTagPresets()).toEqual(GUARDIAN_TAG_PRESETS);
  });
});

describe("倾向缓存", () => {
  it("无缓存返回空对象，非法倾向值被过滤", () => {
    expect(loadTagPolarities()).toEqual({});
    localStorage.setItem(GUARDIAN_TAG_POLARITY_KEY, JSON.stringify({ 温和: "positive", 严格: "生气" }));
    expect(loadTagPolarities()).toEqual({ 温和: "positive" });
  });

  it("损坏的存储回退空对象", () => {
    localStorage.setItem(GUARDIAN_TAG_POLARITY_KEY, "{not json");
    expect(loadTagPolarities()).toEqual({});
  });
});

describe("tagChipClass", () => {
  it("按倾向返回填充色，未判定留白中性底", () => {
    expect(tagChipClass("positive")).toContain("bg-tag-positive-soft");
    expect(tagChipClass("negative")).toContain("bg-tag-negative-soft");
    expect(tagChipClass("neutral")).toContain("bg-parchment");
    expect(tagChipClass(undefined)).toContain("bg-parchment");
  });
});

describe("parseTagPolarities", () => {
  it("解析 JSON 输出，丢弃非法倾向", () => {
    expect(parseTagPolarities('{"温和":"positive","严格":"negative","x":"生气"}')).toEqual({
      温和: "positive",
      严格: "negative",
    });
  });

  it("从混杂文本中提取 JSON 对象", () => {
    expect(parseTagPolarities('结果如下：\n{"温和":"neutral"}\n以上。')).toEqual({ 温和: "neutral" });
  });

  it("JSON 失败时回退「标签：倾向」行式", () => {
    expect(parseTagPolarities("温和: positive\n严格：negative\n无效行")).toEqual({
      温和: "positive",
      严格: "negative",
    });
  });

  it("空输入返回空对象", () => {
    expect(parseTagPolarities("")).toEqual({});
    expect(parseTagPolarities("  \n  ")).toEqual({});
  });
});

describe("ensureGuardianTagPolarities", () => {
  const llmOf = (content: string) => ({ chat: vi.fn().mockResolvedValue({ content }) }) as unknown as AgentLlm;

  it("AI 未就绪时不请求模型，返回已有缓存", async () => {
    const chat = vi.fn();
    localStorage.setItem(GUARDIAN_TAG_POLARITY_KEY, JSON.stringify({ 温和: "positive" }));
    const result = await ensureGuardianTagPolarities(["温和", "严格"], {
      llm: { chat } as unknown as AgentLlm,
      aiReady: false,
    });
    expect(result).toEqual({ 温和: "positive" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("AI 就绪时只为缺失标签请求一次并写缓存", async () => {
    localStorage.setItem(GUARDIAN_TAG_POLARITY_KEY, JSON.stringify({ 温和: "positive" }));
    const llm = llmOf('{"严格":"negative"}');
    const result = await ensureGuardianTagPolarities(["温和", "严格"], { llm, aiReady: true });

    expect(result).toEqual({ 温和: "positive", 严格: "negative" });
    expect(llm.chat).toHaveBeenCalledOnce();
    const req = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      messages: { content: string }[];
    };
    // 只询问缺失的「严格」，不重复问「温和」
    expect(req.messages[0].content).toBe("标签列表：严格");
    expect(loadTagPolarities()).toEqual({ 温和: "positive", 严格: "negative" });

    // 第二次调用全部命中缓存，不再请求模型
    const again = await ensureGuardianTagPolarities(["温和", "严格"], { llm, aiReady: true });
    expect(again).toEqual({ 温和: "positive", 严格: "negative" });
    expect(llm.chat).toHaveBeenCalledOnce();
  });

  it("模型输出解析失败 → 静默返回已有缓存，不写缓存", async () => {
    const llm = llmOf("我看不懂该输出什么");
    const result = await ensureGuardianTagPolarities(["温和"], { llm, aiReady: true });
    expect(result).toEqual({});
    expect(loadTagPolarities()).toEqual({});
  });

  it("调用失败 → 静默返回已有缓存，不抛错", async () => {
    const llm = { chat: vi.fn().mockRejectedValue(new Error("network down")) } as unknown as AgentLlm;
    const result = await ensureGuardianTagPolarities(["温和"], { llm, aiReady: true });
    expect(result).toEqual({});
  });

  it("模型输出里混入非请求标签的结果被丢弃", async () => {
    const llm = llmOf('{"温和":"positive","额外标签":"negative"}');
    const result = await ensureGuardianTagPolarities(["温和"], { llm, aiReady: true });
    expect(result).toEqual({ 温和: "positive" });
    expect(loadTagPolarities()).toEqual({ 温和: "positive" });
  });

  it("空标签列表不请求模型", async () => {
    const chat = vi.fn();
    await ensureGuardianTagPolarities([], { llm: { chat } as unknown as AgentLlm, aiReady: true });
    expect(chat).not.toHaveBeenCalled();
  });

  it("标签长度上限与预设一致", () => {
    expect(GUARDIAN_TAG_MAX_LEN).toBe(10);
  });
});
