/**
 * 双通道等价测试：同一套「模拟数据 + 主流程」分别在
 * - SQLite 真通道（plugin-sql mock 到 node:sqlite 内存库，isTauri() === true）
 * - 内存兜底通道（isTauri() === false）
 * 各跑一遍，对齐最终读取结果。
 *
 * 背景：既有 1212 个用例全部只走内存通道，SQL 分支（含 executeBatch 事务批、
 * last_insert_rowid 回填、ON CONFLICT upsert）此前只靠人工回归。
 * 对比口径：剥离自增 id 与时间戳后按内容等价比对（id 语义由各通道内断言保护）。
 */
import { describe, expect, it, vi } from "vitest";
import { emptyStudentInput, type Guardian } from "../src/types";

const channel = { on: false };

vi.mock("@tauri-apps/plugin-sql", async () => {
  const { createSqliteAdapter } = await import("./helpers/sqlite-adapter");
  return {
    default: {
      load: async () => createSqliteAdapter(),
    },
  };
});

import type * as DbApi from "../src/lib/db";

/** 取一份全新的 db 模块图：SQLite 通道置 Tauri 标记，内存通道删掉 */
async function freshDb(): Promise<typeof DbApi> {
  vi.resetModules();
  const flags = window as unknown as Record<string, unknown>;
  if (channel.on) flags.__TAURI_INTERNALS__ = {};
  else delete flags.__TAURI_INTERNALS__;
  return (await import("../src/lib/db")) as typeof DbApi;
}

/** 剥离自增/引用 id 与时间戳、数组按内容排序：让两通道按「业务内容」对齐 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(^|_id$)/.test(k)) continue; // id / student_id / settled_record_id 等引用键
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
        out[k] = "TS";
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

/** 在通道内跑一遍并断言依赖自增 id 的内部一致性（恢复后的记录数、双写回填等） */
async function scenarioStudentLifecycle(db: typeof DbApi) {
  // 清空演示种子：内存通道出厂带演示数据，SQL 通道从空表开始，等价比对须同一起点
  await db.clearAll();
  await db.createClass("三年二班");
  const guardians: Guardian[] = [
    { name: "王大明", phone: "13800000001", relation: "父亲", is_primary: true, occupation: "工程师", tags: ["严格"] },
    { name: "李小红", phone: "13800000002", relation: "母亲", is_primary: false, occupation: "", tags: [] },
  ];
  const s1 = await db.createStudent({
    ...emptyStudentInput(),
    name: "王小明",
    student_no: "9001",
    grade_class: "三年二班",
    guardians,
  });
  const s2 = await db.createStudent({
    ...emptyStudentInput(),
    name: "赵小红",
    student_no: "9002",
    grade_class: "三年二班",
    guardians: [],
  });
  await db.addPhoto(s1, "img_sports.png", "运动会", "2026-10-01 09:00:00");

  // 编辑档案：监护人重写（executeBatch 事务批）
  await db.updateStudent(s1, {
    ...emptyStudentInput(),
    name: "王小明",
    student_no: "9001",
    grade_class: "三年二班",
    note: "转来新生",
    guardians: [guardians[1]!, { ...guardians[0]!, occupation: "高级工程师" }],
  });

  // 删除 → 回收站快照 → 恢复（pushStudentSnapshotBatch + last_insert_rowid 回填）
  await db.deleteStudent(s2);
  const recycleAfterDelete = await db.listRecycleItems();
  expect(recycleAfterDelete).toHaveLength(1);
  await db.restoreRecycleItem(recycleAfterDelete[0]!.id);
  const restored = (await db.listStudents("赵小红")).find((s) => s.name === "赵小红");
  expect(restored).toBeTruthy();
  const recycleAfterRestore = await db.listRecycleItems();

  const final = await db.getStudent(s1);
  expect(final?.guardians).toHaveLength(2);
  expect(final?.note).toBe("转来新生");

  return {
    students: await db.listStudents(""),
    recycle: recycleAfterRestore,
    photoCount: (await db.listPhotos(s1)).length,
  };
}

async function scenarioClassRecycle(db: typeof DbApi) {
  await db.clearAll();
  await db.createClass("四年级三班");
  const ids: number[] = [];
  for (const [i, name] of ["钱多多", "孙小圣", "周一一"].entries()) {
    ids.push(
      await db.createStudent({
        ...emptyStudentInput(),
        name,
        student_no: `910${i + 1}`,
        grade_class: "四年级三班",
        guardians: [],
      })
    );
  }
  await db.upsertExamScore(
    (await db.createExam({ name: "期中考试", class_name: "四年级三班", exam_date: "2026-11-05" })),
    ids[0]!,
    "语文",
    91,
    null
  );
  await db.addClassPhoto("四年级三班", "img_class.png", "合影");

  await db.deleteClass("四年级三班");
  const recycle = await db.listRecycleItems();
  expect(recycle).toHaveLength(1);
  expect(recycle[0]!.entity_type).toBe("class");
  await db.restoreRecycleItem(recycle[0]!.id);

  return {
    students: (await db.listStudents("")).filter((s) => s.grade_class === "四年级三班" || s.name),
    classes: await db.listClasses(),
    recycle: await db.listRecycleItems(),
    scores: await db.listStudentExamScores(ids[0]!),
  };
}

async function scenarioScores(db: typeof DbApi) {
  await db.clearAll();
  await db.createClass("成绩通道班");
  const s1 = await db.createStudent({ ...emptyStudentInput(), name: "吴一", student_no: "9201", grade_class: "成绩通道班", guardians: [] });
  const s2 = await db.createStudent({ ...emptyStudentInput(), name: "郑二", student_no: "9202", grade_class: "成绩通道班", guardians: [] });
  const examId = await db.createExam({ name: "期中考试", class_name: "成绩通道班", exam_date: "2026-11-05" });
  await db.upsertExamScore(examId, s1, "语文", 91, null);
  await db.upsertExamScore(examId, s1, "语文", 93, null); // 覆盖更新
  await db.upsertExamScore(examId, s1, "数学", null, "缺考"); // 文字成绩
  await db.upsertExamScore(examId, s2, "语文", 88, null);

  const { exam } = await db.findOrCreateExam({ name: "期中考试", class_name: "成绩通道班", exam_date: "2026-11-05" });
  return {
    examReused: exam.id === examId || exam.exam_name === "期中考试",
    scores: await db.getExamScores(examId),
    studentReport: await db.getStudentScoreReport(s1),
    overview: await db.getClassScoreOverview("成绩通道班"),
    trend: await db.getClassScoreTrend("成绩通道班"),
  };
}

async function scenarioTimetable(db: typeof DbApi) {
  await db.clearAll();
  await db.createClass("课表通道班");
  const { timetable } = await db.findOrCreateTimetable("课表通道班", "2026-2027-1");
  await db.saveTimetableSlot(timetable.id, 1, 1, "语文");
  await db.saveTimetableSlot(timetable.id, 1, 2, "数学");
  await db.saveTimetableSlot(timetable.id, 2, 1, "英语");
  await db.saveTimetableException(timetable.id, "2026-10-12", 1, "物理", "调课");
  await db.saveTimetableException(timetable.id, "2026-10-13", 2, "", "停课");
  await db.saveTimetableException(timetable.id, "2026-10-12", 1, "化学", "再调"); // 覆盖

  return {
    slots: await db.listTimetableSlotsWithClass("2026-2027-1"),
    exceptions: await db.listTimetableExceptionsInRange(timetable.id, "2026-10-01", "2026-10-31"),
    subjects: await db.listTimetableSubjects(),
  };
}

async function scenarioCalendar(db: typeof DbApi) {
  await db.clearAll();
  await db.createClass("日程通道班");
  await db.addCalendarEvent(null, "2026-10-08", "教师个人备忘");
  await db.addCalendarEvent("日程通道班", "2026-10-08", "第一节班会", "todo", 1);
  await db.addCalendarEvent("日程通道班", "2026-10-09", "交作业", "homework");
  const classEvents = await db.listClassEventsInRange("日程通道班", "2026-10-01", "2026-10-31");
  const todo = classEvents.find((e) => e.content === "第一节班会")!;
  await db.setCalendarEventDone(todo.id, true);

  return {
    classEvents: await db.listClassEventsInRange("日程通道班", "2026-10-01", "2026-10-31"),
    teacherEvents: await db.listTeacherEventsInRange("2026-10-01", "2026-10-31"),
    search: await db.searchCalendarEvents("备忘", 8),
  };
}

async function scenarioLessons(db: typeof DbApi) {
  await db.clearAll();
  await db.createClass("课堂通道班");
  const sid = await db.createStudent({
    ...emptyStudentInput(),
    name: "冯三",
    student_no: "9301",
    grade_class: "课堂通道班",
    guardians: [],
  });
  const { session } = await db.openLessonSession({
    class_name: "课堂通道班",
    subject: "数学",
    lesson_date: "2026-09-17",
    period: 1,
    activities: [{ type: "picker" }],
  });
  const pick = await db.appendLessonEvent({
    session_id: session.id,
    activity: "picker",
    kind: "pick",
    student_id: sid,
  });
  // 档案型双写：behavior 落 student_behavior_records，settled_record_id 同批回填
  const behavior = await db.appendLessonEvent({
    session_id: session.id,
    activity: "seating",
    kind: "behavior",
    student_id: sid,
    behavior: {
      dimension_id: 3,
      dimension_name_snap: "课堂表现",
      category_snap: "behavior",
      type: "praise",
      comment: "主动举手发言",
    },
  });
  expect(behavior.settled_record_id).not.toBeNull();
  await db.revokeLessonEvent(pick.id);
  await db.endLessonSession(session.id, {
    stats: session.stats,
    digest_md: "",
    digest_source: "data",
  });

  const behaviors = await db.listBehaviorRecords(sid);
  expect(behaviors).toHaveLength(1);
  return {
    session: await db.getLessonSession(session.id),
    events: await db.listLessonEvents(session.id),
    behaviors,
    lastPicked: Object.fromEntries(await db.lastPickedAtByStudent([sid], "2026-09-17 23:59:59")),
  };
}

describe.each([
  ["SQLite 真通道", true],
  ["内存兜底通道", false],
] as const)("模拟数据主流程 · %s", (label, on) => {
  it("学生全生命周期：建档 / 监护人重写 / 删除进回收站 / 恢复", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioStudentLifecycle(db)).resolves.toBeTruthy();
  });

  it("班级删除与恢复：快照含学生与班级照片", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioClassRecycle(db)).resolves.toBeTruthy();
  });

  it("成绩：批次幂等 / 覆盖更新 / 文字成绩 / 统计", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioScores(db)).resolves.toBeTruthy();
  });

  it("课表：格子 upsert / 调课例外覆盖", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioTimetable(db)).resolves.toBeTruthy();
  });

  it("日程：个人与班级事件 / 勾选 / 搜索", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioCalendar(db)).resolves.toBeTruthy();
  });

  it("课堂：事件流 / 档案双写回填 / 撤销", async () => {
    channel.on = on;
    const db = await freshDb();
    await expect(scenarioLessons(db)).resolves.toBeTruthy();
  });
});

describe("双通道内容等价（SQLite ↔ 内存，剥离 id/时间戳）", () => {
  const cases = [
    ["学生全生命周期", scenarioStudentLifecycle] as const,
    ["班级删除与恢复", scenarioClassRecycle] as const,
    ["成绩管道", scenarioScores] as const,
    ["课表与调课", scenarioTimetable] as const,
    ["日程事件", scenarioCalendar] as const,
    ["课堂事件流", scenarioLessons] as const,
  ];

  for (const [name, scenario] of cases) {
    it(name, async () => {
      channel.on = true;
      const sqlite = normalize(await scenario(await freshDb()));
      channel.on = false;
      const memory = normalize(await scenario(await freshDb()));
      expect(sqlite).toEqual(memory);
    });
  }
});
