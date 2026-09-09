import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_PROVIDERS,
  aiProviderById as findProvider,
  DEFAULT_AI_CONFIG,
  isAiConfigured,
  loadAiConfig,
  maskApiKey,
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

  it("stores the key obfuscated instead of plaintext", () => {
    saveAiConfig(cfg({ apiKey: "sk-test-secret-1234" }));
    const raw = localStorage.getItem("aprilio.ai.config") ?? "";
    expect(raw).not.toContain("sk-test-secret-1234");
    expect(raw).toContain("enc1:");
    // 读回仍是原文，内存态保持明文可用
    expect(loadAiConfig().apiKey).toBe("sk-test-secret-1234");
  });

  it("reads legacy plaintext configs (migration compatible)", () => {
    localStorage.setItem(
      "aprilio.ai.config",
      JSON.stringify({ ...DEFAULT_AI_CONFIG, apiKey: "sk-legacy-plain" }),
    );
    expect(loadAiConfig().apiKey).toBe("sk-legacy-plain");
    // 下次保存即转为混淆存放
    saveAiConfig(loadAiConfig());
    expect(localStorage.getItem("aprilio.ai.config") ?? "").not.toContain("sk-legacy-plain");
    expect(loadAiConfig().apiKey).toBe("sk-legacy-plain");
  });

  it("falls back to empty on broken obfuscated payloads", () => {
    localStorage.setItem(
      "aprilio.ai.config",
      JSON.stringify({ ...DEFAULT_AI_CONFIG, apiKey: "enc1:%%%not-base64%%%" }),
    );
    expect(loadAiConfig().apiKey).toBe("");
  });
});

describe("maskApiKey", () => {
  it("masks the middle, keeping head and tail for identification", () => {
    expect(maskApiKey("sk-test-secret-1234")).toBe("sk-••••1234");
  });

  it("masks short keys entirely", () => {
    expect(maskApiKey("12345678")).toBe("••••••••");
    expect(maskApiKey("abc")).toBe("•••");
  });

  it("returns empty for empty keys", () => {
    expect(maskApiKey("")).toBe("");
    expect(maskApiKey("   ")).toBe("");
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
