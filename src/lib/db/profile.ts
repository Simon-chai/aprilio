/**
 * 个人资料域（拆分自 db.ts）：单条记录（id 恒为 1）+ 全量清空。
 */
import { getDb, isTauri } from "./core";
import { resetMemoryStore } from "./memory-store";
import { parseTags } from "./shared";
import { DEFAULT_PROFILE } from "../../types";
import type { Profile } from "../../types";

/* ------------------------------------------------------------------ */
/* 个人资料（单条记录，id 恒为 1）                                       */
/* ------------------------------------------------------------------ */

let memProfile: Profile = { ...DEFAULT_PROFILE };

export async function getProfile(): Promise<Profile> {
  if (!isTauri()) return { ...memProfile };

  const db = await getDb();
  const rows = await db.select<(Profile & { my_subjects: unknown })[]>(
    "SELECT name, title, motto, avatar, hero, my_subjects, timetable_bg FROM profile WHERE id = 1"
  );
  return {
    ...DEFAULT_PROFILE,
    ...(rows[0] ?? {}),
    my_subjects: parseTags(rows[0]?.my_subjects),
    timetable_bg: rows[0]?.timetable_bg ?? "",
  };
}

export async function saveProfile(p: Profile): Promise<void> {
  if (!isTauri()) {
    memProfile = { ...p };
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO profile (id, name, title, motto, avatar, hero, my_subjects, timetable_bg, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET
          name          = excluded.name,
          title         = excluded.title,
          motto         = excluded.motto,
          avatar        = excluded.avatar,
          hero          = excluded.hero,
          my_subjects   = excluded.my_subjects,
          timetable_bg  = excluded.timetable_bg,
          updated_at    = excluded.updated_at`,
    [p.name, p.title, p.motto, p.avatar, p.hero, JSON.stringify(p.my_subjects ?? []), p.timetable_bg]
  );
}

/** 清空所有数据（设置页用，回收站一并清空） */
export async function clearAll(): Promise<void> {
  if (!isTauri()) {
    const memory = resetMemoryStore();
    memory.students = [];
    memory.photos = [];
    memory.classes = [];
    memory.classMeta = {};
    memory.termComments = [];
    memory.guardians = [];
    memory.behaviorRecords = [];
    memory.exams = [];
    memory.examScores = [];
    memory.timetables = [];
    memory.timetableSlots = [];
    memory.timetableExceptions = [];
    memory.calendarEvents = [];
    memory.recycleBin = [];
    memory.lessonSessions = [];
    memory.lessonEvents = [];
    memory.seatings = [];
    memory.activitySets = [];
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM guardians");
  await db.execute("DELETE FROM photos");
  await db.execute("DELETE FROM students");
  await db.execute("DELETE FROM student_behavior_records");
  await db.execute("DELETE FROM student_term_comments");
  await db.execute("DELETE FROM exam_scores");
  await db.execute("DELETE FROM exams");
  await db.execute("DELETE FROM timetable_slots");
  await db.execute("DELETE FROM timetable_exceptions");
  await db.execute("DELETE FROM timetables");
  await db.execute("DELETE FROM calendar_events");
  await db.execute("DELETE FROM classes");
  await db.execute("DELETE FROM recycle_bin");
  await db.execute("DELETE FROM lesson_events");
  await db.execute("DELETE FROM lesson_sessions");
  await db.execute("DELETE FROM seatings");
  await db.execute("DELETE FROM classroom_activity_sets");
}

