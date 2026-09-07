import { describe, expect, it, vi } from "vitest";
import { MEMO_TITLE_MAX_LEN, parseMemoTitle, summarizeMemoTitle } from "../src/lib/memo-ai";
import type { AgentLlm } from "../src/agent/types";

/** jsdom 无 Tauri 外壳 → isTauri() = false，summarizeMemoTitle 默认走 null 快路径 */
describe("parseMemoTitle", () => {
  it("取首行并去掉编号 / 项目符号 / 引号包裹", () => {
    expect(parseMemoTitle("1. 收作业")).toBe("收作业");
    expect(parseMemoTitle("2、家长会提醒")).toBe("家长会提醒");
    expect(parseMemoTitle("- 大课间彩排")).toBe("大课间彩排");
    expect(parseMemoTitle("「周五下午教研」\n第二行不要")).toBe("周五下午教研");
    expect(parseMemoTitle('"期中考试"')).toBe("期中考试");
  });

  it("超长截断到 12 字，空输入返回空串", () => {
    expect(parseMemoTitle("三年级二班周五放学前收秋游回执单")).toHaveLength(MEMO_TITLE_MAX_LEN);
    expect(parseMemoTitle("   \n  ")).toBe("");
  });
});

describe("summarizeMemoTitle", () => {
  it("未在 Tauri 外壳（浏览器演示态 / 单测）→ 直接 null，不发起请求", async () => {
    expect(await summarizeMemoTitle("收作业")).toBeNull();
  });

  it("空内容即使 AI 就绪也返回 null", async () => {
    const chat = vi.fn();
    expect(await summarizeMemoTitle("   ", { llm: { chat } as unknown as AgentLlm, aiReady: true })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("AI 就绪时经注入的 llm 生成并解析标题", async () => {
    const chat = vi.fn().mockResolvedValue({ content: "「三年二班收秋游回执」" });
    const title = await summarizeMemoTitle("周五放学前收三年级二班秋游回执单，没交的名单报我", {
      llm: { chat } as unknown as AgentLlm,
      aiReady: true,
    });
    expect(title).toBe("三年二班收秋游回执");
    expect(chat).toHaveBeenCalledOnce();
    const req = chat.mock.calls[0][0] as { system: string; messages: { content: string }[] };
    expect(req.system).toContain(String(MEMO_TITLE_MAX_LEN));
    expect(req.messages[0].content).toContain("秋游回执单");
  });

  it("模型输出为空 / 调用失败 → null（不阻塞展示）", async () => {
    const empty: AgentLlm = { chat: vi.fn().mockResolvedValue({ content: "「」" }) } as unknown as AgentLlm;
    expect(await summarizeMemoTitle("收作业", { llm: empty, aiReady: true })).toBeNull();

    const failing: AgentLlm = { chat: vi.fn().mockRejectedValue(new Error("network down")) } as unknown as AgentLlm;
    expect(await summarizeMemoTitle("收作业", { llm: failing, aiReady: true })).toBeNull();
  });
});
