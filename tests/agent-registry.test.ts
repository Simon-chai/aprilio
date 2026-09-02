import { describe, expect, it } from "vitest";
import { createToolRegistry, defaultAgentTools } from "../src/agent/registry";
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
  it("registers the three first-phase tools", () => {
    const names = defaultAgentTools().map((t) => t.definition.name);
    expect(names).toEqual(["navigate", "query_data", "find_docs"]);
  });

  it("looks up tools by name and exposes serialized definitions", () => {
    const registry = createToolRegistry([dummyTool("a"), dummyTool("b")]);
    expect(registry.get("a")?.definition.description).toBe("a 测试工具");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.definitions().map((d) => d.name)).toEqual(["a", "b"]);
  });

  it("rejects duplicate tool names", () => {
    expect(() => createToolRegistry([dummyTool("a"), dummyTool("a")])).toThrow(/重复注册/);
  });

  it("keeps every default definition a valid JSON schema object", () => {
    for (const def of createToolRegistry(defaultAgentTools()).definitions()) {
      expect(def.parameters.type).toBe("object");
      expect(Object.keys(def.parameters.properties).length).toBeGreaterThan(0);
    }
  });
});
