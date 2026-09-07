import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import timetableTool from "../src/agent/tools/timetable";
import { profile } from "../src/lib/profile";

/** 冻结到 2026-09-07 周一 10:00：内存演示数据（含今日日程）与「今天」分支全部确定 */
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 7, 10, 0));
});
afterAll(() => {
  vi.useRealTimers();
});

/** jsdom 无 Tauri 外壳 → db.ts 自动走内存示例数据（三年级二班/三年级一班演示课表） */
const tool = timetableTool;
const ctx = {
  router: createRouter({ history: createMemoryHistory(), routes: [] }),
};

/** 临时设定任教学科（工具读 profile.value；ensureProfile 有缓存，直接改共享 ref 最可靠） */
async function withSubjects<T>(subjects: string[], fn: () => Promise<T>): Promise<T> {
  const original = { ...profile.value };
  profile.value = { ...original, my_subjects: subjects };
  try {
    return await fn();
  } finally {
    profile.value = original;
  }
}

describe("query_timetable tool", () => {
  it("queries a class full timetable", async () => {
    const result = await tool.execute({ mode: "class", class_name: "三年级二班" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("三年级二班");
    expect(result.summary).toContain("共 21 节");
    expect(result.summary).toContain("周一：第1节 数学，第2节 语文");
  });

  it("reports a class without a timetable and rejects missing class_name", async () => {
    const missing = await tool.execute({ mode: "class", class_name: "不存在的班" }, ctx);
    expect(missing.ok).toBe(true);
    expect(missing.summary).toContain("还没有课表");

    const noName = await tool.execute({ mode: "class" }, ctx);
    expect(noName.ok).toBe(false);
    expect(noName.error).toContain("class_name");
  });

  it("guides to register subjects when my_subjects is empty", async () => {
    await withSubjects([], async () => {
      const result = await tool.execute({ mode: "mine" }, ctx);
      expect(result.ok).toBe(true);
      expect(result.summary).toContain("任教学科");
    });
  });

  it("answers today (default) with exceptions applied and today's events", async () => {
    await withSubjects(["语文"], async () => {
      const today = await tool.execute({ mode: "mine" }, ctx); // 缺省 = 今天（冻结的周一）
      expect(today.ok).toBe(true);
      expect(today.summary).toContain("周一共有 2 节你的课");
      expect(today.summary).toContain("已考虑当天调课");
      // 演示数据：今天（localDate(0)）有两条教师个人日程
      expect(today.summary).toContain("今日日程");
      expect(today.summary).toContain("教研组会议");
      // 周一第 2 节两个班都有语文 → 撞课提示
      expect(today.summary).toContain("注意撞课");
    });
  });

  it("uses the weekly baseline for explicit other weekdays", async () => {
    await withSubjects(["语文"], async () => {
      const monday = await tool.execute({ mode: "mine", weekday: 1 }, ctx);
      expect(monday.summary).toContain("第2节 语文 · 三年级二班");
      expect(monday.summary).toContain("第2节 语文 · 三年级一班");

      const friday = await tool.execute({ mode: "mine", weekday: 5 }, ctx); // 非今天 → 周课表基准
      expect(friday.summary).toContain("第3节 语文 · 三年级一班");
      expect(friday.summary).toContain("按周课表推算");
    });
  });

  it("answers empty days and weekend with weekly arrangement", async () => {
    await withSubjects(["音乐"], async () => {
      const none = await tool.execute({ mode: "mine", weekday: 2 }, ctx);
      expect(none.ok).toBe(true);
      expect(none.summary).toContain("周二没有你的课");

      // 显式问周末（6=周六）→ 整周安排分支，结果确定
      const weekend = await tool.execute({ mode: "mine", weekday: 6 }, ctx);
      expect(weekend.ok).toBe(true);
      expect(weekend.summary).toContain("周末");
    });
  });
});
