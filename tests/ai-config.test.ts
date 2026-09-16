import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  AI_PROVIDERS,
  aiProviderById as findProvider,
  DEFAULT_AI_CONFIG,
  deleteAiProfile,
  isAiConfigured,
  listAiModels,
  loadAiConfig,
  loadAiProfiles,
  maskApiKey,
  newAiProfileId,
  saveAiProfileVerified,
  setActiveAiProfile,
  upsertAiProfile,
  verifyAiConfig,
  type AiProfile,
} from "../src/lib/ai";

const PROFILES_KEY = "aprilio.ai.profiles.v1";
const LEGACY_KEY = "aprilio.ai.config";

const profile = (patch: Partial<AiProfile>): AiProfile => ({
  id: "p-test",
  name: "测试方案",
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: "",
  baseUrl: "",
  temperature: 0.7,
  systemPrompt: "",
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  // isTauri 靠 window.__TAURI_INTERNALS__ 判定：默认按浏览器演示态起步，桌面态用例再打开
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invokeMock.mockReset();
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

describe("ai profiles persistence", () => {
  it("returns an empty state and default config when nothing was saved", () => {
    expect(loadAiProfiles()).toEqual({ activeId: "", profiles: [] });
    expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
  });

  it("migrates the legacy single config into one 默认方案 profile", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ ...DEFAULT_AI_CONFIG, provider: "deepseek", model: "deepseek-chat", apiKey: "sk-legacy" }),
    );

    const state = loadAiProfiles();
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].name).toBe("默认方案");
    expect(state.profiles[0].provider).toBe("deepseek");
    expect(state.profiles[0].apiKey).toBe("sk-legacy");
    expect(state.activeId).toBe(state.profiles[0].id);
    // 迁移即生效：现有调用方 loadAiConfig 读到的就是迁移后的配置
    expect(loadAiConfig().model).toBe("deepseek-chat");
    // 迁移结果已落盘到新键，历史明文密钥转成混淆存放
    const raw = localStorage.getItem(PROFILES_KEY) ?? "";
    expect(raw).not.toContain("sk-legacy");
    expect(raw).toContain("enc1:");
  });

  it("round-trips profiles and keeps keys obfuscated at rest", () => {
    upsertAiProfile(profile({ apiKey: "sk-test-secret-1234" }));

    const raw = localStorage.getItem(PROFILES_KEY) ?? "";
    expect(raw).not.toContain("sk-test-secret-1234");
    expect(raw).toContain("enc1:");
    // 读回仍是原文，内存态保持明文可用
    expect(loadAiProfiles().profiles[0].apiKey).toBe("sk-test-secret-1234");
  });

  it("makes the first added profile active and keeps the active one afterwards", () => {
    const a = upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    expect(a.activeId).toBe("p-a");
    const b = upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    expect(b.profiles).toHaveLength(2);
    expect(b.activeId).toBe("p-a");
  });

  it("setActiveAiProfile switches the active profile and loadAiConfig follows", () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));

    const state = setActiveAiProfile("p-b");
    expect(state.activeId).toBe("p-b");
    expect(loadAiConfig().model).toBe("model-b");
  });

  it("ignores unknown ids in setActiveAiProfile", () => {
    upsertAiProfile(profile({ id: "p-a" }));
    expect(setActiveAiProfile("ghost").activeId).toBe("p-a");
  });

  it("falls back to the first configured profile when the active one is deleted", () => {
    upsertAiProfile(profile({ id: "p-a", apiKey: "sk-a" }));
    upsertAiProfile(profile({ id: "p-b", apiKey: "sk-b" }));
    upsertAiProfile(profile({ id: "p-c", apiKey: "" })); // 缺密钥，不可用
    setActiveAiProfile("p-c");

    const state = deleteAiProfile("p-c");
    expect(state.activeId).toBe("p-a");
    expect(loadAiConfig().model).toBe("deepseek-chat");
  });

  it("returns an empty state when the last profile is deleted", () => {
    upsertAiProfile(profile({ id: "p-a" }));
    const state = deleteAiProfile("p-a");
    expect(state.profiles).toHaveLength(0);
    expect(state.activeId).toBe("");
    expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
  });

  it("survives corrupted profiles storage", () => {
    localStorage.setItem(PROFILES_KEY, "{not json");
    expect(loadAiProfiles()).toEqual({ activeId: "", profiles: [] });
    expect(loadAiConfig()).toEqual(DEFAULT_AI_CONFIG);
  });

  it("repairs an invalid activeId by falling back to the first configured profile", () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        activeId: "ghost",
        profiles: [
          profile({ id: "p-a", apiKey: "" }), // 缺密钥
          profile({ id: "p-b", apiKey: "sk-b" }),
        ],
      }),
    );

    const state = loadAiProfiles();
    expect(state.activeId).toBe("p-b");
  });

  it("drops profiles with broken obfuscated payloads to an empty key", () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({
        activeId: "p-a",
        profiles: [profile({ id: "p-a", apiKey: "enc1:%%%not-base64%%%" })],
      }),
    );
    expect(loadAiConfig().apiKey).toBe("");
  });

  it("normalizes dirty fields instead of throwing", () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify({ activeId: "p-a", profiles: [{ id: "p-a", provider: 42, model: null, temperature: "x" }] }),
    );
    const [p] = loadAiProfiles().profiles;
    expect(p.provider).toBe(DEFAULT_AI_CONFIG.provider);
    expect(p.model).toBe("");
    expect(p.temperature).toBe(DEFAULT_AI_CONFIG.temperature);
  });

  it("generates unique profile ids", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newAiProfileId()));
    expect(ids.size).toBe(20);
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
    expect(isAiConfigured(profile({ model: "" }))).toBe(false);
  });

  it("requires an api key for hosted providers", () => {
    expect(isAiConfigured(profile({ provider: "openai", apiKey: "" }))).toBe(false);
    expect(isAiConfigured(profile({ provider: "openai", apiKey: "sk-x" }))).toBe(true);
  });

  it("does not require a key for local ollama", () => {
    expect(isAiConfigured(profile({ provider: "ollama", model: "qwen3:8b", apiKey: "" }))).toBe(true);
  });
});

describe("listAiModels（一键拉取模型列表）", () => {
  it("refuses to run in browser preview without touching invoke", async () => {
    await expect(
      listAiModels(profile({ provider: "deepseek", apiKey: "sk-x" }))
    ).rejects.toThrow("浏览器演示态不联网");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("invokes the Rust command with the current form values (no save needed)", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue([
      { id: "deepseek-reasoner", name: "DeepSeek R1" },
      { id: "deepseek-chat" },
    ]);

    const options = await listAiModels(
      profile({ provider: "deepseek", model: "whatever", apiKey: " sk-x ", baseUrl: " " })
    );

    // 命令参数与 Rust AiListModelsParams 对齐：空地址归 null，密钥去空白
    expect(invokeMock).toHaveBeenCalledWith("ai_list_models", {
      params: { provider: "deepseek", api_key: "sk-x", base_url: null },
    });
    // 返回原样透传（排序由 Rust 侧保证）
    expect(options.map((o) => o.id)).toEqual(["deepseek-reasoner", "deepseek-chat"]);
    expect(options[0].name).toBe("DeepSeek R1");
  });
});

describe("saveAiProfileVerified（保存并校验方案）", () => {
  it("saves only after the ping check passes on desktop", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue({ content: "pong", tool_calls: [] });

    await expect(
      saveAiProfileVerified(profile({ id: "p-a", provider: "deepseek", model: "deepseek-chat", apiKey: "sk-x" }))
    ).resolves.toBe("verified");

    // 校验走 ai_chat 最小对话：密钥 / 地址 / 模型 ID 一次走通
    expect(invokeMock).toHaveBeenCalledWith("ai_chat", {
      params: {
        provider: "deepseek",
        model: "deepseek-chat",
        api_key: "sk-x",
        base_url: null,
        messages: [{ role: "user", content: "ping" }],
      },
    });
    // 校验通过才落盘
    expect(loadAiConfig().model).toBe("deepseek-chat");
  });

  it("keeps the stored profile untouched and rethrows when verification fails", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    upsertAiProfile(profile({ id: "p-old", model: "old-model", apiKey: "sk-ok" }));
    invokeMock.mockRejectedValue("401 invalid api key");

    await expect(
      saveAiProfileVerified(profile({ id: "p-new", model: "new-model", apiKey: "sk-bad" }))
    ).rejects.toThrow();

    // 校验不过：配置保持原状，没有把失败的新值写进去
    expect(loadAiConfig().model).toBe("old-model");
    expect(loadAiProfiles().profiles).toHaveLength(1);
  });

  it("falls back to a plain save in browser preview (no network)", async () => {
    await expect(
      saveAiProfileVerified(profile({ id: "p-web", model: "web-model", apiKey: "sk-x" }))
    ).resolves.toBe("saved-unchecked");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(loadAiConfig().model).toBe("web-model");
  });

  it("verifyAiConfig refuses to run in browser preview", async () => {
    await expect(verifyAiConfig(profile({}))).rejects.toThrow("浏览器演示态不联网");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
