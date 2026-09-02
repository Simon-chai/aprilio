/**
 * 前端日志桥接：把渲染进程的报错统一转发到 Rust 日志插件，
 * 由 tauri-plugin-log 落盘（Windows 下为 %APPDATA%/<identifier>/logs/app.log）。
 *
 * 非 Tauri 环境（浏览器演示态、单测）下所有函数静默失效，不影响运行。
 */
import { debug, error, info, warn } from "@tauri-apps/plugin-log";
import { isTauri } from "./db";

type Level = "debug" | "info" | "warn" | "error";

function fmt(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function send(level: Level, ...args: unknown[]): void {
  if (!isTauri()) return;
  const message = `[renderer] ${args.map(fmt).join(" ")}`;
  const call =
    level === "error"
      ? error(message)
      : level === "warn"
        ? warn(message)
        : level === "info"
          ? info(message)
          : debug(message);
  call.catch(() => {
    /* 无日志外壳时忽略 */
  });
}

export const logDebug = (...args: unknown[]): void => send("debug", ...args);
export const logInfo = (...args: unknown[]): void => send("info", ...args);
export const logWarn = (...args: unknown[]): void => send("warn", ...args);
export const logError = (...args: unknown[]): void => send("error", ...args);

/** 劫持 console.error / console.warn：照常打印，同时写入日志文件。 */
function hookConsole(kind: "error" | "warn"): void {
  const original = console[kind].bind(console);
  console[kind] = (...args: unknown[]) => {
    original(...args);
    send(kind, ...args);
  };
}

let initialized = false;

/** 在应用入口调用一次：接管全局报错通道。 */
export function initLogging(): void {
  if (!isTauri() || initialized) return;
  initialized = true;

  hookConsole("error");
  hookConsole("warn");

  window.addEventListener("error", (event) => {
    logError(
      `[window.error] ${event.message}`,
      event.error ?? `${event.filename}:${event.lineno}:${event.colno}`,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError("[unhandledrejection]", event.reason);
  });
}
