/**
 * Provider 工厂：
 * - Tauri 外壳 → Rust rig-core（真实多供应商调用，传输实现在 lib/llm.ts）
 * - 浏览器演示态 / 单测 → 规则 mock（不联网走通全链路）
 */
import { isTauri } from "../../lib/env";
import { tauriLlm } from "../../lib/llm";
import type { AgentLlm } from "../types";
import { mockLlm } from "./mock";

export function createLlm(): AgentLlm {
  return isTauri() ? tauriLlm() : mockLlm();
}

export { mockLlm, tauriLlm };
