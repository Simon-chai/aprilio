import { describe, expect, it } from "vitest";
import { buildCapabilityContainer } from "../src/agent/manifest";
import type { AgentToolContext } from "../src/agent/types";

const ctx: AgentToolContext = { router: {} as never };

describe("import_score_sheet tool", () => {
  it("is registered in container and marked dangerous", () => {
    const container = buildCapabilityContainer();
    const tool = container.allTools().find((t) => t.definition.name === "import_score_sheet");
    expect(tool).toBeDefined();
    expect(tool?.dangerous).toBe(true);
    expect(tool?.tags).toContain("exams");
    expect(tool?.tags).toContain("write");
  });

  it("blocks import without confirm:true via container confirm gate", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("import_score_sheet");
    expect(tool).toBeDefined();

    const blocked = await tool!.execute({}, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");
  });

  it("explains the desktop-only limitation in browser demo mode", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("import_score_sheet");

    // vitest 是浏览器演示态（isTauri=false）：确认门放行后也不触达文件系统
    const result = await tool!.execute({ confirm: true }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("桌面端");
  });

  it("keeps the roster tool registered alongside (score-sheet diversion stays inside it)", () => {
    const container = buildCapabilityContainer();
    const names = container.allTools().map((t) => t.definition.name);
    expect(names).toContain("import_student_roster");
    expect(names).toContain("import_score_sheet");
  });
});
