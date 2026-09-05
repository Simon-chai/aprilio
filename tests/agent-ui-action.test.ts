import { describe, expect, it } from "vitest";
import { buildCapabilityContainer } from "../src/agent/manifest";
import { emitPageAction, onPageAction } from "../src/agent/page-action-bus";
import type { AgentToolContext } from "../src/agent/types";

const ctx: AgentToolContext = { router: {} as never };

function findUiAction(container: ReturnType<typeof buildCapabilityContainer>) {
  const tool = container.allTools().find((t) => t.definition.name === "ui_action");
  if (!tool) throw new Error("ui_action 未注册");
  return tool;
}

describe("ui_action tool", () => {
  it("rejects unknown page actions with the available list", async () => {
    const container = buildCapabilityContainer();
    const result = await findUiAction(container).execute(
      { page: "students", action: "nope" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知页面动作");
    expect(result.error).toContain("students/create-student");
  });

  it("gates dangerous actions behind confirm:true (human-in-the-loop v1)", async () => {
    const container = buildCapabilityContainer();
    const tool = findUiAction(container);

    // 第一次：未确认 → 拒绝并提示确认话术
    const blocked = await tool.execute(
      { page: "settings", action: "clear-all-data" },
      ctx,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");

    // 第二次：confirm:true → 真正执行（浏览器演示态走内存数据）
    const done = await tool.execute(
      { page: "settings", action: "clear-all-data", confirm: true },
      ctx,
    );
    expect(done.ok).toBe(true);
    expect(done.summary).toContain("已清空");
  });

  it("delivers view-bound actions through the page action bus", async () => {
    const container = buildCapabilityContainer();
    let opened = false;
    const off = onPageAction("students/create-student", () => {
      opened = true;
    });

    const result = await findUiAction(container).execute(
      { page: "students", action: "create-student" },
      ctx,
    );
    off();

    expect(opened).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("新建学生");
  });

  it("delivers preset args to view through page action bus", async () => {
    const container = buildCapabilityContainer();
    let payload: unknown = null;
    const off = onPageAction("students/create-student", (data) => {
      payload = data;
    });

    const preset = {
      name: "王小明",
      gender: "男",
      grade_class: "一年级二班",
      student_no: "20240101",
      guardian_phone: "13811112222",
      note: "插班生",
    };

    const result = await findUiAction(container).execute(
      {
        page: "students",
        action: "create-student",
        args: preset,
      },
      ctx,
    );
    off();

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("预填");
    expect(payload).toEqual(preset);
  });

  it("reports a failed delivery when no view is listening", async () => {
    const container = buildCapabilityContainer();
    const result = await findUiAction(container).execute(
      { page: "students", action: "create-student" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("视图未挂载");
  });

  it("emits nothing when the bus subscriber is removed", () => {
    const off = onPageAction("students/create-student", () => {});
    off();
    expect(emitPageAction("students/create-student")).toBe(false);
  });
});
