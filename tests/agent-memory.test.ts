import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  MEMORY_QUEUE_LIMIT,
  MEMORY_TEMPLATE,
  isMemoryLearningEnabled,
  loadMemoryQueue,
  memoryForPrompt,
  refreshMemoryCache,
  saveMemoryQueue,
  setMemoryLearningEnabled,
  type MemoryInteraction,
} from "../src/agent/memory-store";
import {
  flushMemoryQueue,
  initAgentMemory,
  memoryFlushMessage,
  recordAgentInteraction,
} from "../src/agent/memory";
import { buildSystemPrompt } from "../src/agent/prompt";
import { saveAiProfiles } from "../src/lib/ai";
import type { AgentLlm } from "../src/agent/types";

/**
 * Agent 记忆子系统：存储层（模板 / 注入过滤 / 队列 / 开关）+ 整理管线
 * （记录入队、防抖调度、LLM 合并、未变化不写盘、失败保留队列）。
 *
 * Tauri 环境用 window.__TAURI_INTERNALS__ 伪造，agent_memory_* 命令用
 * invoke 替身 + 进程内 fakeFile 模拟落盘；整理模型分两条路替换——
 * 显式注入走 flushMemoryQueue({ llm })，record / init 内部触发的整理
 * 走被 mock 的 tauriLlm（defaultLlm 脚本）。
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** record / init 内部触发的整理走默认传输：这里的脚本决定合并结果 */
const defaultLlm = vi.hoisted(() => ({
  script: null as null | (() => string),
  calls: [] as string[],
}));

vi.mock("../src/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/llm")>();
  return {
    ...actual,
    tauriLlm: () => ({
      async chat(req: { messages: { role: string; content: string }[] }) {
        defaultLlm.calls.push(req.messages[0]?.content ?? "");
        if (!defaultLlm.script) throw new Error("测试未设置整理模型脚本");
        return { content: defaultLlm.script(), toolCalls: [] };
      },
    }),
  };
});

const invokeMock = vi.mocked(invoke);

/** 伪造的桌面端记忆文件内容（invoke 替身的存储介质） */
let fakeFile = "";

/** 让 isAiConfigured 通过：本机方案集里放一个已配置方案 */
function configAi(): void {
  saveAiProfiles({
    activeId: "p1",
    profiles: [
      {
        id: "p1",
        name: "测试方案",
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "k",
        baseUrl: "",
        temperature: 0.7,
        systemPrompt: "",
      },
    ],
  });
}

/** 显式注入用的整理模型替身：记录收到的整理输入，按脚本返回合并后的记忆全文 */
function curatorLlm(script: () => string) {
  const inputs: string[] = [];
  const llm = {
    async chat(req: { messages: { role: string; content: string }[] }) {
      inputs.push(req.messages[0]?.content ?? "");
      return { content: script(), toolCalls: [] };
    },
  } as unknown as AgentLlm;
  return { llm, inputs };
}

/** 记录一批对话片段（编号进 user 字段便于断言先后） */
function recordBatch(count: number, offset = 0): void {
  for (let i = 0; i < count; i++) {
    recordAgentInteraction({
      page: "classes",
      user: `需求 ${offset + i}`,
      reply: `回复 ${offset + i}`,
      tools: i % 2 === 0 ? ["navigate"] : [],
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  fakeFile = "";
  defaultLlm.script = null;
  defaultLlm.calls = [];
  vi.useFakeTimers();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "agent_memory_read":
        return fakeFile;
      case "agent_memory_write":
        fakeFile = String((args as { content?: string } | undefined)?.content ?? "");
        return null;
      case "agent_memory_path":
        return "C:/appdata/aprilio/agent-memory.md";
      default:
        throw new Error(`记忆测试不认识的命令：${cmd}`);
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe("memoryForPrompt（注入过滤）", () => {
  it("模板只有骨架：标题 / 注释 / 空行全部剔除，注入为空串", () => {
    expect(memoryForPrompt(MEMORY_TEMPLATE)).toBe("");
  });

  it("只保留「- 」条目行，其余原样丢弃", () => {
    const raw = [
      "# 助手记忆",
      "<!-- 说明 -->",
      "## 词汇与叫法",
      "- 「学生列表」= 班级管理页",
      "",
      "  - 缩进的条目也算",
    ].join("\n");
    expect(memoryForPrompt(raw)).toBe("- 「学生列表」= 班级管理页\n- 缩进的条目也算");
  });
});

describe("flushMemoryQueue（后台整理）", () => {
  it("队列空时返回 idle", async () => {
    configAi();
    expect(await flushMemoryQueue()).toBe("idle");
  });

  it("模型未配置 / 学习关闭 / 非桌面端分别返回 not-ready / disabled / not-ready，队列保留", async () => {
    recordBatch(1);
    expect(await flushMemoryQueue()).toBe("not-ready");

    configAi();
    setMemoryLearningEnabled(false);
    expect(await flushMemoryQueue()).toBe("disabled");
    setMemoryLearningEnabled(true);

    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    expect(await flushMemoryQueue()).toBe("not-ready");
    expect(loadMemoryQueue()).toHaveLength(1);
  });

  it("模型判断无新偏好：不写盘，队列消化完，整理输入带记忆全文与片段", async () => {
    configAi();
    fakeFile = MEMORY_TEMPLATE; // 生产环境启动时已播种模板
    recordBatch(2);
    const { llm, inputs } = curatorLlm(() => MEMORY_TEMPLATE);
    expect(await flushMemoryQueue({ llm })).toBe("unchanged");
    expect(loadMemoryQueue()).toHaveLength(0);
    expect(inputs[0]).toContain("【当前记忆全文】");
    expect(inputs[0]).toContain("需求 0");
    expect(inputs[0]).toContain("调用工具：navigate");
  });

  it("模型合并出新偏好：整文件写回，缓存同步，下一次对话立即可见", async () => {
    configAi();
    fakeFile = MEMORY_TEMPLATE;
    recordBatch(2);
    // 模板以换行结尾，条目接在其后自成一行；parse 会 trim 首尾空白
    const updated = `${MEMORY_TEMPLATE}- 「学生列表」= 班级管理页`;
    const { llm } = curatorLlm(() => updated);
    expect(await flushMemoryQueue({ llm })).toBe("updated");
    expect(fakeFile).toBe(updated);
    expect(buildSystemPrompt("classes")).toContain("「学生列表」= 班级管理页");
    expect(loadMemoryQueue()).toHaveLength(0);
  });

  it("模型请求失败 / 输出超长：返回 failed，队列保留待重试", async () => {
    configAi();
    recordBatch(2);
    const throwing: AgentLlm = {
      async chat() {
        throw new Error("网络炸了");
      },
    };
    expect(await flushMemoryQueue({ llm: throwing })).toBe("failed");
    expect(loadMemoryQueue()).toHaveLength(2);

    const { llm } = curatorLlm(() => "x".repeat(8001));
    expect(await flushMemoryQueue({ llm })).toBe("failed");
    expect(loadMemoryQueue()).toHaveLength(2);
  });

  it("整理进行中再次触发返回 busy（单飞）", async () => {
    configAi();
    fakeFile = MEMORY_TEMPLATE;
    recordBatch(2);
    let release!: (value: { content: string; toolCalls: [] }) => void;
    const gate = new Promise<{ content: string; toolCalls: [] }>((r) => (release = r));
    const llm = {
      chat: () => gate,
    } as unknown as AgentLlm;
    const first = flushMemoryQueue({ llm });
    expect(await flushMemoryQueue({ llm })).toBe("busy");
    release({ content: MEMORY_TEMPLATE, toolCalls: [] });
    expect(await first).toBe("unchanged");
  });
});

describe("recordAgentInteraction（记录与调度）", () => {
  it("片段截断入队：字段限长、工具名过滤、时间记录", () => {
    recordAgentInteraction({
      page: "x".repeat(100),
      user: "u".repeat(500),
      reply: "r".repeat(500),
      tools: [
        "navigate",
        "",
        "query_data",
        "find_docs",
        "analyze",
        "ui_action",
        "find_docs",
        "多出来的",
      ],
    });
    const queue = loadMemoryQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].page.length).toBeLessThanOrEqual(60);
    expect(queue[0].user.length).toBeLessThanOrEqual(400);
    expect(queue[0].reply.length).toBeLessThanOrEqual(400);
    expect(queue[0].tools).toEqual([
      "navigate",
      "query_data",
      "find_docs",
      "analyze",
      "ui_action",
      "find_docs",
    ]);
    expect(queue[0].at).toBeTruthy();
  });

  it("攒满 6 条立即整理，不等防抖", async () => {
    configAi();
    defaultLlm.script = () => MEMORY_TEMPLATE;
    recordBatch(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadMemoryQueue()).toHaveLength(0);
    expect(defaultLlm.calls).toHaveLength(1);
  });

  it("未攒满时防抖 90 秒后整理", async () => {
    configAi();
    defaultLlm.script = () => MEMORY_TEMPLATE;
    recordBatch(1);
    expect(loadMemoryQueue()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(89_000);
    expect(loadMemoryQueue()).toHaveLength(1); // 还没到点
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadMemoryQueue()).toHaveLength(0); // 防抖到点，整理消化
  });

  it("非桌面端 / 学习关闭时不入队", () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    recordBatch(2);
    expect(loadMemoryQueue()).toHaveLength(0);

    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    setMemoryLearningEnabled(false);
    recordBatch(2);
    expect(loadMemoryQueue()).toHaveLength(0);
    expect(isMemoryLearningEnabled()).toBe(false);
  });

  it("队列上限 40 条：超出丢最旧的", async () => {
    recordBatch(MEMORY_QUEUE_LIMIT + 1);
    await vi.advanceTimersByTimeAsync(0);
    const queue = loadMemoryQueue();
    expect(queue).toHaveLength(MEMORY_QUEUE_LIMIT);
    expect(queue[0].user).toBe("需求 1"); // 最旧的「需求 0」已被挤掉
  });
});

describe("initAgentMemory（启动初始化）", () => {
  it("记忆文件为空时播种模板", async () => {
    initAgentMemory();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeFile).toBe(MEMORY_TEMPLATE);
  });

  it("已有记忆时不覆盖", async () => {
    fakeFile = `${MEMORY_TEMPLATE}- 已有条目\n`;
    initAgentMemory();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeFile).toBe(`${MEMORY_TEMPLATE}- 已有条目\n`);
  });

  it("启动时有积压：30 秒后补一次整理", async () => {
    configAi();
    defaultLlm.script = () => MEMORY_TEMPLATE;
    const pending: MemoryInteraction[] = [
      { at: new Date().toISOString(), page: "classes", user: "需求 0", reply: "回复 0", tools: [] },
    ];
    saveMemoryQueue(pending);
    initAgentMemory();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(loadMemoryQueue()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadMemoryQueue()).toHaveLength(0);
    expect(defaultLlm.calls).toHaveLength(1);
  });
});

describe("buildSystemPrompt 的记忆注入", () => {
  it("只有模板骨架时不注入（与出厂文案零漂移）", async () => {
    fakeFile = MEMORY_TEMPLATE;
    await refreshMemoryCache();
    const system = buildSystemPrompt("classes");
    expect(system).not.toContain("用户偏好记忆");
    expect(system).not.toContain("补充设定");
  });

  it("有条目时注入 {用户记忆} 占位符所在段", async () => {
    fakeFile = `${MEMORY_TEMPLATE}- 「学生列表」= 班级管理页\n`;
    await refreshMemoryCache();
    const system = buildSystemPrompt("classes");
    expect(system).toContain("用户偏好记忆（本机自动沉淀，供你贴合用户的叫法与习惯）：");
    expect(system).toContain("- 「学生列表」= 班级管理页");
  });
});

describe("开关与文案", () => {
  it("自动学习默认开启，可关闭再打开", () => {
    expect(isMemoryLearningEnabled()).toBe(true);
    setMemoryLearningEnabled(false);
    expect(isMemoryLearningEnabled()).toBe(false);
    setMemoryLearningEnabled(true);
    expect(isMemoryLearningEnabled()).toBe(true);
  });

  it("整理结果都有中文说明", () => {
    for (const result of [
      "busy",
      "idle",
      "disabled",
      "not-ready",
      "updated",
      "unchanged",
      "failed",
    ] as const) {
      expect(memoryFlushMessage(result)).toBeTruthy();
    }
  });
});
