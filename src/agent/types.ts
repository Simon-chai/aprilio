/**
 * 自主 Agent 框架的核心类型。
 *
 * 分层约定（详见 docs/AGENT.md）：
 * - 循环（loop.ts）在 TS 侧驱动：LLM 返回 tool_calls → 注册表执行 → 结果回喂 → 直到给出最终回复
 * - 工具执行体全在前端（vue-router / db.ts / 内联文档），零 IPC 成本
 * - LLM 协议转换在 Rust（rig-core）：工具定义与多轮消息透传，返回文本 + tool_calls
 */

/** 传给 LLM 的工具声明（JSON Schema 形式，可序列化后透传给 Rust/rig-core） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      {
        type: string;
        description: string;
        enum?: string[];
      }
    >;
    required?: string[];
  };
}

/** 工具执行期间可用的应用能力集合 */
export interface AgentToolContext {
  /** 路由器实例：导航类工具用来跳转界面 */
  router: {
    push(location: { name?: string; params?: Record<string, string> }): Promise<unknown>;
    currentRoute: { value: { name?: string | symbol | null } };
  };
  /** 运行环境标记：条件装配用（如 photos 工具仅在桌面端装配） */
  capabilities?: Set<string>;
}

/** 页面动作：某个页面声明的按钮级操作，经 ui_action 工具暴露给 Agent */
export interface PageAction {
  /** 动作所在页面（路由名，与 NAV_TARGETS.routeName 对齐） */
  page: string;
  /** 动作键，页面内唯一，如 create-student */
  key: string;
  /** 中文名（工具卡片 / 动作清单展示） */
  label: string;
  description: string;
  /** 写操作：执行前要求模型先征得用户同意并传 confirm:true */
  dangerous: boolean;
  run(ctx: AgentToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Rust 执行面上报的能力描述（src-tauri/src/capabilities.rs 收集后经 IPC 传来） */
export interface RustCapabilityReport {
  name: string;
  label: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  /** 执行时调用的 Tauri 命令名 */
  command: string;
  tags?: string[];
}

/** Rust 能力的实际执行器：默认 tauri invoke，测试可注入替身 */
export type RustExecutor = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** 工具执行的统一返回：summary 回喂 LLM，data 供 UI 摘要展示 */
export interface ToolResult {
  ok: boolean;
  /** 给 LLM 的文本（通常是查询结果的 JSON），失败时留空 */
  summary: string;
  /** 给 UI 的结构化数据（可选） */
  data?: unknown;
  /** 失败原因（ok=false 时必填） */
  error?: string;
}

/** 单个工具：声明 + 执行器。新工具 = defineAgentTool() 声明后放入 tools/ 即被容器装载 */
export interface AgentTool {
  definition: ToolDefinition;
  /** 中文名（UI 工具卡片展示），defineAgentTool 填写 */
  label?: string;
  /** 分类标记（只读 / 写操作等），容器与 MCP 工具表共享 */
  tags?: string[];
  /** 写操作：容器装配时包上确认门（用户同意后模型须带 confirm:true 重调） */
  dangerous?: boolean;
  /** 条件装配谓词（@Conditional 的对应物）；缺省恒可用 */
  condition?: (ctx: AgentToolContext) => boolean;
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<ToolResult>;
}

/** LLM 发起的工具调用 */
export interface ToolCallPayload {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Agent 消息序列（与 Rust 侧 AiMessage 协议一一对应，serde tag = "role"）。
 * - assistant 携带 toolCalls 表示模型发起了调用
 * - tool 消息是把工具结果回喂给模型
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPayload[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** LLM 单轮响应 */
export interface LlmResponse {
  /** 助手文本（可能为空，比如只发起工具调用时） */
  content: string;
  toolCalls: ToolCallPayload[];
}

/** LLM 抽象：循环只依赖这个接口，方便 mock / 日后换实现 */
export interface AgentLlm {
  chat(req: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDefinition[];
    config: import("../lib/ai").AiConfig;
    /** 流式回调：助手文本增量（Rust Channel 推送 / mock 整段模拟）。可缺省 */
    onDelta?: (text: string) => void;
  }): Promise<LlmResponse>;
}

/** 循环过程中的事件，UI 用来实时渲染工具卡片与流式文本 */
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-start"; call: ToolCallPayload }
  | { type: "tool-end"; call: ToolCallPayload; result: ToolResult };

/** 一条工具执行记录（最终沉淀在结果里，供 UI 补渲染） */
export interface ToolRunRecord {
  call: ToolCallPayload;
  result: ToolResult;
}

/** 单轮 Agent 执行结果 */
export interface AgentTurnResult {
  /** 最终面向用户的回复 */
  reply: string;
  /** 本轮完整新增的消息序列（含 user），用于维护会话历史 */
  messages: AgentMessage[];
  toolRuns: ToolRunRecord[];
}
