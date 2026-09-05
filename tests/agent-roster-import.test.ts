import { describe, expect, it } from "vitest";
import { buildCapabilityContainer } from "../src/agent/manifest";
import { onPageAction } from "../src/agent/page-action-bus";
import importRosterPageAction from "../src/agent/page-actions/students-import";
import type { AgentToolContext } from "../src/agent/types";

const ctx: AgentToolContext = { router: {} as never };

describe("import_student_roster tool", () => {
  it("is registered in container and marked dangerous", () => {
    const container = buildCapabilityContainer();
    const tool = container.allTools().find((t) => t.definition.name === "import_student_roster");
    expect(tool).toBeDefined();
    expect(tool?.dangerous).toBe(true);
    expect(tool?.tags).toContain("students");
    expect(tool?.tags).toContain("write");
  });

  it("blocks import without confirm:true via container confirm gate", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("import_student_roster");
    expect(tool).toBeDefined();

    const blocked = await tool!.execute({}, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");
  });

  it("explains the desktop-only limitation in browser demo mode", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("import_student_roster");

    // vitest 是浏览器演示态（isTauri=false）：确认门放行后也不触达文件系统
    const result = await tool!.execute({ confirm: true }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("桌面端");
  });
});

describe("students/import-roster page action", () => {
  it("broadcasts the import dialog request with mode", async () => {
    const received: (string | undefined)[] = [];
    const off = onPageAction<string>("students/import-roster", (mode) => {
      received.push(mode);
    });

    const result = await importRosterPageAction.run(ctx, {
      page: "students",
      action: "import-roster",
      args: { mode: "template" },
    });
    off();

    expect(result.ok).toBe(true);
    expect(received).toEqual(["template"]);
    expect(result.summary).toContain("指定格式");
  });

  it("defaults to smart import mode", async () => {
    const received: (string | undefined)[] = [];
    const off = onPageAction<string>("students/import-roster", (mode) => {
      received.push(mode);
    });

    const result = await importRosterPageAction.run(ctx, { page: "students", action: "import-roster" });
    off();

    expect(result.ok).toBe(true);
    expect(received).toEqual(["smart"]);
  });

  it("fails gracefully when the students view is not mounted", async () => {
    const result = await importRosterPageAction.run(ctx, { page: "students", action: "import-roster" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法打开导入对话框");
  });
});
