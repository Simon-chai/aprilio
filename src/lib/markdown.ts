/**
 * markdown 渲染 —— 聊天里助手回复按 md 排版展示。
 *
 * marked 把 md 转 HTML(gfm 表格/删除线 + breaks:聊天场景单换行也视为换行),
 * DOMPurify 负责消毒:模型输出不可信,脚本、事件属性、javascript: 链接一律剥离。
 */
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({ gfm: true, breaks: true });

// 外链强制新窗口打开,避免把桌面应用的 WebView 带跑;noopener 防反向劫持
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (el.tagName === "A" && el.getAttribute("href")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
});

/** md 文本 → 消毒后的 HTML 字符串(供 v-html 注入) */
export function renderMarkdown(text: string): string {
  // async: false → 同步返回 string(marked 默认同步,类型上带 Promise 联合)
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}