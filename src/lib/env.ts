/**
 * 运行环境判断（零依赖）：区分 Tauri 外壳与浏览器演示态。
 *
 * 单独成文件是为了切断全项目对 db.ts 的无谓依赖——
 * 任何模块都可能需要判断环境，但不该为此 import 巨型数据层。
 */

/** 是否在 Tauri 外壳里运行；浏览器里跑 dev 时走内存兜底，方便调样式。 */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
