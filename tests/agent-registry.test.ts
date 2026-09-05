import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../src/agent/registry";
import { buildCapabilityContainer, scanTools } from "../src/agent/manifest";
import type { AgentTool } from "../src/agent/types";

const dummyTool = (name: string): AgentTool => ({
  definition: {
    name,
    description: `${name} 测试工具`,
    parameters: { type: "object", properties: {}, required: [] },
  },
  execute: async () => ({ ok: true, summary: "" }),
});

describe("tool registry", () => {
  it("looks up tools by name and exposes serialized definitions", () => {
    const registry = createToolRegistry([dummyTool("a"), dummyTool("b")]);
    expect(registry.get("a")?.definition.description).toBe("a 测试工具");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.definitions().map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("rejects duplicate tool names", () => {
    expect(() => createToolRegistry([dummyTool("a"), dummyTool("a")])).toThrow(/重复注册/);
  });

  it("keeps every scanned definition a valid JSON schema object", () => {
    for (const def of createToolRegistry(scanTools()).definitions()) {
      expect(def.parameters.type).toBe("object");
      expect(Object.keys(def.parameters.properties).length).toBeGreaterThan(0);
    }
  });
});

describe("capability container", () => {
  it("assembles scanned tools plus the built-in ui_action", () => {
    const container = buildCapabilityContainer();
    const names = container.allTools().map((t) => t.definition.name);
    expect(names).toEqual(expect.arrayContaining(["navigate", "query_data", "find_docs", "ui_action"]));
  });

  it("applies conditional assembly based on the tool context", () => {
    const container = buildCapabilityContainer({
      tools: [
        { ...dummyTool("always"), condition: () => true },
        { ...dummyTool("desktop-only"), condition: (ctx) => !!ctx.capabilities?.has("tauri") },
      ],
    });
    const names = (ctx: Parameters<typeof container.resolveTools>[0]) =>
      container.resolveTools(ctx).map((t) => t.definition.name);

    expect(names({ router: {} as never })).not.toContain("desktop-only");
    expect(names({ router: {} as never, capabilities: new Set(["tauri"]) })).toContain("desktop-only");
  });

  it("merges rust-reported capabilities into bridge tools and notifies subscribers", () => {
    const container = buildCapabilityContainer();
    const changes: number[] = [];
    container.onChange(() => changes.push(changes.length + 1));

    container.mergeRustCapabilities([
      {
        name: "photos_dir",
        label: "照片目录",
        description: "获取照片存储目录",
        parameters: { type: "object", properties: {}, required: [] },
        command: "photos_dir",
      },
    ]);

    const tool = container.allTools().find((t) => t.definition.name === "photos_dir");
    expect(tool).toBeDefined();
    expect(container.capabilityLines().some((l) => l.includes("photos_dir"))).toBe(true);
    expect(changes).toHaveLength(1);

    // 重复合并同名能力应被忽略
    container.mergeRustCapabilities([
      {
        name: "photos_dir",
        label: "照片目录",
        description: "重复",
        parameters: { type: "object", properties: {}, required: [] },
        command: "photos_dir",
      },
    ]);
    expect(changes).toHaveLength(1);
  });

  it("routes rust bridge tool execution through the injected executor", async () => {
    const calls: [string, unknown][] = [];
    const container = buildCapabilityContainer({
      rustCapabilities: [
        {
          name: "photos_dir",
          label: "照片目录",
          description: "获取照片存储目录",
          parameters: { type: "object", properties: {}, required: [] },
          command: "photos_dir",
        },
      ],
      rustExecutor: async (cmd, args) => {
        calls.push([cmd, args]);
        return "/photos";
      },
    });
    const registry = container.registry({ router: {} as never });
    const result = await registry.get("photos_dir")!.execute({}, { router: {} as never });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("/photos");
    expect(calls).toEqual([["photos_dir", {}]]);
  });

  it("builds the ui_action definition from the registered page actions", () => {
    const container = buildCapabilityContainer();
    const def = container.uiActionDefinition();
    expect(def.name).toBe("ui_action");
    const desc = def.description;
    expect(desc).toContain("students/create-student");
    expect(desc).toContain("settings/clear-all-data");
    expect(desc).toContain("需确认");
    const pageEnum = def.parameters.properties.page?.enum;
    expect(pageEnum).toEqual(expect.arrayContaining(["students", "settings"]));
  });

  it("exposes capability lines for the system prompt", () => {
    const container = buildCapabilityContainer();
    const lines = container.capabilityLines();
    expect(lines.some((l) => l.startsWith("- navigate（界面跳转）"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- ui_action students/create-student"))).toBe(true);
  });
});
