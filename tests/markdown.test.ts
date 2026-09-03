import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown", () => {
  it("渲染常见 markdown 结构(标题/粗体/行内代码/列表)", () => {
    const html = renderMarkdown("# 标题\n\n**粗体** 与 `code`\n\n- 列表项");

    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>列表项</li>");
  });

  it("gfm 表格与代码块正常展开", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nconst x = 1\n```");

    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
  });

  it("单换行渲染为 <br>(breaks,聊天惯例)", () => {
    expect(renderMarkdown("第一行\n第二行")).toContain("<br");
  });

  it("剥离脚本与事件属性,文本内容保留", () => {
    const html = renderMarkdown("hi <script>alert(1)</script><img src=x onerror=alert(1)>");

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).toContain("hi");
  });

  it("javascript: 链接被清掉", () => {
    const html = renderMarkdown("[点我](javascript:alert(1))");

    expect(html).not.toContain("javascript:");
  });

  it("纯文本(非 md)内容原样保留", () => {
    expect(renderMarkdown("你好,世界")).toContain("你好,世界");
  });
});