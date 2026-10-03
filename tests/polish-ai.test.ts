import { beforeEach, describe, expect, it } from "vitest";
import { parsePolishedText, polishText } from "../src/lib/polish-ai";
import { PROMPT_IDS } from "../src/prompts/ids";
import { resolvePrompt } from "../src/prompts/resolve";
import type { AgentLlm } from "../src/agent/types";
import type { PolishContext } from "../src/lib/polish-ai";

describe("parsePolishedText", () => {
  it("剥掉「润色后」类前缀与首尾引号包裹", () => {
    expect(parsePolishedText("润色后：课堂听讲专注")).toBe("课堂听讲专注");
    expect(parsePolishedText("改写后：书写工整")).toBe("书写工整");
    expect(parsePolishedText("「课堂听讲专注，积极发言」")).toBe("课堂听讲专注，积极发言");
    // 只剥首尾的成对包裹，正文中间的引号保留
    expect(parsePolishedText("他说「加油」之后更努力了")).toBe("他说「加油」之后更努力了");
  });

  it("保留换行结构，只裁首尾空白", () => {
    expect(parsePolishedText("第一句。\n第二句。")).toBe("第一句。\n第二句。");
  });

  it("按 maxLen 截断；空白输出返回空串", () => {
    expect(parsePolishedText("一".repeat(30), 10)).toHaveLength(10);
    expect(parsePolishedText("短文本", 10)).toBe("短文本");
    expect(parsePolishedText("   \n  ")).toBe("");
  });
});

describe("polishText", () => {
  const ctx: PolishContext = {
    scene: "作业备注",
    hint: "记在学生作业记录里的简短备注",
    context: "科目：语文",
    text: "今天作业整体不错有俩错题",
  };

  it("未就绪 / 原文为空 / 缺场景时直接抛错，不发起请求", async () => {
    let called = 0;
    const llm: AgentLlm = {
      chat: async () => {
        called += 1;
        return { content: "x", toolCalls: [] };
      },
    };
    await expect(polishText(ctx, { aiReady: false, llm })).rejects.toThrow("未配置 AI 模型");
    await expect(polishText({ ...ctx, text: "   " }, { aiReady: true, llm })).rejects.toThrow(
      "还没有输入内容",
    );
    await expect(polishText({ ...ctx, scene: " " }, { aiReady: true, llm })).rejects.toThrow(
      "缺少使用场景",
    );
    expect(called).toBe(0);
  });

  it("走通用润色提示词模块，用户消息携带场景 / 上下文 / 原文", async () => {
    const seen: { system: string; user: string }[] = [];
    const llm: AgentLlm = {
      chat: async (req) => {
        seen.push({
          system: req.system,
          user: req.messages.map((m) => String(m.content)).join("\n"),
        });
        return { content: "润色结果", toolCalls: [] };
      },
    };
    const out = await polishText(ctx, { aiReady: true, llm });
    expect(out).toBe("润色结果");
    // system 与提示词管理页的出厂文案同源（走 resolvePrompt）
    expect(seen[0].system).toBe(resolvePrompt(PROMPT_IDS.textPolish));
    expect(seen[0].user).toContain("【使用场景】作业备注（记在学生作业记录里的简短备注）");
    expect(seen[0].user).toContain("【相关信息】科目：语文");
    expect(seen[0].user).toContain("【原文】今天作业整体不错有俩错题");
  });

  it("hint / context 缺省时不产出空标签行", async () => {
    const users: string[] = [];
    const llm: AgentLlm = {
      chat: async (req) => {
        users.push(req.messages.map((m) => String(m.content)).join("\n"));
        return { content: "结果", toolCalls: [] };
      },
    };
    await polishText({ scene: "首页签名", text: "一句话" }, { aiReady: true, llm });
    expect(users[0]).toBe("【使用场景】首页签名\n【原文】一句话\n请润色这段文字。");
  });

  it("maxLen 截断润色结果", async () => {
    const llm: AgentLlm = { chat: async () => ({ content: "一".repeat(30), toolCalls: [] }) };
    const out = await polishText(ctx, { aiReady: true, llm, maxLen: 20 });
    expect(out).toHaveLength(20);
  });

  it("模型输出空白时报错而非返回空串", async () => {
    const llm: AgentLlm = { chat: async () => ({ content: "  ", toolCalls: [] }) };
    await expect(polishText(ctx, { aiReady: true, llm })).rejects.toThrow("没有返回有效的润色结果");
  });

  it("调用失败时抛出友好错误（原文不动由组件保证）", async () => {
    const throwing: AgentLlm = {
      chat: async () => {
        throw new Error("boom");
      },
    };
    await expect(polishText(ctx, { aiReady: true, llm: throwing })).rejects.toThrow(
      "AI 请求失败，请检查模型配置与网络。（boom）",
    );
  });
});
