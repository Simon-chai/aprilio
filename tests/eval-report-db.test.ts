import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => {
  return { default: class MockDb {} };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

import { createEvalReport, deleteEvalReport, listEvalReports, listStudents } from "../src/lib/db";

async function firstStudentId(): Promise<number> {
  const all = await listStudents("");
  if (!all.length) throw new Error("内存种子缺少学生");
  return all[0].id;
}

describe("评价报告存档数据层", () => {
  let sid = 0;
  beforeEach(async () => {
    sid = await firstStudentId();
  });

  it("保存→列表→删除", async () => {
    const id = await createEvalReport({
      student_id: sid,
      range_start: "2026-09-01",
      range_end: "2026-09-30",
      semester: null,
      title: "林知远 9月 评价报告",
      content_md: "# 报告\n很好",
      short_comment: "表现很好",
      source: "manual",
    });
    expect(id).toBeGreaterThan(0);
    const list = await listEvalReports(sid);
    expect(list.some((r) => r.id === id)).toBe(true);
    await deleteEvalReport(id);
    expect((await listEvalReports(sid)).some((r) => r.id === id)).toBe(false);
  });

  it("起止倒置与空内容拒绝", async () => {
    await expect(
      createEvalReport({
        student_id: sid,
        range_start: "2026-09-30",
        range_end: "2026-09-01",
        title: "x",
        content_md: "y",
      })
    ).rejects.toThrow();
    await expect(
      createEvalReport({ student_id: sid, range_start: "2026-09-01", range_end: "2026-09-30", title: "x", content_md: "  " })
    ).rejects.toThrow();
  });
});
