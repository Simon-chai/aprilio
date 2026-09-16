import { describe, expect, it } from "vitest";
import {
  computeLessonStats,
  generateLessonDigest,
  renderDataDigest,
} from "../src/classroom/digest";
import { generateAiLessonDigest } from "../src/classroom/digest-ai";
import type { DigestInput } from "../src/classroom/digest";
import type { ClassroomStudent, LessonEvent, LessonSession } from "../src/classroom/types";
import type { AgentLlm } from "../src/agent/types";

/**
 * 课堂小结：stats 聚合（覆盖率/计数/小组分/缺勤/沉默预警/时长）、
 * 数据版模板关键字段、AI 不可用时回退 data（演示态 / 注入失败）。
 */

const SESSION: LessonSession = {
  id: 7,
  class_name: "三(2)班",
  subject: "数学",
  lesson_date: "2026-09-17",
  period: 3,
  started_at: "2026-09-17 08:00:00",
  ended_at: "2026-09-17 08:40:00",
  status: "ended",
  activities: [{ type: "digest" }],
  stats: null,
  digest_md: null,
  digest_source: null,
  created_at: "2026-09-17 08:00:00",
};

function student(id: number, name: string, groupNo: number): ClassroomStudent {
  return {
    id,
    name,
    student_no: `2024${id}`,
    gender: "男",
    row_no: 1,
    col_no: id,
    group_no: groupNo,
  };
}

const A = student(1, "林小满", 1);
const B = student(2, "陈子墨", 1);
const C = student(3, "王一诺", 2);
const D = student(4, "李思远", 2);
const ROSTER = [A, B, C, D];

let seq = 0;

function event(partial: Partial<LessonEvent> & Pick<LessonEvent, "kind">): LessonEvent {
  seq += 1;
  return {
    id: seq,
    session_id: SESSION.id,
    student_id: null,
    activity: "seating",
    payload: {},
    settled_record_id: null,
    occurred_at: "2026-09-17 08:10:00",
    created_at: "2026-09-17 08:10:00",
    revoked_at: null,
    ...partial,
  };
}

/** 一节课的典型事件流：2 人被点（1 人两次）、1 表扬 1 待改进、1 缺勤、2 组加分 */
function typicalEvents(): LessonEvent[] {
  return [
    event({ kind: "pick", student_id: 1, activity: "picker" }),
    event({ kind: "behavior", student_id: 1, payload: { dimension_id: 3, type: "praise", via: "seat" } }),
    event({ kind: "pick", student_id: 3, activity: "picker" }),
    event({ kind: "behavior", student_id: 3, payload: { dimension_id: 3, type: "improve", via: "seat" } }),
    event({ kind: "attendance", student_id: 2, payload: { absent: true } }),
    event({ kind: "pick", student_id: 1, activity: "picker" }),
    event({ kind: "group_point", activity: "group-race", payload: { group_no: 1, delta: 1, reason: "发言" } }),
    event({ kind: "group_point", activity: "group-race", payload: { group_no: 2, delta: 2, reason: "合作" } }),
  ];
}

function inputOf(events: LessonEvent[], days: Record<number, number | null> = {}): DigestInput {
  return {
    session: SESSION,
    roster: ROSTER,
    events,
    daysSincePicked: (id) => days[id] ?? null,
  };
}

describe("computeLessonStats 聚合", () => {
  it("点名：每人次数降序 + 覆盖率（分母 = 在班人数，缺勤不算）", () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    expect(stats.picks).toEqual([
      { student_id: 1, student_name: "林小满", count: 2 },
      { student_id: 3, student_name: "王一诺", count: 1 },
    ]);
    // 4 人在册、1 人缺勤 → 在班 3 人，被点 2 人
    expect(stats.pick_coverage).toBeCloseTo(2 / 3, 5);
  });

  it("表扬 / 待改进按 payload.type 计数", () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    expect(stats.praise_count).toBe(1);
    expect(stats.improve_count).toBe(1);
  });

  it("缺勤名单取 attendance 末态并解析姓名", () => {
    const events = [
      ...typicalEvents(),
      event({ kind: "attendance", student_id: 2, payload: { absent: false } }),
    ];
    expect(computeLessonStats(inputOf(typicalEvents())).absent).toEqual([
      { student_id: 2, student_name: "陈子墨" },
    ]);
    expect(computeLessonStats(inputOf(events)).absent).toEqual([]);
  });

  it("小组分：按组号升序聚合 delta，名单里有但没有事件的组显示 0", () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    expect(stats.groups).toEqual([
      { group_no: 1, score: 1 },
      { group_no: 2, score: 2 },
    ]);
  });

  it("沉默预警：本课既未被点也无表现记录，按距上次被点降序（从未被点排最前）", () => {
    // 未被点的是 3 与 4（2 缺勤不算、1 被点且有表现记录）
    const events = [
      event({ kind: "pick", student_id: 1, activity: "picker" }),
      event({ kind: "behavior", student_id: 1, payload: { dimension_id: 3, type: "praise", via: "seat" } }),
      event({ kind: "attendance", student_id: 2, payload: { absent: true } }),
    ];
    const stats = computeLessonStats({
      ...inputOf(events),
      daysSincePicked: (id) => (id === 3 ? 5 : null),
    });
    expect(stats.silent).toEqual([
      { student_id: 4, student_name: "李思远", days: null },
      { student_id: 3, student_name: "王一诺", days: 5 },
    ]);
  });

  it("已撤销事件不计入任何统计（幂等兜底）", () => {
    const events = typicalEvents();
    const lastPick = [...events].reverse().find((ev) => ev.kind === "pick" && ev.student_id === 1);
    const revoked = events.map((ev) =>
      ev.id === lastPick?.id ? { ...ev, revoked_at: "2026-09-17 08:50:00" } : ev,
    );
    const stats = computeLessonStats(inputOf(revoked));
    expect(stats.picks).toEqual([
      { student_id: 1, student_name: "林小满", count: 1 },
      { student_id: 3, student_name: "王一诺", count: 1 },
    ]);
  });

  it("时长：ended_at - started_at（分钟）", () => {
    expect(computeLessonStats(inputOf(typicalEvents())).duration_min).toBe(40);
    const live: LessonSession = { ...SESSION, ended_at: null };
    const stats = computeLessonStats({ ...inputOf(typicalEvents()), session: live });
    expect(stats.duration_min).toBeGreaterThanOrEqual(0);
  });

  it("空事件流：零统计不报错，沉默预警列全员", () => {
    const stats = computeLessonStats(inputOf([]));
    expect(stats.picks).toEqual([]);
    expect(stats.pick_coverage).toBe(0);
    expect(stats.praise_count).toBe(0);
    expect(stats.absent).toEqual([]);
    expect(stats.groups.map((g) => g.score)).toEqual([0, 0]);
    expect(stats.silent.map((s) => s.student_id)).toEqual([1, 2, 3, 4]);
  });
});

describe("renderDataDigest 数据版模板", () => {
  it("关键字段齐全：班级/科目/时长/覆盖率/计数/小组分/缺勤/沉默预警", () => {
    const stats = computeLessonStats(inputOf(typicalEvents(), { 4: 12 }));
    const md = renderDataDigest(stats, SESSION);

    expect(md).toContain("# 三(2)班 · 数学 课堂小结");
    expect(md).toContain("2026-09-17 第 3 节");
    expect(md).toContain("课长 40 分钟");
    expect(md).toContain("点名 3 人次，覆盖 2 人（覆盖率 67%）");
    expect(md).toContain("表扬 1 条 · 待改进 1 条");
    expect(md).toContain("第 1 组 1 分");
    expect(md).toContain("第 2 组 2 分（领先）");
    expect(md).toContain("陈子墨（共 1 人）");
    expect(md).toContain("李思远（12 天未被点到）");
  });

  it("临时课堂与空数据都有安全文案", () => {
    const stats = computeLessonStats({ ...inputOf([]), session: { ...SESSION, period: null } });
    const md = renderDataDigest(stats, { ...SESSION, period: null });
    expect(md).toContain("临时课堂");
    expect(md).toContain("本节课未点名");
    expect(md).toContain("本次课无缺勤记录");
  });
});

describe("generateLessonDigest：AI 不可用时回退数据版", () => {
  it("演示态（非 Tauri）永不走 AI，digest_source = data 且不抛错", async () => {
    const res = await generateLessonDigest(inputOf(typicalEvents(), { 4: 12 }));
    expect(res.digest_source).toBe("data");
    expect(res.digest_md).toContain("# 三(2)班 · 数学 课堂小结");
    expect(res.digest_md).toContain("数据版小结");
    expect(res.stats.praise_count).toBe(1);
  });
});

describe("generateAiLessonDigest 增强层（永不抛错）", () => {
  it("未就绪（演示态 / 未配置）返回 null", async () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    expect(await generateAiLessonDigest(inputOf(typicalEvents()), stats)).toBeNull();
    expect(await generateAiLessonDigest(inputOf(typicalEvents()), stats, { aiReady: false })).toBeNull();
  });

  it("模型可用时返回 AI markdown", async () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    const llm = {
      chat: async () => ({ content: "## 课堂回顾\n整体活跃。", toolCalls: [] }),
    } as unknown as AgentLlm;
    const md = await generateAiLessonDigest(inputOf(typicalEvents()), stats, { aiReady: true, llm });
    expect(md).toContain("## 课堂回顾");
  });

  it("模型调用失败 / 空返回 → null（由调用方回退数据版）", async () => {
    const stats = computeLessonStats(inputOf(typicalEvents()));
    const boom = {
      chat: async () => {
        throw new Error("网络错误");
      },
    } as unknown as AgentLlm;
    const empty = {
      chat: async () => ({ content: "   ", toolCalls: [] }),
    } as unknown as AgentLlm;
    expect(await generateAiLessonDigest(inputOf(typicalEvents()), stats, { aiReady: true, llm: boom })).toBeNull();
    expect(await generateAiLessonDigest(inputOf(typicalEvents()), stats, { aiReady: true, llm: empty })).toBeNull();
  });
});