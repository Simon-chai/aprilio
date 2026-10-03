/**
 * 评价卡片导出编排：HTML → PNG → 保存（spec：docs/EVAL_CARD.md）。
 * 桌面端走系统「另存为」对话框 + fs 写文件（capabilities 需 dialog:allow-save
 * 与 fs:allow-write-file）；浏览器演示态退化为浏览器下载，方便 dev:web 预览。
 */
import { isTauri } from "./db";
import { htmlToPng } from "./html-to-png";

/**
 * 导出卡片 PNG，返回保存路径；用户在另存为对话框取消时返回空串。
 * @param html buildEvalCardHtml 产物（完整自包含 HTML）
 * @param defaultFileName 不含扩展名的默认文件名
 */
export async function exportEvalCardHtml(
  html: string,
  defaultFileName: string,
  scale = 2
): Promise<string> {
  const blob = await htmlToPng(html, ".card", scale);

  if (!isTauri()) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${defaultFileName}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return `${defaultFileName}.png`;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await save({
    defaultPath: `${defaultFileName}.png`,
    filters: [{ name: "PNG 图片", extensions: ["png"] }],
  });
  if (!path) return "";
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}
