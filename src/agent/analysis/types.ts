/**
 * 数据与文档深度分析引擎契约类型定义。
 *
 * 设计原则：
 * - 纯契约与容器抽象，零具体业务耦合
 * - 支持分析器动态装配、按类型/协议路由、多源文档提取与统一降级兜底
 */

/** 通用分析查询请求 */
export interface AnalysisQuery<TPayload = unknown> {
  /** 分析类别/协议（如 data, document, text2sql, aggregation 等） */
  kind: string;
  /** 具体的请求载荷数据 */
  payload: TPayload;
  /** 可选的查询元数据（如租户标识、请求标记等） */
  metadata?: Record<string, unknown>;
}

/** 分析执行上下文 */
export interface AnalysisContext {
  /** 取消信号 */
  signal?: AbortSignal;
  /** 运行环境能力集合 */
  capabilities?: Set<string>;
  /** 追踪与关联 ID */
  traceId?: string;
  /** 扩展上下文数据 */
  extra?: Record<string, unknown>;
}

/** 分析结果统一封装 */
export interface AnalysisResult<TData = unknown> {
  /** 是否成功 */
  ok: boolean;
  /** 文本摘要（供 LLM 回答或 UI 概览使用） */
  summary: string;
  /** 结构化数据（可选） */
  data?: TData;
  /** 错误信息（ok 为 false 时填入） */
  error?: string;
  /** 命中执行的分析器 ID */
  provider?: string;
  /** 是否使用了降级/兜底处理 */
  fallbackUsed?: boolean;
  /** 执行耗时（毫秒） */
  durationMs?: number;
}

/** 文档数据源抽象 */
export interface DocumentSource<TContent = string | Uint8Array | unknown> {
  id: string;
  name: string;
  type: string;
  content: TContent;
  metadata?: Record<string, unknown>;
}

/** 多源文档加载器契约 */
export interface DocumentSourceLoader {
  id: string;
  name?: string;
  supports(uri: string, options?: unknown): boolean | Promise<boolean>;
  load(uri: string, options?: unknown): Promise<DocumentSource>;
}

/** 分析器契约接口：数据与文档分析的具体实现者需满足此契约 */
export interface AnalysisProvider<
  TQuery extends AnalysisQuery = AnalysisQuery,
  TData = unknown,
> {
  /** 唯一标识 */
  id: string;
  /** 名称（用于日志与展示） */
  name: string;
  /** 描述信息 */
  description?: string;
  /** 优先级（数值越大越优先尝试路由，缺省 0） */
  priority?: number;
  /** 检查是否支持处理该查询 */
  supports(query: TQuery, ctx?: AnalysisContext): boolean | Promise<boolean>;
  /** 执行分析操作 */
  analyze(query: TQuery, ctx: AnalysisContext): Promise<AnalysisResult<TData>>;
  /** 可选的初始化生命周期钩子 */
  init?(ctx?: AnalysisContext): Promise<void> | void;
  /** 可选的销毁生命周期钩子 */
  destroy?(): Promise<void> | void;
}

/** 数据分析器契约（继承分析器契约，预留结构化分析特定扩展） */
export type DataAnalyzer<
  TQuery extends AnalysisQuery = AnalysisQuery,
  TData = unknown,
> = AnalysisProvider<TQuery, TData>;

/** 分析引擎初始化选项 */
export interface AnalysisEngineOptions {
  /** 全局降级兜底分析器 */
  fallbackProvider?: AnalysisProvider | null;
  /** 执行超时时间（毫秒） */
  timeoutMs?: number;
}

/** 分析引擎容器契约 */
export interface AnalysisEngine {
  /** 动态注册分析器，返回卸载函数 */
  register(provider: AnalysisProvider): () => void;
  /** 卸载指定分析器 */
  unregister(providerId: string): boolean;
  /** 获取指定分析器 */
  get(providerId: string): AnalysisProvider | undefined;
  /** 列出所有注册的分析器 */
  list(): AnalysisProvider[];

  /** 动态注册文档加载器，返回卸载函数 */
  registerLoader(loader: DocumentSourceLoader): () => void;
  /** 卸载指定文档加载器 */
  unregisterLoader(loaderId: string): boolean;
  /** 获取指定文档加载器 */
  getLoader(loaderId: string): DocumentSourceLoader | undefined;
  /** 列出所有文档加载器 */
  listLoaders(): DocumentSourceLoader[];
  /** 通过支持的文档加载器加载文档源 */
  loadDocument(uri: string, options?: unknown): Promise<DocumentSource>;

  /** 路由并执行分析请求 */
  execute<T = unknown>(query: AnalysisQuery, ctx?: AnalysisContext): Promise<AnalysisResult<T>>;
  /** 设置全局兜底分析器 */
  setFallbackProvider(provider: AnalysisProvider | null): void;
  /** 清理所有分析器与加载器 */
  clear(): void;
  /** 触发所有分析器的生命周期销毁 */
  destroy(): Promise<void>;
}
