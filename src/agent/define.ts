/**
 * 声明式注册工厂 —— TypeScript 侧的「@Component」。
 *
 * TS 没有运行时注解，用「工厂 + 约定式导出」等价替代：
 * 工具文件 default export 一个 defineAgentTool() 的产物，
 * 容器通过 import.meta.glob 扫描装载（对应 Spring 的 classpath 扫描）。
 */
import type {
  AgentTool,
  AgentToolContext,
  PageAction,
  ToolDefinition,
  ToolResult,
} from "./types";

export interface AgentToolSpec {
  name: string;
  /** 中文名（UI 工具卡片展示） */
  label: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  /** 分类标记：readonly / write 等，容器与 MCP 工具表共享 */
  tags?: string[];
  /** 写操作：容器装配时包上确认门（用户同意后模型须带 confirm:true 重调） */
  dangerous?: boolean;
  /** 条件装配谓词；缺省恒可用 */
  condition?: (ctx: AgentToolContext) => boolean;
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult>;
}

export function defineAgentTool(spec: AgentToolSpec): AgentTool {
  return {
    definition: { name: spec.name, description: spec.description, parameters: spec.parameters },
    label: spec.label,
    tags: spec.tags,
    dangerous: spec.dangerous ?? false,
    condition: spec.condition,
    execute: spec.execute,
  };
}

export interface PageActionSpec {
  page: string;
  key: string;
  label: string;
  description: string;
  /** 写操作：执行前要求模型先征得用户同意并传 confirm:true */
  dangerous?: boolean;
  run(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

export function definePageAction(spec: PageActionSpec): PageAction {
  return {
    page: spec.page,
    key: spec.key,
    label: spec.label,
    description: spec.description,
    dangerous: spec.dangerous ?? false,
    run: spec.run,
  };
}
