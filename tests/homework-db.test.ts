import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => {
  return { default: class MockDb {} };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

import {
  addHomeworkRecord,
  deleteHomeworkRecord,
  listHomeworkRecords,
  updateHomeworkRecord,
} from "../src/lib/db";

async function firstStudentId(): Promise<number> {
  const { listStudents } = await import("../src/lib/db");
  const all = await listStudents("");
  if (!all.length) throw new Error("内存种子缺少学生");
  return all[0].id;
}

describe("作业台账数据层（内存兜底）", () => {
  let sid = 0;
  beforeEach(async () => {
    sid = await firstStudentId();
  });

  it("新增→按区间查→更新→删除全链路", async () => {
    const id = await addHomeworkRecord({
      student_id: sid,
      homework_date: "2026-09-05",
      subject: "语文",
      status: "done",
      comment: "书写工整",
    });
    expect(id).toBeGreaterThan(0);

    const inRange = await listHomeworkRecords(sid, { start: "2026-09-01", end: "2026-09-06" });
    expect(inRange.some((r) => r.id === id)).toBe(true);

    const outRange = await listHomeworkRecords(sid, { start: "2026-08-01", end: "2026-08-31" });
    expect(outRange.some((r) => r.id === id)).toBe(false);

    await updateHomeworkRecord(id, { status: "excellent" });
    const after = await listHomeworkRecords(sid, {});
    expect(after.find((r) => r.id === id)?.status).toBe("excellent");

    await deleteHomeworkRecord(id);
    const gone = await listHomeworkRecords(sid, {});
    expect(gone.some((r) => r.id === id)).toBe(false);
  });

  it("未来日期拒绝入库", async () => {
    await expect(
      addHomeworkRecord({ student_id: sid, homework_date: "2099-01-01", subject: "数学", status: "done" })
    ).rejects.toThrow();
  });
});
