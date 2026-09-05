import { describe, expect, it } from "vitest";
import { createAnalysisEngine } from "../src/agent/analysis";
import type { AnalysisProvider, AnalysisQuery } from "../src/agent/analysis";

describe("AnalysisEngine Framework", () => {
  describe("Provider Registration & Management", () => {
    it("registers and unregisters analysis providers", () => {
      const engine = createAnalysisEngine();
      const mockProvider: AnalysisProvider = {
        id: "mock-data-analyzer",
        name: "Mock Data Analyzer",
        supports: (q: AnalysisQuery) => q.kind === "data",
        analyze: async (q) => ({
          ok: true,
          summary: `Analyzed ${q.kind}`,
          data: { sample: 123 },
        }),
      };

      const unregister = engine.register(mockProvider);
      expect(engine.get("mock-data-analyzer")).toBe(mockProvider);
      expect(engine.list()).toHaveLength(1);

      unregister();
      expect(engine.get("mock-data-analyzer")).toBeUndefined();
      expect(engine.list()).toHaveLength(0);
    });

    it("throws error when registering a provider with invalid id", () => {
      const engine = createAnalysisEngine();
      expect(() =>
        engine.register({
          id: "",
          name: "Invalid",
          supports: () => true,
          analyze: async () => ({ ok: true, summary: "" }),
        }),
      ).toThrow("Provider must have a valid non-empty id");
    });
  });

  describe("Routing and Priority Dispatch", () => {
    it("routes query to the provider that supports it", async () => {
      const engine = createAnalysisEngine();

      engine.register({
        id: "text2sql",
        name: "Text2SQL Analyzer",
        supports: (q) => q.kind === "text2sql",
        analyze: async (q) => ({
          ok: true,
          summary: "Executed SQL query",
          data: { sql: "SELECT * FROM students", rows: [1, 2] },
        }),
      });

      engine.register({
        id: "doc-extractor",
        name: "Document Extractor",
        supports: (q) => q.kind === "document",
        analyze: async (q) => ({
          ok: true,
          summary: "Extracted document content",
          data: { title: "Test Doc" },
        }),
      });

      const sqlResult = await engine.execute({
        kind: "text2sql",
        payload: { prompt: "列出所有学生" },
      });

      expect(sqlResult.ok).toBe(true);
      expect(sqlResult.provider).toBe("text2sql");
      expect(sqlResult.summary).toBe("Executed SQL query");
      expect(sqlResult.data).toEqual({ sql: "SELECT * FROM students", rows: [1, 2] });

      const docResult = await engine.execute({
        kind: "document",
        payload: { file: "doc.md" },
      });

      expect(docResult.ok).toBe(true);
      expect(docResult.provider).toBe("doc-extractor");
      expect(docResult.summary).toBe("Extracted document content");
    });

    it("prefers higher priority provider when multiple providers support query", async () => {
      const engine = createAnalysisEngine();

      engine.register({
        id: "low-priority",
        name: "Low Priority",
        priority: 10,
        supports: () => true,
        analyze: async () => ({ ok: true, summary: "Low Priority Won" }),
      });

      engine.register({
        id: "high-priority",
        name: "High Priority",
        priority: 100,
        supports: () => true,
        analyze: async () => ({ ok: true, summary: "High Priority Won" }),
      });

      const res = await engine.execute({ kind: "any", payload: {} });
      expect(res.ok).toBe(true);
      expect(res.provider).toBe("high-priority");
      expect(res.summary).toBe("High Priority Won");
    });

    it("returns ok=false error result when no provider supports the query", async () => {
      const engine = createAnalysisEngine();
      const res = await engine.execute({ kind: "unsupported_kind", payload: {} });

      expect(res.ok).toBe(false);
      expect(res.error).toContain('无可用分析器支持查询类型: "unsupported_kind"');
      expect(res.durationMs).toBeTypeOf("number");
    });
  });

  describe("Error Isolation and Fallback Handling", () => {
    it("isolates provider exceptions and returns structured error without throwing", async () => {
      const engine = createAnalysisEngine();

      engine.register({
        id: "buggy-analyzer",
        name: "Buggy Analyzer",
        supports: () => true,
        analyze: async () => {
          throw new Error("Internal crash during computation");
        },
      });

      const res = await engine.execute({ kind: "crash_test", payload: {} });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("Internal crash during computation");
      expect(res.provider).toBe("buggy-analyzer");
      expect(res.durationMs).toBeTypeOf("number");
    });

    it("uses fallback provider when primary provider throws error", async () => {
      const fallbackProvider: AnalysisProvider = {
        id: "default-fallback",
        name: "Fallback Provider",
        supports: () => true,
        analyze: async () => ({
          ok: true,
          summary: "Fallback analysis completed",
          data: { fallback: true },
        }),
      };

      const engine = createAnalysisEngine({ fallbackProvider });

      engine.register({
        id: "failing-primary",
        name: "Failing Primary",
        supports: () => true,
        analyze: async () => {
          throw new Error("Database connection lost");
        },
      });

      const res = await engine.execute({ kind: "data", payload: {} });

      expect(res.ok).toBe(true);
      expect(res.summary).toBe("Fallback analysis completed");
      expect(res.fallbackUsed).toBe(true);
      expect(res.provider).toBe("default-fallback");
    });

    it("uses fallback provider when no primary provider supports the query", async () => {
      const fallbackProvider: AnalysisProvider = {
        id: "default-fallback",
        name: "Fallback Provider",
        supports: () => true,
        analyze: async (q) => ({
          ok: true,
          summary: `Handled unsupported kind ${q.kind} by fallback`,
        }),
      };

      const engine = createAnalysisEngine();
      engine.setFallbackProvider(fallbackProvider);

      const res = await engine.execute({ kind: "unknown-type", payload: {} });

      expect(res.ok).toBe(true);
      expect(res.fallbackUsed).toBe(true);
      expect(res.provider).toBe("default-fallback");
      expect(res.summary).toBe("Handled unsupported kind unknown-type by fallback");
    });

    it("captures failure when fallback provider also throws", async () => {
      const fallbackProvider: AnalysisProvider = {
        id: "broken-fallback",
        name: "Broken Fallback",
        supports: () => true,
        analyze: async () => {
          throw new Error("Fallback failed too");
        },
      };

      const engine = createAnalysisEngine({ fallbackProvider });
      engine.register({
        id: "broken-primary",
        name: "Broken Primary",
        supports: () => true,
        analyze: async () => {
          throw new Error("Primary failed");
        },
      });

      const res = await engine.execute({ kind: "test", payload: {} });

      expect(res.ok).toBe(false);
      expect(res.fallbackUsed).toBe(true);
      expect(res.error).toContain("Fallback failed too");
      expect(res.error).toContain("Primary failed");
    });

    it("handles execution timeout via timeoutMs option", async () => {
      const engine = createAnalysisEngine({ timeoutMs: 30 });

      engine.register({
        id: "slow-provider",
        name: "Slow Provider",
        supports: () => true,
        analyze: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ok: true, summary: "Finished late" };
        },
      });

      const res = await engine.execute({ kind: "slow", payload: {} });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("分析超时");
    });
  });

  describe("Context Propagation", () => {
    it("passes context to provider supports and analyze methods", async () => {
      const engine = createAnalysisEngine();
      let capturedSupportsCtx: unknown;
      let capturedAnalyzeCtx: unknown;

      engine.register({
        id: "context-inspector",
        name: "Context Inspector",
        supports: (_q, ctx) => {
          capturedSupportsCtx = ctx;
          return true;
        },
        analyze: async (_q, ctx) => {
          capturedAnalyzeCtx = ctx;
          return { ok: true, summary: "Context verified" };
        },
      });

      const controller = new AbortController();
      const customCtx = {
        signal: controller.signal,
        capabilities: new Set(["desktop", "gpu"]),
        traceId: "trace-98765",
        extra: { userId: "user-1" },
      };

      const res = await engine.execute({ kind: "test", payload: {} }, customCtx);

      expect(res.ok).toBe(true);
      expect(capturedSupportsCtx).toBe(customCtx);
      expect(capturedAnalyzeCtx).toBe(customCtx);
    });
  });

  describe("Document Source Loader Management", () => {
    it("registers, lists, and unregisters document loaders", () => {
      const engine = createAnalysisEngine();
      const mockLoader = {
        id: "pdf-loader",
        name: "PDF Loader",
        supports: (uri: string) => uri.endsWith(".pdf"),
        load: async (uri: string) => ({
          id: "doc-1",
          name: uri,
          type: "pdf",
          content: "PDF content stream",
        }),
      };

      const unregister = engine.registerLoader(mockLoader);
      expect(engine.getLoader("pdf-loader")).toBe(mockLoader);
      expect(engine.listLoaders()).toHaveLength(1);

      unregister();
      expect(engine.getLoader("pdf-loader")).toBeUndefined();
      expect(engine.listLoaders()).toHaveLength(0);
    });

    it("throws when registering a loader without valid id", () => {
      const engine = createAnalysisEngine();
      expect(() =>
        engine.registerLoader({
          id: "",
          supports: () => true,
          load: async () => ({ id: "1", name: "x", type: "x", content: "" }),
        }),
      ).toThrow("Loader must have a valid non-empty id");
    });

    it("routes loadDocument to matching loader", async () => {
      const engine = createAnalysisEngine();

      engine.registerLoader({
        id: "md-loader",
        supports: (uri) => uri.endsWith(".md"),
        load: async (uri) => ({
          id: uri,
          name: "Markdown Document",
          type: "markdown",
          content: "# Title",
        }),
      });

      const doc = await engine.loadDocument("README.md");
      expect(doc.id).toBe("README.md");
      expect(doc.type).toBe("markdown");
      expect(doc.content).toBe("# Title");
    });

    it("throws error when no loader matches document URI", async () => {
      const engine = createAnalysisEngine();
      await expect(engine.loadDocument("unsupported.xyz")).rejects.toThrow(
        '未找到能够加载 URI 的文档加载器: "unsupported.xyz"',
      );
    });
  });

  describe("Lifecycle and Resource Cleanup", () => {
    it("calls destroy lifecycle hook on registered providers during engine.destroy", async () => {
      const engine = createAnalysisEngine();
      let providerDestroyed = false;

      engine.register({
        id: "lifecycle-provider",
        name: "Lifecycle Provider",
        supports: () => true,
        analyze: async () => ({ ok: true, summary: "" }),
        destroy: () => {
          providerDestroyed = true;
        },
      });

      await engine.destroy();
      expect(providerDestroyed).toBe(true);
      expect(engine.list()).toHaveLength(0);
    });

    it("clears providers and loaders with engine.clear()", () => {
      const engine = createAnalysisEngine();

      engine.register({
        id: "p1",
        name: "P1",
        supports: () => true,
        analyze: async () => ({ ok: true, summary: "" }),
      });

      engine.registerLoader({
        id: "l1",
        supports: () => true,
        load: async () => ({ id: "1", name: "x", type: "x", content: "" }),
      });

      engine.clear();
      expect(engine.list()).toHaveLength(0);
      expect(engine.listLoaders()).toHaveLength(0);
    });
  });

  describe("Agent Tool Adapter (analyze)", () => {
    it("exports a valid AgentTool compatible with manifest scanner", async () => {
      const analyzeToolMod = await import("../src/agent/tools/analyze");
      const tool = analyzeToolMod.default;

      expect(tool).toBeDefined();
      expect(tool.definition.name).toBe("analyze");
      expect(tool.definition.parameters.properties.kind).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    });

    it("dispatches tool call arguments to AnalysisEngine and returns ToolResult", async () => {
      const { createAnalyzeTool } = await import("../src/agent/tools/analyze");
      const customEngine = createAnalysisEngine();

      customEngine.register({
        id: "stats-analyzer",
        name: "Stats Analyzer",
        supports: (q) => q.kind === "aggregation",
        analyze: async (q) => ({
          ok: true,
          summary: `Aggregation result for ${JSON.stringify(q.payload)}`,
          data: { total: 42 },
        }),
      });

      const tool = createAnalyzeTool(customEngine);
      const mockAgentCtx = {
        router: { push: async () => {}, currentRoute: { value: { name: "home" } } },
        capabilities: new Set(["desktop"]),
      };

      const result = await tool.execute(
        {
          kind: "aggregation",
          payload: { field: "score" },
        },
        mockAgentCtx,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain('{"field":"score"}');
      expect(result.data).toEqual({ total: 42 });
    });

    it("handles string payload in tool call gracefully", async () => {
      const { createAnalyzeTool } = await import("../src/agent/tools/analyze");
      const customEngine = createAnalysisEngine();

      customEngine.register({
        id: "text-analyzer",
        name: "Text Analyzer",
        supports: (q) => q.kind === "text",
        analyze: async (q) => ({
          ok: true,
          summary: `Parsed text query`,
          data: q.payload,
        }),
      });

      const tool = createAnalyzeTool(customEngine);
      const mockAgentCtx = {
        router: { push: async () => {}, currentRoute: { value: { name: "home" } } },
      };

      const result = await tool.execute(
        {
          kind: "text",
          payload: JSON.stringify({ query: "count students" }),
        },
        mockAgentCtx,
      );

      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ query: "count students" });
    });

    it("returns error ToolResult when kind parameter is missing", async () => {
      const { createAnalyzeTool } = await import("../src/agent/tools/analyze");
      const tool = createAnalyzeTool();

      const result = await tool.execute(
        {},
        { router: { push: async () => {}, currentRoute: { value: { name: "home" } } } },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("缺少必要的分析类型参数 kind");
    });
  });
});
