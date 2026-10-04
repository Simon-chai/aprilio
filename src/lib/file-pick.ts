/**
 * 浏览器演示态的文件选择（<input type=file>）：导入对话框三件套共用。
 * 取消选择时靠窗口焦点回落识别（change 事件不触发）；桌面端的系统文件对话框
 * 由各导入管道自己的 pickXxxFiles（Tauri dialog 插件）提供。
 */

/** 演示态 CSV/TSV 导入共用的 accept 串 */
export const TEXT_TABLE_ACCEPT = ".csv,.tsv,.txt,text/csv,text/plain";

/** 弹起文件选择框，返回选中的文件列表；multiple=false 时最多一个 */
export function pickFilesViaInput(accept = TEXT_TABLE_ACCEPT, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = accept;
    let settled = false;
    const done = (list: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(list);
    };
    const onFocus = () => setTimeout(() => done(input.files ? Array.from(input.files) : []), 300);
    input.addEventListener("change", () => done(input.files ? Array.from(input.files) : []));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}
