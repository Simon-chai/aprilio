import type {
  AnalysisContext,
  AnalysisEngine,
  AnalysisEngineOptions,
  AnalysisProvider,
  AnalysisQuery,
  AnalysisResult,
  DocumentSource,
  DocumentSourceLoader,
} from "./types";

export class AnalysisEngineImpl implements AnalysisEngine {
  private providers = new Map<string, AnalysisProvider>();
  private loaders = new Map<string, DocumentSourceLoader>();
  private fallbackProvider: AnalysisProvider | null = null;
  private timeoutMs?: number;

  constructor(options: AnalysisEngineOptions = {}) {
    this.fallbackProvider = options.fallbackProvider ?? null;
    this.timeoutMs = options.timeoutMs;
  }

  register(provider: AnalysisProvider): () => void {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()) {
      throw new Error("Provider must have a valid non-empty id");
    }
    this.providers.set(provider.id, provider);
    return () => {
      this.unregister(provider.id);
    };
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get(providerId: string): AnalysisProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): AnalysisProvider[] {
    return Array.from(this.providers.values()).sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
  }

  registerLoader(loader: DocumentSourceLoader): () => void {
    if (!loader || typeof loader.id !== "string" || !loader.id.trim()) {
      throw new Error("Loader must have a valid non-empty id");
    }
    this.loaders.set(loader.id, loader);
    return () => {
      this.unregisterLoader(loader.id);
    };
  }

  unregisterLoader(loaderId: string): boolean {
    return this.loaders.delete(loaderId);
  }

  getLoader(loaderId: string): DocumentSourceLoader | undefined {
    return this.loaders.get(loaderId);
  }

  listLoaders(): DocumentSourceLoader[] {
    return Array.from(this.loaders.values());
  }

  async loadDocument(uri: string, options?: unknown): Promise<DocumentSource> {
    for (const loader of this.loaders.values()) {
      try {
        const supported = await loader.supports(uri, options);
        if (supported) {
          return await loader.load(uri, options);
        }
      } catch (err) {
        // 忽略检查异常，尝试下一个加载器
      }
    }
    throw new Error(`未找到能够加载 URI 的文档加载器: "${uri}"`);
  }

  setFallbackProvider(provider: AnalysisProvider | null): void {
    this.fallbackProvider = provider;
  }

  async execute<T = unknown>(
    query: AnalysisQuery,
    ctx: AnalysisContext = {},
  ): Promise<AnalysisResult<T>> {
    const start = Date.now();
    const sortedProviders = this.list();

    let matchedProvider: AnalysisProvider | null = null;
    for (const provider of sortedProviders) {
      try {
        const supported = await provider.supports(query, ctx);
        if (supported) {
          matchedProvider = provider;
          break;
        }
      } catch (err) {
        // 忽略 supports 检查异常，继续寻找下一个
      }
    }

    if (matchedProvider) {
      try {
        const res = await this.invokeWithTimeout(matchedProvider, query, ctx);
        return {
          ...res,
          provider: res.provider ?? matchedProvider.id,
          durationMs: Date.now() - start,
        } as AnalysisResult<T>;
      } catch (err) {
        // 主分析器执行失败，尝试兜底分析器
        if (this.fallbackProvider) {
          return this.executeFallback<T>(query, ctx, start, err);
        }
        return {
          ok: false,
          summary: "",
          error: `分析器 [${matchedProvider.id}] 执行异常: ${err instanceof Error ? err.message : String(err)}`,
          provider: matchedProvider.id,
          durationMs: Date.now() - start,
        };
      }
    }

    if (this.fallbackProvider) {
      return this.executeFallback<T>(query, ctx, start);
    }

    return {
      ok: false,
      summary: "",
      error: `无可用分析器支持查询类型: "${query.kind}"`,
      durationMs: Date.now() - start,
    };
  }

  private async executeFallback<T>(
    query: AnalysisQuery,
    ctx: AnalysisContext,
    start: number,
    primaryError?: unknown,
  ): Promise<AnalysisResult<T>> {
    if (!this.fallbackProvider) {
      return {
        ok: false,
        summary: "",
        error: "未配置降级兜底分析器",
        durationMs: Date.now() - start,
      };
    }
    try {
      const fallbackRes = await this.invokeWithTimeout(this.fallbackProvider, query, ctx);
      return {
        ...fallbackRes,
        provider: fallbackRes.provider ?? this.fallbackProvider.id,
        fallbackUsed: true,
        durationMs: Date.now() - start,
      } as AnalysisResult<T>;
    } catch (fallbackErr) {
      const primaryErrDesc = primaryError
        ? ` (原分析错误: ${primaryError instanceof Error ? primaryError.message : String(primaryError)})`
        : "";
      return {
        ok: false,
        summary: "",
        error: `降级分析器 [${this.fallbackProvider.id}] 失败: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}${primaryErrDesc}`,
        provider: this.fallbackProvider.id,
        fallbackUsed: true,
        durationMs: Date.now() - start,
      };
    }
  }

  private async invokeWithTimeout<T>(
    provider: AnalysisProvider,
    query: AnalysisQuery,
    ctx: AnalysisContext,
  ): Promise<AnalysisResult<T>> {
    if (!this.timeoutMs || this.timeoutMs <= 0) {
      return (await provider.analyze(query, ctx)) as AnalysisResult<T>;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`分析超时 (超过 ${this.timeoutMs}ms)`));
      }, this.timeoutMs);
    });

    try {
      return (await Promise.race([
        provider.analyze(query, ctx),
        timeoutPromise,
      ])) as AnalysisResult<T>;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  clear(): void {
    this.providers.clear();
    this.loaders.clear();
    this.fallbackProvider = null;
  }

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      if (typeof provider.destroy === "function") {
        try {
          await provider.destroy();
        } catch {
          // 忽略销毁时的异常
        }
      }
    }
    this.clear();
  }
}

export function createAnalysisEngine(options?: AnalysisEngineOptions): AnalysisEngine {
  return new AnalysisEngineImpl(options);
}

/** 全局默认分析引擎单例 */
export const defaultAnalysisEngine: AnalysisEngine = createAnalysisEngine();
