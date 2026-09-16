import { afterAll, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import queryDataTool from "../src/agent/tools/query";

/** jsdom 无 Tauri 外壳 → db.ts 自动走内存示例数据（10 名学生、若干照片） */
const tool = queryDataTool;
const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

function rowsFrom(summary: string): unknown[] {
  const idx = summary.indexOf("\n");
  return JSON.parse(summary.slice(idx + 1)) as unknown[];
}

describe("query_data tool", () => {
  it("filters students by keyword", async () => {
    const result = await tool.execute({ entity: "students", keyword: "林" }, ctx);
    expect(result.ok).toBe(true);
    const rows = rowsFrom(result.summary) as { name: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.name === "林知远")).toBe(true);
  });

  it("filters students by grade class", async () => {
    const result = await tool.execute({ entity: "students", grade_class: "三年级二班" }, ctx);
    const rows = rowsFrom(result.summary) as { grade_class: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.grade_class === "三年级二班")).toBe(true);
  });

  it("caps the returned rows by limit", async () => {
    const result = await tool.execute({ entity: "students", limit: 3 }, ctx);
    expect((result.data as unknown[]).length).toBe(3);
    // 演示种子：10 名原有学生 + 四年级一班补足 8 名（成绩样例）
    expect(result.summary).toContain("命中 18 条");
  });

  it("queries photos and stats", async () => {
    const photos = await tool.execute({ entity: "photos" }, ctx);
    expect(photos.ok).toBe(true);
    expect((photos.data as unknown[]).length).toBeGreaterThan(0);

    const stats = await tool.execute({ entity: "stats" }, ctx);
    expect(stats.ok).toBe(true);
    expect(stats.summary).toContain('"students":18');
  });

  it("filters photos by student id", async () => {
    const all = await tool.execute({ entity: "photos" }, ctx);
    const one = await tool.execute({ entity: "photos", student_id: 1 }, ctx);
    expect((one.data as unknown[]).length).toBeLessThan((all.data as unknown[]).length);
    expect((one.data as { student_id: number }[]).every((p) => p.student_id === 1)).toBe(true);
  });

  it("rejects unknown entities", async () => {
    const result = await tool.execute({ entity: "orders" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("未知查询实体");
  });

  it("queries student behavior records with polarity and keyword filters", async () => {
    // 预置表现记录
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "智能助手表现查询测试：数学课主动发言",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        polarity: "praise",
        keyword: "主动发言",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("数学课主动发言");
    const data = res.data as { comment: string }[];
    expect(data.some((d) => d.comment.includes("主动发言"))).toBe(true);
  });

  it("filters behavior records by dimension_name and polarity", async () => {
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 1,
      dimension_id: 1,
      dimension_name_snap: "作业情况",
      category_snap: "study",
      type: "improve",
      comment: "未按时交作业",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 1,
        dimension_name: "作业情况",
        polarity: "improve",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    const data = res.data as { comment: string; dimension_name_snap: string; type: string }[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data.every((d) => d.dimension_name_snap === "作业情况" && d.type === "improve")).toBe(true);
  });

  it("queries and filters behavior records with neutral polarity", async () => {
    const { addBehaviorRecord } = await import("../src/lib/db");
    await addBehaviorRecord({
      student_id: 2,
      dimension_id: 2,
      dimension_name_snap: "日常纪律",
      category_snap: "behavior",
      type: "neutral",
      comment: "智能助手表现查询测试：常规午休考勤记录",
      recorded_date: "2026-09-05",
    });

    const res = await tool.execute(
      {
        entity: "behaviors",
        student_id: 2,
        polarity: "neutral",
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("日常表现查询：命中");
    expect(res.summary).toContain("➖");
    expect(res.summary).toContain("常规午休考勤记录");
    const data = res.data as { comment: string; type: string }[];
    expect(data.some((d) => d.type === "neutral" && d.comment.includes("常规午休考勤记录"))).toBe(true);
  });

  it("appends student id to summary line when student_id is omitted", async () => {
    const res = await tool.execute(
      {
        entity: "behaviors",
        limit: 5,
      },
      ctx
    );

    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/\(学生ID: \d+\)/);
  });
});

/** 课堂摘要行（query_data lessons 的返回单元，此处按测试需要的字段收窄声明） */
interface LessonRow {
  session_id: number;
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
  status: string;
  digest_source: string;
  picks: Array<{ student_id: number; student_name: string; count: number }>;
  praise_count: number;
  improve_count: number;
  groups: Array<{ group_no: number; score: number }>;
  absent: Array<{ student_id: number; student_name: string }>;
}

describe("query_data lessons entity（课堂会话 × 事件摘要）", () => {
  // 演示种子里的班级/学生：1 林知远、2 苏晚、3 陈嘉树（三年级二班 / 四年级一班）
  const CLASS = "三年级二班";

  afterAll(async () => {
    const { clearAll } = await import("../src/lib/db");
    await clearAll();
  });

  it("aggregates a live lesson's picks, behaviors, group points and absences", async () => {
    const { appendLessonEvent, openLessonSession } = await import("../src/lib/db");
    const date = "2026-09-17";
    const { session } = await openLessonSession({
      class_name: CLASS,
      subject: "数学",
      lesson_date: date,
      period: 3,
      activities: [{ type: "picker" }, { type: "seating" }, { type: "group-race" }],
    });

    for (const studentId of [1, 1, 2]) {
      await appendLessonEvent({ session_id: session.id, activity: "picker", kind: "pick", student_id: studentId });
    }
    await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "behavior",
      student_id: 1,
      payload: { dimension_id: 1, type: "praise", via: "seating" },
    });
    await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "behavior",
      student_id: 2,
      payload: { dimension_id: 3, type: "improve", via: "seating" },
    });
    for (const [groupNo, delta] of [
      [1, 2],
      [1, 3],
      [2, 1],
    ]) {
      await appendLessonEvent({
        session_id: session.id,
        activity: "group-race",
        kind: "group_point",
        payload: { group_no: groupNo, delta },
      });
    }
    await appendLessonEvent({
      session_id: session.id,
      activity: "seating",
      kind: "attendance",
      student_id: 3,
      payload: { absent: true },
    });
    // 未知 kind（未来活动）必须安全跳过，不影响其余聚合
    await appendLessonEvent({
      session_id: session.id,
      activity: "countdown",
      kind: "countdown_run",
      payload: { run: 1 },
    });

    // 口语班级名「三年二班」应命中「三年级二班」的会话
    const res = await tool.execute({ entity: "lessons", class_name: "三年二班", date }, ctx);

    expect(res.ok).toBe(true);
    expect(res.summary).toContain("课堂查询：命中 1 场");
    const rows = res.data as LessonRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: session.id,
      class_name: CLASS,
      subject: "数学",
      period: 3,
      status: "live",
      digest_source: "events",
    });
    expect(rows[0].picks).toEqual([
      { student_id: 1, student_name: "林知远", count: 2 },
      { student_id: 2, student_name: "苏晚", count: 1 },
    ]);
    expect(rows[0].praise_count).toBe(1);
    expect(rows[0].improve_count).toBe(1);
    expect(rows[0].groups).toEqual([
      { group_no: 1, score: 5 },
      { group_no: 2, score: 1 },
    ]);
    expect(rows[0].absent).toEqual([{ student_id: 3, student_name: "陈嘉树" }]);
    expect(res.summary).toContain("林知远×2");
    expect(res.summary).toContain("第1组 5 分");
  });

  it("prefers the stats snapshot of an ended session over the event stream", async () => {
    const { appendLessonEvent, endLessonSession, openLessonSession } = await import("../src/lib/db");
    const date = "2026-09-18";
    const { session } = await openLessonSession({
      class_name: CLASS,
      subject: "语文",
      lesson_date: date,
      period: 4,
      activities: [{ type: "picker" }],
    });
    await appendLessonEvent({ session_id: session.id, activity: "picker", kind: "pick", student_id: 2 });
    await endLessonSession(session.id, {
      stats: {
        picks: [{ student_id: 4, student_name: "周砚", count: 9 }],
        pick_coverage: 0.5,
        praise_count: 7,
        improve_count: 2,
        absent: [{ student_id: 5, student_name: "何听雨" }],
        groups: [{ group_no: 1, score: 42 }],
        silent: [],
        duration_min: 40,
      },
      digest_md: "数据版小结",
      digest_source: "data",
    });

    const res = await tool.execute({ entity: "lessons", class_name: CLASS, date }, ctx);

    expect(res.ok).toBe(true);
    const row = (res.data as LessonRow[])[0];
    expect(row).toMatchObject({ session_id: session.id, status: "ended", digest_source: "stats" });
    expect(row.picks).toEqual([{ student_id: 4, student_name: "周砚", count: 9 }]);
    expect(row.praise_count).toBe(7);
    expect(row.improve_count).toBe(2);
    expect(row.groups).toEqual([{ group_no: 1, score: 42 }]);
    expect(row.absent).toEqual([{ student_id: 5, student_name: "何听雨" }]);
    expect(res.summary).toContain("摘要来源：下课快照");
  });

  it("lists sessions across a date window and returns empty rows for an unknown class", async () => {
    const window = await tool.execute({ entity: "lessons", start: "2026-09-17", end: "2026-09-18" }, ctx);
    expect(window.ok).toBe(true);
    expect((window.data as LessonRow[]).length).toBe(2);

    const empty = await tool.execute({ entity: "lessons", class_name: "六年级八班", date: "2026-09-17" }, ctx);
    expect(empty.ok).toBe(true);
    expect(empty.data).toEqual([]);
    expect(empty.summary).toContain("命中 0 场");
    expect(empty.summary).toContain("没有符合条件的课堂记录");
  });

  it("keeps the unknown-entity error message listing lessons", async () => {
    const res = await tool.execute({ entity: "orders" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("未知查询实体");
    expect(res.error).toContain("lessons");
  });
});
