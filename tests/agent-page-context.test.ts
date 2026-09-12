import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { buildSystemPrompt } from "../src/agent/prompt";
import { runAgentTurn } from "../src/agent/loop";
import {
  clearPageContext,
  getPageContext,
  reportPageContext,
} from "../src/agent/page-context-bus";
import currentPageTool from "../src/agent/tools/current-page";
import type { AgentLlm, AgentTool, AgentToolContext, LlmResponse } from "../src/agent/types";
import { DEFAULT_AI_CONFIG } from "../src/lib/ai";

const Blank = defineComponent({ render: () => null });

async function makeRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/classes", name: "classes", component: Blank },
      { path: "/classes/:name", name: "class-detail", component: Blank, props: true },
    ],
  });
  await router.push("/classes");
  await router.isReady();
  return router;
}

/** 测试替身路由上下文（工具只用到 currentRoute，push 缺省） */
function ctxOf(router: Router): AgentToolContext {
  return { router: router as unknown as AgentToolContext["router"] };
}

function reportDetail(summary: string) {
  reportPageContext({
    page: "class-detail",
    title: "班级详情 · 三年级二班",
    params: { name: "三年级二班" },
    summary,
  });
}

describe("page-context bus", () => {
  it("stores, overwrites and clears snapshots per page", () => {
    clearPageContext("class-detail");
    reportDetail("在用班级 · 学生 10 人 · 当前页签：学生名单");
    expect(getPageContext("class-detail")?.title).toBe("班级详情 · 三年级二班");
    expect(getPageContext("class-detail")?.summary).toContain("学生 10 人");

    // 同页面重复上报覆盖旧快照（数据刷新 / 页签切换）
    reportDetail("已归档（只读） · 当前页签：考试成绩");
    expect(getPageContext("class-detail")?.summary).toContain("已归档");

    clearPageContext("class-detail");
    expect(getPageContext("class-detail")).toBeUndefined();
  });
});

describe("system prompt 注入页面上下文", () => {
  it("prefers the view-reported snapshot over the registry label", () => {
    clearPageContext("class-detail");
    reportDetail("在用班级 · 学生 10 人 · 考试成绩 3 场 · 当前页签：考试成绩");
    const prompt = buildSystemPrompt("class-detail");
    expect(prompt).toContain("「班级详情 · 三年级二班」（class-detail）");
    expect(prompt).toContain("当前页面渲染概况：在用班级 · 学生 10 人");
    clearPageContext("class-detail");
  });

  it("falls back to the registry label when no snapshot was reported", () => {
    clearPageContext("classes");
    const prompt = buildSystemPrompt("classes");
    expect(prompt).toContain("「班级管理」（classes）");
    expect(prompt).not.toContain("渲染概况");
  });
});

describe("current_page tool", () => {
  it("returns the snapshot of the current route", async () => {
    const router = await makeRouter();
    await router.push({ name: "class-detail", params: { name: "三年级二班" } });
    clearPageContext("class-detail");
    reportDetail("在用班级 · 学生 10 人 · 当前页签：学生名单");

    const result = await currentPageTool.execute({}, ctxOf(router));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("班级详情 · 三年级二班");
    expect(result.summary).toContain("学生 10 人");
    clearPageContext("class-detail");
  });

  it("can inspect another page's snapshot via the page param", async () => {
    const router = await makeRouter();
    reportPageContext({
      page: "classes",
      title: "班级管理",
      summary: "在用 4 个 · 已归档 1 个",
    });
    const result = await currentPageTool.execute({ page: "classes" }, ctxOf(router));
    expect(result.summary).toContain("班级管理");
    expect(result.summary).toContain("已归档 1 个");
    clearPageContext("classes");
  });

  it("says so honestly when the page reports no context", async () => {
    const router = await makeRouter();
    await router.push({ name: "classes" });
    clearPageContext("classes");
    const result = await currentPageTool.execute({}, ctxOf(router));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("classes");
    expect(result.summary).toContain("没有上报渲染上下文");
  });
});

describe("loop 每轮重建 prompt（轮间页面切换可感知）", () => {
  it("sees the snapshot reported by a mid-turn navigation", async () => {
    clearPageContext("class-detail");
    const router = await makeRouter();
    await router.push("/classes");

    // 模拟「视图接住跳转后上报快照」：跳转 + 上报发生在同一工具执行体内
    const goDetail: AgentTool = {
      definition: {
        name: "go-detail",
        description: "跳到班级详情并模拟视图上报快照",
        parameters: { type: "object", properties: { noop: { type: "string", description: "占位" } } },
      },
      execute: async () => {
        await router.push({ name: "class-detail", params: { name: "三年级二班" } });
        reportDetail("在用班级 · 学生 10 人 · 当前页签：学生名单");
        return { ok: true, summary: "已打开班级详情。" };
      },
    };

    const steps: LlmResponse[] = [
      { content: "", toolCalls: [{ id: "c1", name: "go-detail", arguments: {} }] },
      { content: "已打开三年级二班详情页。", toolCalls: [] },
    ];
    let i = 0;
    const systems: string[] = [];
    const llm: AgentLlm = {
      async chat({ system }) {
        systems.push(system);
        return steps[Math.min(i++, steps.length - 1)];
      },
    };

    const result = await runAgentTurn({
      userText: "打开三年二班的详情页",
      history: [],
      registry: {
        get: (name: string) => (name === "go-detail" ? goDetail : undefined),
        list: () => [goDetail],
        definitions: () => [goDetail.definition],
      },
      llm,
      config: DEFAULT_AI_CONFIG,
      ctx: ctxOf(router),
      currentRoute: "classes",
    });

    expect(result.reply).toBe("已打开三年级二班详情页。");
    expect(systems[0]).not.toContain("班级详情 · 三年级二班");
    expect(systems[1]).toContain("「班级详情 · 三年级二班」（class-detail）");
    expect(systems[1]).toContain("当前页面渲染概况：在用班级 · 学生 10 人");
    clearPageContext("class-detail");
  });
});
