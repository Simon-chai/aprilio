/**
 * Provider 工厂：
 * - Tauri 外壳 → Rust rig-core（真实多供应商调用）
 * - 浏览器演示态 / 单测 → 规则 mock（不联网走通全链路）
 */
import { isTauri } from "../../lib/db";
import type { AgentLlm } from "../types";
import { tauriLlm } from "./tauri";
import { mockLlm } from "./mock";

export function createLlm(): AgentLlm {
  return isTauri() ? tauriLlm() : mockLlm();
}

export { mockLlm, tauriLlm };
