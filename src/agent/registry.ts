/**
 * 工具注册表：Agent 能力清单的唯一入口。
 * 新增工具 = 实现一个 AgentTool 并加入 defaultAgentTools()，循环与 UI 无需改动。
 */
import type { AgentTool, ToolDefinition } from "./types";
import { navigateTool } from "./tools/navigation";
import { queryDataTool } from "./tools/query";
import { findDocsTool } from "./tools/docs";

export interface ToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
  /** 序列化后的工具定义，随请求透传给 Rust/genai */
  definitions(): ToolDefinition[];
}

export function createToolRegistry(tools: AgentTool[]): ToolRegistry {
  const byName = new Map<string, AgentTool>();
  for (const tool of tools) {
    if (byName.has(tool.definition.name)) {
      throw new Error(`工具名重复注册：${tool.definition.name}`);
    }
    byName.set(tool.definition.name, tool);
  }

  return {
    list: () => [...byName.values()],
    get: (name) => byName.get(name),
    definitions: () => [...byName.values()].map((t) => t.definition),
  };
}

/** 首期内置的三个基础工具；后续按钮操作、写备注等在此追加 */
export function defaultAgentTools(): AgentTool[] {
  return [navigateTool(), queryDataTool(), findDocsTool()];
}
