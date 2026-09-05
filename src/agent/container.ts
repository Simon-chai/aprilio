/**
 * 能力容器 —— 借鉴 Spring 组件管理的「容器」：唯一事实源。
 *
 * 所有能力组件（TS 工具、页面动作、Rust 上报能力）在启动时装载进容器，
 * 内嵌轨工具表、system prompt 能力段、MCP 工具表都只是容器的视图。
 * 动态感知的机制不在扫描本身，而在容器的 onChange 事件：
 * 新能力装载 → 事件广播 → 增量同步 Rust 侧 Tool Server（P2）与 MCP 工具表（P3）。
 *
 * 刻意不引入完整 IoC：不做构造器注入、不做 AOP、不做 Bean 作用域。
 * 只借四样 —— 容器、声明式注册（define.ts）、条件装配（condition）、生命周期事件（onChange）。
 */
import { createToolRegistry, type ToolRegistry } from "./registry";
import type {
  AgentTool,
  AgentToolContext,
  PageAction,
  RustCapabilityReport,
  RustExecutor,
  ToolDefinition,
  ToolResult,
} from "./types";

/** ui_action 工具名，内置注册，不占 tools/ 目录（避免与容器循环依赖） */
export const UI_ACTION_TOOL = "ui_action";

export interface CapabilityContainerInput {
  /** TS 执行面工具（tools/ 自动扫描产物） */
  tools: AgentTool[];
  /** 页面动作（page-actions/ 自动扫描产物） */
  pageActions: PageAction[];
  /** Rust 执行面上报的能力（P2 起经 IPC 传入） */
  rustCapabilities?: RustCapabilityReport[];
  /** Rust 能力执行器：默认 tauri invoke，测试可注入替身 */
  rustExecutor?: RustExecutor;
}

export interface CapabilityContainer {
  /** 装载后的全部工具（含 Rust 桥接与内置 ui_action），已做去重校验 */
  allTools(): AgentTool[];
  /** 条件装配后的工具（condition(ctx) 为真的子集） */
  resolveTools(ctx: AgentToolContext): AgentTool[];
  /** 条件装配后的工具注册表，循环直接使用 */
  registry(ctx: AgentToolContext): ToolRegistry;
  /** system prompt 的能力段：每行一个「name（label）：description」 */
  capabilityLines(): string[];
  /** 某页面的动作清单（不传返回全部） */
  pageActions(page?: string): PageAction[];
  /** 内置 ui_action 工具的定义（动作清单动态生成） */
  uiActionDefinition(): ToolDefinition;
  /** 执行页面动作；写操作带确认门，返回值直接作为工具结果回喂模型 */
  runPageAction(
    page: string,
    action: string,
    args: Record<string, unknown>,
    ctx: AgentToolContext,
  ): Promise<ToolResult>;
  /** 容器变更订阅（P2/P3 的同步入口）；返回取消函数 */
  onChange(fn: () => void): () => void;
  /** 合并 Rust 上报能力（晚于启动到达时调用），触发 onChange */
  mergeRustCapabilities(reports: RustCapabilityReport[]): void;
}

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

async function defaultRustExecutor(command: string, args: Record<string, unknown>): Promise<unknown> {
  // 延迟加载：浏览器演示态不触达 Tauri
  const mod = (await import("@tauri-apps/api/core")) as { invoke: TauriInvoke };
  return mod.invoke(command, args);
}

/** Rust 能力 → 桥接工具：执行体直接路由到 Tauri 命令，不做跨语言回环 */
function toRustBridgeTool(report: RustCapabilityReport, exec: RustExecutor): AgentTool {
  const tags = report.tags ?? ["rust"];
  return {
    definition: {
      name: report.name,
      description: report.description,
      parameters: report.parameters,
    },
    label: report.label,
    tags,
    dangerous: tags.includes("write"),
    execute: async (args) => {
      try {
        const data = await exec(report.command, args);
        return {
          ok: true,
          summary: typeof data === "string" ? data : JSON.stringify(data),
          data,
        };
      } catch (e) {
        return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** 写操作确认门（human-in-the-loop v1）：模型必须先征得用户同意，带 confirm:true 重新调用 */
function withConfirmGate(tool: AgentTool): AgentTool {
  return {
    ...tool,
    execute: async (args, ctx) => {
      if (args.confirm !== true) {
        return {
          ok: false,
          summary: "",
          error: `"${tool.label ?? tool.definition.name}" 是写操作，请先向用户说明影响并征得同意，然后带 confirm:true 重新调用。`,
        };
      }
      return tool.execute(args, ctx);
    },
  };
}

/** 内置 ui_action 工具：定义随容器动作清单动态生成，执行走 runPageAction 确认门 */
function createUiActionTool(container: CapabilityContainer): AgentTool {
  return {
    definition: container.uiActionDefinition(),
    label: "页面动作",
    tags: ["builtin"],
    execute: async (args, ctx) => {
      const page = String(args.page ?? "").trim();
      const action = String(args.action ?? "").trim();
      if (!page || !action) {
        return { ok: false, summary: "", error: "缺少 page 或 action 参数。" };
      }
      return container.runPageAction(page, action, args, ctx);
    },
  };
}

export function createCapabilityContainer(input: CapabilityContainerInput): CapabilityContainer {
  const rustTools = (input.rustCapabilities ?? []).map((r) =>
    toRustBridgeTool(r, input.rustExecutor ?? defaultRustExecutor),
  );

  // 去重校验：容器拒绝同名能力（对应 Spring 的 bean 冲突）
  const byName = new Map<string, AgentTool>();
  for (const tool of [...input.tools, ...rustTools]) {
    const name = tool.definition.name;
    if (byName.has(name)) {
      throw new Error(`能力重复注册：${name}`);
    }
    byName.set(name, tool);
  }

  const actions: PageAction[] = [...input.pageActions];
  const actionIndex = new Map<string, PageAction>();
  for (const action of actions) {
    const id = `${action.page}/${action.key}`;
    if (actionIndex.has(id)) {
      throw new Error(`页面动作重复注册：${id}`);
    }
    actionIndex.set(id, action);
  }

  const listeners = new Set<() => void>();
  let uiAction: AgentTool | null = null;

  const api: CapabilityContainer = {
    allTools: () => {
      if (!uiAction) {
        uiAction = createUiActionTool(api);
      }
      return [...byName.values(), uiAction];
    },

    resolveTools: (ctx) =>
      api
        .allTools()
        .filter((t) => !t.condition || t.condition(ctx))
        // dangerous 的统一确认门在装配层生效；ui_action 自带门（runPageAction），不算 dangerous
        .map((t) => (t.dangerous ? withConfirmGate(t) : t)),

    registry: (ctx) => createToolRegistry(api.resolveTools(ctx)),

    capabilityLines: () => {
      const lines = [...byName.values()].map(
        (t) => `- ${t.definition.name}（${t.label ?? t.definition.name}）：${t.definition.description}`,
      );
      const actionLines = actions.map(
        (a) => `- ui_action ${a.page}/${a.key}（${a.label}）：${a.description}`,
      );
      return [...lines, ...actionLines];
    },

    pageActions: (page) => (page ? actions.filter((a) => a.page === page) : [...actions]),

    uiActionDefinition: (): ToolDefinition => {
      const pageKeys = [...new Set(actions.map((a) => a.page))];
      const listing = actions
        .map((a) => `${a.page}/${a.key}（${a.dangerous ? "写操作，需确认" : "只读"}）：${a.description}`)
        .join("；");
      return {
        name: UI_ACTION_TOOL,
        description:
          "执行页面上的按钮级动作。" +
          (listing ? `可用动作：${listing}。` : "当前没有可用动作。") +
          "标记为写操作的动作，必须先向用户确认，用户同意后调用时传 confirm:true。",
        parameters: {
          type: "object",
          properties: {
            page: {
              type: "string",
              enum: pageKeys.length ? pageKeys : undefined,
              description: "动作所在页面",
            },
            action: {
              type: "string",
              description: "动作键，取自可用动作清单（page/key 的 key 部分）",
            },
            args: {
              type: "object",
              description: "动作附加参数（可选）",
            },
            confirm: {
              type: "boolean",
              description: "写操作确认标记：用户明确同意后传 true",
            },
          },
          required: ["page", "action"],
        },
      };
    },

    runPageAction: async (page, action, args, ctx) => {
      const found = actionIndex.get(`${page}/${action}`);
      if (!found) {
        const known = actions.map((a) => `${a.page}/${a.key}`).join("、") || "（无）";
        return { ok: false, summary: "", error: `未知页面动作 "${page}/${action}"，可用：${known}。` };
      }
      // 写操作确认门：human-in-the-loop v1 —— 模型必须先征得用户同意
      if (found.dangerous && args.confirm !== true) {
        return {
          ok: false,
          summary: "",
          error: `"${found.label}" 是写操作，请先向用户说明影响并征得同意，然后带 confirm:true 重新调用。`,
        };
      }
      try {
        return await found.run(ctx, args);
      } catch (e) {
        return { ok: false, summary: "", error: e instanceof Error ? e.message : String(e) };
      }
    },

    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    mergeRustCapabilities: (reports) => {
      let added = false;
      for (const report of reports) {
        if (byName.has(report.name)) continue;
        byName.set(report.name, toRustBridgeTool(report, input.rustExecutor ?? defaultRustExecutor));
        added = true;
      }
      if (!added) return; // 无变化不广播，避免下游无效同步
      uiAction = null; // 工具清单已变化，下次访问时重建 ui_action 定义
      for (const fn of listeners) fn();
    },
  };

  return api;
}
