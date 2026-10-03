/**
 * 自包含 HTML → PNG（学生评价卡片导出用，spec：docs/EVAL_CARD.md）。
 * 不引入第三方依赖：隐藏 iframe 渲染 → foreignObject 序列化 → canvas 光栅化。
 * 约束：输入 HTML 必须完全自包含（系统字体、无外链资源、样式集中在 <style>）——
 * 这是 eval-card-template.ts 的硬性要求；算法已经 mockups/eval-card/harness.html
 * 在 Chromium（与 WebView2 同引擎）下验证通过。
 */

/**
 * 组装 foreignObject SVG 字符串（纯函数，供测试）。
 * innerHtml 为受信任的模板产物（eval-card-template 输出），不做转义。
 */
export function buildForeignObjectSvg(
  innerHtml: string,
  styleText: string,
  width: number,
  height: number
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif">` +
    `<style>${styleText}</style>${innerHtml}</div>` +
    `</foreignObject></svg>`
  );
}

/** 把含 .card 的完整 HTML 光栅化为 PNG（默认 2 倍清晰度） */
export async function htmlToPng(html: string, selector = ".card", scale = 2): Promise<Blob> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "760px",
    height: "2200px",
    border: "0",
    opacity: "0",
  });
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error("卡片渲染失败"));
      frame.srcdoc = html;
    });
    const doc = frame.contentDocument;
    const el = doc?.querySelector(selector);
    if (!doc || !el) throw new Error("未找到卡片内容");

    const styleText = doc.querySelector("style")?.textContent ?? "";
    const rect = el.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(rect.height);
    if (width <= 0 || height <= 0) throw new Error("卡片尺寸异常");

    const svg = buildForeignObjectSvg(el.outerHTML, styleText, width, height);
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("卡片转图片失败"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持画布");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("图片编码失败");
    return blob;
  } finally {
    frame.remove();
  }
}
