import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  DEFAULT_AI_CONFIG,
  loadAiConfig,
  loadAiProfiles,
  setActiveAiProfile,
  upsertAiProfile,
  type AiProfile,
} from "../src/lib/ai";
import {
  AI_FAILOVER_COOLDOWN_MS,
  createFailoverLlm,
  failoverCandidates,
  isFailoverWorthy,
  isProfileCooling,
} from "../src/lib/ai-failover";
import type { AgentLlm, AgentMessage, LlmResponse } from "../src/lib/llm";

const profile = (patch: Partial<AiProfile>): AiProfile => ({
  id: "p-test",
  name: "测试方案",
  provider: "deepseek",
  model: "deepseek-chat",
  apiKey: "sk-test",
  baseUrl: "",
  temperature: 0.7,
  systemPrompt: "",
  ...patch,
});

const ok = (content = "ok"): LlmResponse => ({ content, toolCalls: [] });

/** 脚本化 LLM：按「第几次调用」或请求本身决定成功 / 抛错，并记录实际用到的模型 */
function scriptedLlm(
  script: (req: Parameters<AgentLlm["chat"]>[0], index: number) => Promise<LlmResponse> | LlmResponse,
): { llm: AgentLlm; models: string[] } {
  const models: string[] = [];
  const llm: AgentLlm = {
    async chat(req) {
      models.push(req.config.model);
      return await script(req, models.length - 1);
    },
  };
  return { llm, models };
}

function request(patch: Partial<Parameters<AgentLlm["chat"]>[0]> = {}) {
  const messages: AgentMessage[] = [{ role: "user", content: "你好" }];
  return { system: "系统", messages, tools: [], config: loadAiConfig(), ...patch };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invokeMock.mockReset();
});

describe("aiFailoverCandidates（候选顺序）", () => {
  it("puts the active profile first and keeps unconfigured profiles out", () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b", apiKey: "" })); // 缺密钥
    upsertAiProfile(profile({ id: "p-c", model: "model-c" }));
    setActiveAiProfile("p-c");

    const candidates = failoverCandidates(loadAiConfig());
    expect(candidates.map((c) => c.profileId)).toEqual(["p-c", "p-a"]);
  });

  it("falls back to the passed config when no profile is configured", () => {
    const config = { ...DEFAULT_AI_CONFIG, model: "adhoc", apiKey: "sk-x" };
    const candidates = failoverCandidates(config);
    expect(candidates).toEqual([{ profileId: null, config }]);
  });
});

describe("createFailoverLlm（失败自动切换）", () => {
  it("switches to the next configured profile and persists the switch", async () => {
    upsertAiProfile(profile({ id: "p-a", name: "主力", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", name: "备用", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      if (req.config.model === "model-a") throw new Error("429 rate limit exceeded");
      return ok("from-b");
    });

    const result = await createFailoverLlm(llm).chat(request());

    expect(result.content).toBe("from-b");
    expect(models).toEqual(["model-a", "model-b"]);
    // 持久切换：当前方案指向可用模型，后续 loadAiConfig 直接读到它
    expect(loadAiProfiles().activeId).toBe("p-b");
    expect(loadAiConfig().model).toBe("model-b");
    // 失败方案进入冷却，冷却期过后自动回到候选
    expect(isProfileCooling("p-a")).toBe(true);
  });

  it("keeps the active profile when the first attempt succeeds", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm(() => ok("from-a"));
    await createFailoverLlm(llm).chat(request());

    expect(models).toEqual(["model-a"]);
    expect(loadAiProfiles().activeId).toBe("p-a");
    expect(isProfileCooling("p-a")).toBe(false);
  });

  it("skips profiles without api keys", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b", apiKey: "" }));
    upsertAiProfile(profile({ id: "p-c", model: "model-c" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      if (req.config.model === "model-a") throw new Error("401 invalid api key");
      return ok("from-c");
    });

    const result = await createFailoverLlm(llm).chat(request());
    expect(result.content).toBe("from-c");
    expect(models).toEqual(["model-a", "model-c"]);
  });

  it("drops a cooling profile from fallback order until the cooldown expires", async () => {
    const t0 = 1_000_000;
    vi.spyOn(Date, "now").mockReturnValue(t0);
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm } = scriptedLlm((req) => {
      if (req.config.model === "model-a") throw new Error("network reset");
      return ok("from-b");
    });
    await createFailoverLlm(llm).chat(request());

    // 冷却期内：备用顺序里不再出现刚失败的方案
    expect(failoverCandidates(loadAiConfig()).map((c) => c.profileId)).toEqual(["p-b"]);
    vi.spyOn(Date, "now").mockReturnValue(t0 + AI_FAILOVER_COOLDOWN_MS + 1);
    expect(failoverCandidates(loadAiConfig()).map((c) => c.profileId)).toEqual(["p-b", "p-a"]);
  });

  it("always tries the manually selected profile first, even if it is cooling", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm } = scriptedLlm((req) => {
      if (req.config.model === "model-a") throw new Error("network reset");
      return ok("from-b");
    });
    await createFailoverLlm(llm).chat(request());
    expect(isProfileCooling("p-a")).toBe(true);

    // 用户手动切回：立即按用户的选择重试，不被冷却挡住
    setActiveAiProfile("p-a");
    expect(failoverCandidates(loadAiConfig())[0].profileId).toBe("p-a");
  });

  it("does not fail over once streamed text already reached the UI", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      req.onDelta?.("半句");
      throw new Error("network reset");
    });
    const deltas: string[] = [];

    await expect(
      createFailoverLlm(llm).chat(request({ onDelta: (t) => deltas.push(t) })),
    ).rejects.toThrow("network reset");

    expect(models).toEqual(["model-a"]);
    expect(deltas).toEqual(["半句"]);
    expect(loadAiProfiles().activeId).toBe("p-a");
  });

  it("does not fail over on request-parameter errors", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm(() => {
      throw new Error("invalid args: missing field `messages`");
    });

    await expect(createFailoverLlm(llm).chat(request())).rejects.toThrow("missing field");
    expect(models).toEqual(["model-a"]);
    expect(isFailoverWorthy("serializ error")).toBe(false);
    expect(isFailoverWorthy("429 rate limit")).toBe(true);
  });

  it("fails over when the first streamed token never arrives", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      if (req.config.model === "model-a") return new Promise<LlmResponse>(() => {});
      return ok("from-b");
    });

    const result = await createFailoverLlm(llm, { firstByteTimeoutMs: 15 }).chat(
      request({ onDelta: () => {} }),
    );

    expect(result.content).toBe("from-b");
    expect(models).toEqual(["model-a", "model-b"]);
    expect(loadAiProfiles().activeId).toBe("p-b");
  });

  it("fails over when a non-streaming call exceeds the total timeout", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      if (req.config.model === "model-a") return new Promise<LlmResponse>(() => {});
      return ok("from-b");
    });

    const result = await createFailoverLlm(llm, { totalTimeoutMs: 15 }).chat(request());
    expect(result.content).toBe("from-b");
    expect(models).toEqual(["model-a", "model-b"]);
  });

  it("reports the attempts and the primary cause when every profile fails", async () => {
    upsertAiProfile(profile({ id: "p-a", model: "model-a" }));
    upsertAiProfile(profile({ id: "p-b", model: "model-b" }));
    setActiveAiProfile("p-a");

    const { llm, models } = scriptedLlm((req) => {
      if (req.config.model === "model-a") throw new Error("429 rate limit");
      throw "401 invalid api key";
    });

    await expect(createFailoverLlm(llm).chat(request())).rejects.toThrow(
      /已自动尝试 2 个模型方案，全部失败.*429/,
    );
    expect(models).toEqual(["model-a", "model-b"]);
    // 全部失败不切换当前方案，避免在不可用模型间来回跳
    expect(loadAiProfiles().activeId).toBe("p-a");
  });

  it("uses the passed config directly when there is only an ad-hoc config", async () => {
    const { llm, models } = scriptedLlm(() => ok("adhoc"));
    const config = { ...DEFAULT_AI_CONFIG, provider: "openai", model: "gpt-x", apiKey: "sk-x" };

    const result = await createFailoverLlm(llm).chat(request({ config }));
    expect(result.content).toBe("adhoc");
    expect(models).toEqual(["gpt-x"]);
    expect(loadAiProfiles().activeId).toBe("");
  });
});
