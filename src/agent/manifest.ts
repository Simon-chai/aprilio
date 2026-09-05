/**
 * manifest —— 容器的装配入口：扫描装载 + 视图生成。
 *
 * 新增能力 = 新增文件：
 * - src/agent/tools/*.ts        default export defineAgentTool() 产物
 * - src/agent/page-actions/*.ts default export definePageAction() 产物
 * 两者都会被 import.meta.glob 自动装载（构建期已知、启动期注册，
 * 对应 Spring 的 classpath 扫描；dev 下新文件热更新即被感知）。
 */
import { createCapabilityContainer, type CapabilityContainer } from "./container";
import { isTauri } from "../lib/db";
import type { AgentTool, PageAction, RustCapabilityReport, RustExecutor } from "./types";

const toolModules = import.meta.glob<AgentTool>("./tools/*.ts", {
  import: "default",
  eager: true,
});

const pageActionModules = import.meta.glob<PageAction>("./page-actions/*.ts", {
  import: "default",
  eager: true,
});

/** tools/ 扫描产物（default export 且形如工具的模块） */
export function scanTools(): AgentTool[] {
  return Object.values(toolModules).filter(
    (m): m is AgentTool => !!m && typeof m === "object" && "definition" in m && "execute" in m,
  );
}

/** page-actions/ 扫描产物 */
export function scanPageActions(): PageAction[] {
  return Object.values(pageActionModules).filter(
    (m): m is PageAction => !!m && typeof m === "object" && "page" in m && "run" in m,
  );
}

export interface BuildContainerOptions {
  /** 覆盖扫描结果（测试 / 特殊装配用）；缺省用 tools/ 扫描产物 */
  tools?: AgentTool[];
  rustCapabilities?: RustCapabilityReport[];
  rustExecutor?: RustExecutor;
}

/* ------------------------------------------------------------------ */
/* Rust 执行面能力：启动时拉取一次并缓存                                 */
/* ------------------------------------------------------------------ */

let rustReports: RustCapabilityReport[] | null = null;

/** 桌面端启动时调用：拉取 Rust 侧 inventory 收集的能力清单并缓存 */
export async function ensureRustCapabilities(): Promise<void> {
  if (rustReports) return;
  if (!isTauri()) {
    rustReports = [];
    return;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    rustReports = await invoke<RustCapabilityReport[]>("agent_capabilities");
  } catch (e) {
    // 拉取失败不阻塞 Agent：只是暂时没有 Rust 执行面能力
    console.warn("[agent] 拉取 Rust 能力清单失败", e);
    rustReports = [];
  }
}

/** 装配能力容器：扫描产物 + Rust 上报能力 + 内置 ui_action */
export function buildCapabilityContainer(options: BuildContainerOptions = {}): CapabilityContainer {
  return createCapabilityContainer({
    tools: options.tools ?? scanTools(),
    pageActions: scanPageActions(),
    rustCapabilities: options.rustCapabilities ?? rustReports ?? [],
    rustExecutor: options.rustExecutor,
  });
}
