import { describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";

vi.mock("@tauri-apps/plugin-sql", () => {
  return { default: class MockDb {} };
});

import analyzeTool from "../src/agent/tools/analyze";
import queryDataTool from "../src/agent/tools/query";
import { addHomeworkRecord, listStudents } from "../src/lib/db";

const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

describe("评价报告 Agent 能力", () => {
  it("student_eval_report 按姓名汇总成绩+表现+作业", async () => {
    const lin = (await listStudents("林知远")).find((s) => s.name === "林知远")!;
    await addHomeworkRecord({
      student_id: lin.id,
      homework_date: "2026-09-05",
      subject: "语文",
      status: "excellent",
      comment: "书写工整",
    });
    const res = await analyzeTool.execute(
      { kind: "student_eval_report", payload: { student_id: lin.id, start: "2026-09-01", end: "2026-09-30" } },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("林知远");
    expect(res.summary).toContain("作业");
  });

  it("student_eval_report 缺学生定位返回可读错误", async () => {
    const res = await analyzeTool.execute({ kind: "student_eval_report", payload: {} }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("student_id");
  });

  it("query_data homeworks 按姓名兜底可查", async () => {
    const res = await queryDataTool.execute({ entity: "homeworks", keyword: "林知远" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("作业台账查询");
  });

  it("query_data eval_reports 缺 student_id 时拒绝", async () => {
    const res = await queryDataTool.execute({ entity: "eval_reports" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("student_id");
  });
});
