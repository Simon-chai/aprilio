import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  aiProviderById as findProvider,
  DEFAULT_AI_CONFIG,
  isAiConfigured,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
} from "../src/lib/ai";

const cfg = (patch: Partial<AiConfig>): AiConfig => ({ ...DEFAULT_AI_CONFIG, ...patch });

beforeEach(() => {
  localStorage.clear();
});

describe("ai provider presets", () => {
  it("covers the mainstream providers and keeps ids unique", () => {
    const ids = AI_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findProvider("ollama")?.needsKey).toBe(false);
    expect(findProvider("openai")?.needsKey).toBe(true);
  });

  it("falls back to undefined for unknown ids", () => {
    expect(findProvider("nope")).toBeUndefined();
  });
});

describe("ai config persistence", () => {
  it("returns defaults when nothing was saved", () => {
    expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
  });

  it("round-trips a saved config and merges over defaults", () => {
    saveAiConfig(cfg({ provider: "deepseek", model: "deepseek-chat", apiKey: "sk-test" }));
    expect(loadAiConfig()).toEqual({
      ...DEFAULT_AI_CONFIG,
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "sk-test",
    });
  });

  it("survives corrupted storage", () => {
    localStorage.setItem("aprilio.ai.config", "{not json");
    expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
  });
});

describe("isAiConfigured", () => {
  it("requires a model name", () => {
    expect(isAiConfigured(cfg({ model: "" }))).toBe(false);
  });

  it("requires an api key for hosted providers", () => {
    expect(isAiConfigured(cfg({ provider: "openai", apiKey: "" }))).toBe(false);
    expect(isAiConfigured(cfg({ provider: "openai", apiKey: "sk-x" }))).toBe(true);
  });

  it("does not require a key for local ollama", () => {
    expect(isAiConfigured(cfg({ provider: "ollama", model: "qwen3:8b", apiKey: "" }))).toBe(true);
  });
});
