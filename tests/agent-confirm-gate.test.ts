import { describe, expect, it } from "vitest";
import { buildCapabilityContainer } from "../src/agent/manifest";
import { defineAgentTool } from "../src/agent/define";
import type { AgentToolContext, RustCapabilityReport } from "../src/agent/types";

const ctx: AgentToolContext = { router: {} as never };

const rustReports: RustCapabilityReport[] = [
  {
    name: "import_photo",
    label: "导入照片文件",
    description: "把指定路径的图片文件复制进照片目录。",
    parameters: { type: "object", properties: {}, required: [] },
    command: "import_photo",
    tags: ["rust", "write"],
  },
  {
    name: "photos_dir",
    label: "照片目录",
    description: "获取照片存储目录。",
    parameters: { type: "object", properties: {}, required: [] },
    command: "photos_dir",
    tags: ["rust"],
  },
];

function makeDangerousTool() {
  return defineAgentTool({
    name: "wipe_note",
    label: "清空备注",
    description: "写操作测试工具。",
    parameters: { type: "object", properties: {}, required: [] },
    dangerous: true,
    execute: async () => ({ ok: true, summary: "已清空" }),
  });
}

describe("dangerous tool confirm gate", () => {
  it("blocks dangerous TS tools until confirm:true is passed", async () => {
    const container = buildCapabilityContainer({ tools: [makeDangerousTool()] });
    const tool = container.registry(ctx).get("wipe_note");

    const blocked = await tool!.execute({}, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");

    const done = await tool!.execute({ confirm: true }, ctx);
    expect(done.ok).toBe(true);
    expect(done.summary).toBe("已清空");
  });

  it("gates rust bridge tools carrying the write tag", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const container = buildCapabilityContainer({
      rustCapabilities: rustReports,
      rustExecutor: async (cmd, args) => {
        calls.push([cmd, args]);
        return "ok";
      },
    });
    const tool = container.registry(ctx).get("import_photo");

    const blocked = await tool!.execute({ source: "C:/pic.png" }, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");
    expect(calls).toHaveLength(0); // 未确认不触达命令

    const done = await tool!.execute({ source: "C:/pic.png", confirm: true }, ctx);
    expect(done.ok).toBe(true);
    expect(calls).toEqual([["import_photo", { source: "C:/pic.png", confirm: true }]]);
  });

  it("leaves read-only tools untouched", async () => {
    const container = buildCapabilityContainer({
      rustCapabilities: rustReports,
      rustExecutor: async () => "D:/photos",
    });
    const tool = container.registry(ctx).get("photos_dir");
    const result = await tool!.execute({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("D:/photos");
  });
});
