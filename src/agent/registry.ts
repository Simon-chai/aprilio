/**
 * 工具注册表：循环使用的「条件装配后视图」。
 *
 * 能力的声明与装载已上移到 define.ts（工厂）+ manifest.ts（扫描）+
 * container.ts（容器）；本文件只负责把工具数组变成循环可查的注册表。
 */
import type { AgentTool, ToolDefinition } from "./types";

export interface ToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
  /** 序列化后的工具定义，随请求透传给 Rust/rig */
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
