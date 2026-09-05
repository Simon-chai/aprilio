import { describe, expect, it } from "vitest";
import { buildCapabilityContainer } from "../src/agent/manifest";
import { getStudent } from "../src/lib/db";
import type { AgentToolContext } from "../src/agent/types";

const ctx: AgentToolContext = { router: {} as never };

describe("manage_students tool", () => {
  it("is registered in container and marked dangerous", () => {
    const container = buildCapabilityContainer();
    const tool = container.allTools().find((t) => t.definition.name === "manage_students");
    expect(tool).toBeDefined();
    expect(tool?.dangerous).toBe(true);
    expect(tool?.tags).toContain("students");
    expect(tool?.tags).toContain("write");
  });

  it("blocks operations without confirm:true via container confirm gate", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");
    expect(tool).toBeDefined();

    const blocked = await tool!.execute(
      {
        action: "create",
        name: "测试学生",
      },
      ctx,
    );

    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("confirm:true");
  });

  it("creates a new student when confirm:true is provided", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");

    const result = await tool!.execute(
      {
        action: "create",
        name: "赵六六",
        gender: "女",
        grade_class: "二年级一班",
        student_no: "20249999",
        guardian_phone: "13900009999",
        note: "通过智能体添加",
        confirm: true,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("赵六六");
    const data = result.data as { id: number };
    expect(data.id).toBeGreaterThan(0);

    const created = await getStudent(data.id);
    expect(created).not.toBeNull();
    expect(created?.name).toBe("赵六六");
    expect(created?.gender).toBe("女");
    expect(created?.grade_class).toBe("二年级一班");
    expect(created?.student_no).toBe("20249999");
    expect(created?.guardians[0]?.phone).toBe("13900009999");
    expect(created?.note).toBe("通过智能体添加");
  });

  it("updates existing student info and notes", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");

    // 更新 ID 为 1 的学生（林知远）
    const result = await tool!.execute(
      {
        action: "update",
        id: 1,
        note: "更新后的备注说明",
        guardian_phone: "13888888888",
        confirm: true,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("林知远");

    const updated = await getStudent(1);
    expect(updated?.note).toBe("更新后的备注说明");
    expect(updated?.guardians[0]?.phone).toBe("13888888888");
    // 未修改的字段保持不变
    expect(updated?.name).toBe("林知远");
    expect(updated?.grade_class).toBe("三年级二班");
  });

  it("deletes a student", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");

    // 先创建一个待删除的学生
    const createdRes = await tool!.execute(
      {
        action: "create",
        name: "待删学生",
        confirm: true,
      },
      ctx,
    );
    const newId = (createdRes.data as { id: number }).id;

    // 删除该学生
    const delRes = await tool!.execute(
      {
        action: "delete",
        id: newId,
        confirm: true,
      },
      ctx,
    );
    expect(delRes.ok).toBe(true);
    expect(delRes.summary).toContain("待删学生");

    const found = await getStudent(newId);
    expect(found).toBeNull();
  });

  it("returns error when update/delete student does not exist", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");

    const updateRes = await tool!.execute(
      { action: "update", id: 999999, confirm: true },
      ctx,
    );
    expect(updateRes.ok).toBe(false);
    expect(updateRes.error).toContain("未找到");

    const delRes = await tool!.execute(
      { action: "delete", id: 999999, confirm: true },
      ctx,
    );
    expect(delRes.ok).toBe(false);
    expect(delRes.error).toContain("未找到");
  });

  it("validates required action and parameters", async () => {
    const container = buildCapabilityContainer();
    const tool = container.registry(ctx).get("manage_students");

    const noNameRes = await tool!.execute(
      { action: "create", confirm: true },
      ctx,
    );
    expect(noNameRes.ok).toBe(false);
    expect(noNameRes.error).toContain("姓名");

    const unknownActionRes = await tool!.execute(
      { action: "unknown_op", confirm: true },
      ctx,
    );
    expect(unknownActionRes.ok).toBe(false);
    expect(unknownActionRes.error).toContain("未知操作类型");
  });
});
