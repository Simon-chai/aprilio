import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 工具的 AI 就绪检查依赖桌面端：这里只替换检查用的两个导出，
// 其余 lib/ai 能力保持原样；db 的 isTauri 仅对「工具」为真（内部仍走内存库）
vi.mock("../src/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai")>();
  return { ...actual, isAiConfigured: () => true, loadAiConfig: (() => ({})) as never };
});
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return { ...actual, isTauri: () => true };
});
// 环境判断已挪到 lib/env（工具与 *-ai 链路改从这里读取），与 db 开关保持同真
vi.mock("../src/lib/env", () => ({ isTauri: () => true }));

import tool from "../src/agent/tools/parent-summary";
import { buildCapabilityContainer } from "../src/agent/manifest";
import {
  consumeParentSummaryPanel,
  closeParentSummaryBatch,
  useParentSummaryBatch,
  useParentSummaryPanel,
} from "../src/composables/useParentSummary";
import { createStudent, getStudent } from "../src/lib/db";
import { emptyStudentInput } from "../src/types";
import type { AgentToolContext } from "../src/agent/types";

const batchState = useParentSummaryBatch();
const panelPreset = useParentSummaryPanel();

let mingA = 0;
let mingB = 0;
let hong = 0;

beforeAll(async () => {
  mingA = await createStudent({ ...emptyStudentInput(), name: "王小明", grade_class: "三年二班", student_no: "T1001" });
  mingB = await createStudent({ ...emptyStudentInput(), name: "王小明", grade_class: "四年一班", student_no: "T1002" });
  hong = await createStudent({ ...emptyStudentInput(), name: "李小红", grade_class: "三年二班", student_no: "T1003" });
});

beforeEach(() => {
  closeParentSummaryBatch();
  consumeParentSummaryPanel();
});

const makeCtx = () => {
  const push = vi.fn(async () => {});
  return { ctx: { router: { push } } as unknown as AgentToolContext, push };
};

describe("generate_parent_summary tool", () => {
  it("is registered in the container as a read tool", () => {
    const container = buildCapabilityContainer();
    const registered = container.allTools().find((t) => t.definition.name === "generate_parent_summary");
    expect(registered).toBeDefined();
    expect(registered?.dangerous).toBe(false);
    expect(registered?.tags).toContain("students");
  });

  it("rejects when no target is given", async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("生成目标");
  });

  it("rejects unknown student ids", async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ student_id: 999999 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未找到");
  });

  it("reports candidates for an ambiguous student name", async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ student_name: "王小明" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("王小明");
    expect(result.error).toContain("三年二班");
    expect(result.error).toContain("四年一班");
  });

  it("routes a single student to the profile tab with an autostart preset", async () => {
    const { ctx, push } = makeCtx();
    const before = panelPreset.seq;
    const result = await tool.execute(
      { student_id: mingA, requirement: "多肯定课堂发言" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("王小明");
    // 预设落在学生档案面板：自动生成 + 个性化要求
    expect(panelPreset.seq).toBe(before + 1);
    expect(panelPreset.studentId).toBe(mingA);
    expect(panelPreset.autoStart).toBe(true);
    expect(panelPreset.requirement).toBe("多肯定课堂发言");
    // 缺省时段 = 当前学期；并跳转到学生档案
    expect(panelPreset.range?.mode).toBe("semester");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toMatchObject({ name: "student-detail", params: { id: String(mingA) } });
    // 批量对话框不被打开
    expect(batchState.open).toBe(false);
  });

  it("resolves an exact student name within a class scope", async () => {
    const { ctx, push } = makeCtx();
    const result = await tool.execute(
      { student_name: "王小明", class_name: "三年二班" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(panelPreset.studentId).toBe(mingA);
    expect(push.mock.calls[0][0]).toMatchObject({ name: "student-detail", params: { id: String(mingA) } });
  });

  it("opens the class batch dialog when only class_name is given", async () => {
    const { ctx, push } = makeCtx();
    const before = batchState.seq;
    const result = await tool.execute({ class_name: "三年二班" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("全班");
    expect(batchState.seq).toBe(before + 1);
    expect(batchState.open).toBe(true);
    expect(batchState.className).toBe("三年二班");
    expect(batchState.autoStart).toBe(true);
    // 全班模式不跳转学生档案、不设置面板预设
    expect(push).not.toHaveBeenCalled();
    expect(panelPreset.studentId).toBeNull();
  });

  it("passes custom date ranges through to the panel preset", async () => {
    const { ctx } = makeCtx();
    await tool.execute({ student_id: hong, start: "2026-09-01", end: "2026-09-30" }, ctx);
    expect(panelPreset.range).toEqual({ mode: "custom", start: "2026-09-01", end: "2026-09-30" });
  });

  it("rejects invalid custom ranges with the shared validation message", async () => {
    const { ctx, push } = makeCtx();
    const result = await tool.execute(
      { student_id: hong, start: "2026-09-30", end: "2026-09-01" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("起始日期不能晚于结束日期");
    expect(push).not.toHaveBeenCalled();
    expect(panelPreset.studentId).toBeNull();
    expect(batchState.open).toBe(false);
  });

  it("uses the student's own class in the receipt", async () => {
    const { ctx } = makeCtx();
    const student = await getStudent(hong);
    expect(student?.grade_class).toBe("三年二班");
    const result = await tool.execute({ student_id: hong }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("三年二班");
    expect(panelPreset.studentId).toBe(hong);
  });
});
