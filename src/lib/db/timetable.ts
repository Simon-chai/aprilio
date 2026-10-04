/**
 * 课程表域（拆分自 db.ts）：班级课表（天 × 节格子 upsert）+ 调课例外。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { normalizeMySubjects, parseMySubjectsJson, parsePeriodsJson } from "../timetable";
import { assertCalendarDate } from "./shared";
import type {
  Timetable,
  TimetableException,
  TimetablePeriod,
  TimetableSlot,
  TimetableSlotWithClass,
  TimetableExceptionWithClass,
} from "../../types";

/* ------------------------------------------------------------------ */
/* 课程表：一班一学期一张，格子（天 × 节）幂等 upsert                      */
/* ------------------------------------------------------------------ */

/** SQLite 行：periods / my_subjects 以 JSON 字符串落库，取出时解析 */
type TimetableRaw = Omit<Timetable, "periods" | "my_subjects"> & {
  periods_json: string | null;
  my_subjects: string | null;
};

function toTimetable(raw: TimetableRaw): Timetable {
  const { periods_json, my_subjects, ...rest } = raw;
  return {
    ...rest,
    periods: parsePeriodsJson(periods_json),
    my_subjects: parseMySubjectsJson(my_subjects),
  };
}

function assertSlotPosition(dayOfWeek: number, period: number): void {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 5) {
    throw new Error("课表只支持周一到周五（1~5）");
  }
  if (!Number.isInteger(period) || period < 1 || period > 12) {
    throw new Error("节次应为 1~12 的整数");
  }
}

function sortSlots<T extends Pick<TimetableSlot, "day_of_week" | "period">>(slots: T[]): T[] {
  return slots.sort((a, b) => a.day_of_week - b.day_of_week || a.period - b.period);
}

/** 班级某学期的课表（含全部格子）；没有课表返回 null */
export async function getTimetableWithSlots(
  className: string,
  semester: string
): Promise<(Timetable & { slots: TimetableSlot[] }) | null> {
  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.class_name === className && x.semester === semester);
    if (!t) return null;
    return {
      ...t,
      periods: t.periods ? t.periods.map((p) => ({ ...p })) : null,
      slots: sortSlots(store.timetableSlots.filter((s) => s.timetable_id === t.id).map((s) => ({ ...s }))),
    };
  }
  const db = await getDb();
  const heads = await db.select<TimetableRaw[]>(
    "SELECT * FROM timetables WHERE class_name = ? AND semester = ? LIMIT 1",
    [className, semester]
  );
  if (!heads[0]) return null;
  const slots = await db.select<TimetableSlot[]>(
    "SELECT * FROM timetable_slots WHERE timetable_id = ?",
    [heads[0].id]
  );
  return { ...toTimetable(heads[0]), slots: sortSlots(slots) };
}

/** 查或建班级某学期的课表（幂等）：重复导入/重复打开复用同一张 */
export async function findOrCreateTimetable(
  className: string,
  semester: string
): Promise<{ timetable: Timetable; created: boolean }> {
  const name = className.trim();
  if (!name) throw new Error("班级名不能为空");
  if (!/^\d{4}-\d{4}-[12]$/.test(semester)) throw new Error("学期号格式应为 YYYY-YYYY-1/2");

  const existing = await getTimetableWithSlots(name, semester);
  if (existing) {
    const { slots: _slots, ...timetable } = existing;
    return { timetable, created: false };
  }

  if (!isTauri()) {
    const store = mem();
    const timetable: Timetable = {
      id: store.nextTimetableId++,
      class_name: name,
      semester,
      note: null,
      periods: null,
      my_subjects: null,
      created_at: now(),
      updated_at: now(),
    };
    store.timetables.push(timetable);
    return { timetable: { ...timetable }, created: true };
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO timetables (class_name, semester) VALUES (?, ?)",
    [name, semester]
  );
  const rows = await db.select<TimetableRaw[]>("SELECT * FROM timetables WHERE id = ?", [
    Number(result.lastInsertId ?? 0),
  ]);
  return { timetable: toTimetable(rows[0]), created: true };
}

/**
 * 写一格课：subject 传空串 = 清空该格（删行）。
 * (timetable_id, day_of_week, period) 唯一，编辑天然幂等。
 */
export async function saveTimetableSlot(
  timetableId: number,
  dayOfWeek: number,
  period: number,
  subject: string,
  note: string | null = null
): Promise<void> {
  assertSlotPosition(dayOfWeek, period);
  const subj = subject.trim();
  const trimmedNote = note?.trim() ? note.trim() : null;

  if (!isTauri()) {
    const store = mem();
    const existing = store.timetableSlots.find(
      (s) => s.timetable_id === timetableId && s.day_of_week === dayOfWeek && s.period === period
    );
    if (!subj) {
      if (existing) {
        store.timetableSlots = store.timetableSlots.filter((s) => s !== existing);
      }
      return;
    }
    if (existing) {
      existing.subject = subj;
      existing.note = trimmedNote;
      existing.updated_at = now();
      return;
    }
    store.timetableSlots.push({
      id: store.nextTimetableSlotId++,
      timetable_id: timetableId,
      day_of_week: dayOfWeek,
      period,
      subject: subj,
      note: trimmedNote,
      updated_at: now(),
    });
    return;
  }

  const db = await getDb();
  if (!subj) {
    await db.execute(
      "DELETE FROM timetable_slots WHERE timetable_id = ? AND day_of_week = ? AND period = ?",
      [timetableId, dayOfWeek, period]
    );
    return;
  }
  await db.execute(
    `INSERT INTO timetable_slots (timetable_id, day_of_week, period, subject, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(timetable_id, day_of_week, period) DO UPDATE SET
       subject    = excluded.subject,
       note       = excluded.note,
       updated_at = datetime('now','localtime')`,
    [timetableId, dayOfWeek, period, subj, trimmedNote]
  );
}

/** 更新课表节次配置（节数 / 上下午 / 上下课时间），空数组视为恢复默认 */
export async function saveTimetablePeriods(
  timetableId: number,
  periods: TimetablePeriod[]
): Promise<void> {
  if (!Array.isArray(periods)) throw new Error("节次配置应为数组");
  const seen = new Set<number>();
  for (const p of periods) {
    if (!Number.isInteger(p.period) || p.period < 1 || p.period > 12) {
      throw new Error("节次应为 1~12 的整数");
    }
    if (seen.has(p.period)) throw new Error("节次序号不能重复");
    seen.add(p.period);
  }
  const json = periods.length ? JSON.stringify(periods) : null;

  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.id === timetableId);
    if (!t) throw new Error("课表不存在");
    t.periods = json ? (JSON.parse(json) as TimetablePeriod[]) : null;
    t.updated_at = now();
    return;
  }

  const db = await getDb();
  await db.execute(
    "UPDATE timetables SET periods_json = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [json, timetableId]
  );
}

/**
 * 写班级「我的科目」标记：subjects 传 null = 清除标记（该班回退按全局任教学科匹配）；
 * 传数组（含空数组）= 明确标记，空数组即「本班没有我的课」。trim / 去空 / 去重后落库。
 */
export async function saveTimetableMySubjects(
  timetableId: number,
  subjects: string[] | null
): Promise<void> {
  const normalized = subjects === null ? null : normalizeMySubjects(subjects);
  const json = normalized === null ? null : JSON.stringify(normalized);

  if (!isTauri()) {
    const store = mem();
    const t = store.timetables.find((x) => x.id === timetableId);
    if (!t) throw new Error("课表不存在");
    t.my_subjects = normalized;
    t.updated_at = now();
    return;
  }

  const db = await getDb();
  await db.execute(
    "UPDATE timetables SET my_subjects = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [json, timetableId]
  );
}

/** 我的课表素材：某学期全部班级的课表格子（联班级名、节次配置与我的科目标记） */
export async function listTimetableSlotsWithClass(semester: string): Promise<TimetableSlotWithClass[]> {
  if (!isTauri()) {
    const store = mem();
    const byId = new Map(store.timetables.map((t) => [t.id, t]));
    return sortSlots(
      store.timetableSlots
        .flatMap((s) => {
          const t = byId.get(s.timetable_id);
          if (!t || t.semester !== semester) return [];
          return [
            {
              ...s,
              class_name: t.class_name,
              periods: t.periods,
              my_subjects: t.my_subjects,
            },
          ];
        })
    );
  }
  const db = await getDb();
  const rows = await db.select<
    (TimetableSlot & { class_name: string; periods_json: string | null; my_subjects: string | null })[]
  >(
    `SELECT s.*, t.class_name, t.periods_json, t.my_subjects
       FROM timetable_slots s
       INNER JOIN timetables t ON s.timetable_id = t.id
      WHERE t.semester = ?`,
    [semester]
  );
  return sortSlots(
    rows.map(({ periods_json, my_subjects, ...s }) => ({
      ...s,
      periods: parsePeriodsJson(periods_json),
      my_subjects: parseMySubjectsJson(my_subjects),
    }))
  );
}

/** 学期内各班节次配置与「我的科目」标记（含没排过课的班）；「我的课表」行数与导入撞课预览的数据来源 */
export async function listTimetablePeriodsByClass(
  semester: string
): Promise<{ class_name: string; periods: TimetablePeriod[] | null; my_subjects: string[] | null }[]> {
  if (!isTauri()) {
    return mem()
      .timetables.filter((t) => t.semester === semester)
      .map((t) => ({ class_name: t.class_name, periods: t.periods, my_subjects: t.my_subjects }))
      .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
  }
  const db = await getDb();
  const rows = await db.select<{
    class_name: string;
    periods_json: string | null;
    my_subjects: string | null;
  }[]>("SELECT class_name, periods_json, my_subjects FROM timetables WHERE semester = ?", [
    semester,
  ]);
  return rows
    .map(({ class_name, periods_json, my_subjects }) => ({
      class_name,
      periods: parsePeriodsJson(periods_json),
      my_subjects: parseMySubjectsJson(my_subjects),
    }))
    .sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
}

/** 清空某张课表的全部格子（导入「清空后导入」选项用）；返回删除格数 */
export async function clearTimetableSlots(timetableId: number): Promise<number> {
  if (!isTauri()) {
    const store = mem();
    const before = store.timetableSlots.length;
    store.timetableSlots = store.timetableSlots.filter((s) => s.timetable_id !== timetableId);
    return before - store.timetableSlots.length;
  }
  const db = await getDb();
  const result = await db.execute("DELETE FROM timetable_slots WHERE timetable_id = ?", [
    timetableId,
  ]);
  return result.rowsAffected;
}

/** 库内出现过的全部科目（去重），「任教学科」候选与导入识别共用 */
export async function listTimetableSubjects(): Promise<string[]> {
  if (!isTauri()) {
    const seen: string[] = [];
    for (const s of mem().timetableSlots) {
      const subj = s.subject.trim();
      if (subj && !seen.includes(subj)) seen.push(subj);
    }
    return seen.sort((a, b) => a.localeCompare(b, "zh"));
  }
  const db = await getDb();
  const rows = await db.select<{ subject: string }[]>(
    "SELECT DISTINCT subject FROM timetable_slots WHERE TRIM(subject) != ''"
  );
  return rows.map((r) => r.subject.trim()).sort((a, b) => a.localeCompare(b, "zh"));
}

/* ------------------------------------------------------------------ */
/* 调课例外：某班「某天某节」覆盖周课表（换课 / 停课 / 加课）                */
/* ------------------------------------------------------------------ */


/** 保存一条调课例外：subject 传空串 = 停课；(timetable_id, date, period) 唯一，编辑天然幂等 */
export async function saveTimetableException(
  timetableId: number,
  exceptionDate: string,
  period: number,
  subject: string,
  note: string | null = null
): Promise<void> {
  assertCalendarDate(exceptionDate);
  if (!Number.isInteger(period) || period < 1 || period > 12) {
    throw new Error("节次应为 1~12 的整数");
  }
  const subj = subject.trim();
  const trimmedNote = note?.trim() ? note.trim() : null;

  if (!isTauri()) {
    const store = mem();
    const existing = store.timetableExceptions.find(
      (e) =>
        e.timetable_id === timetableId &&
        e.exception_date === exceptionDate &&
        e.period === period
    );
    if (existing) {
      existing.subject = subj;
      existing.note = trimmedNote;
      existing.updated_at = now();
      return;
    }
    store.timetableExceptions.push({
      id: store.nextTimetableExceptionId++,
      timetable_id: timetableId,
      exception_date: exceptionDate,
      period,
      subject: subj,
      note: trimmedNote,
      created_at: now(),
      updated_at: now(),
    });
    return;
  }

  const db = await getDb();
  await db.execute(
    `INSERT INTO timetable_exceptions (timetable_id, exception_date, period, subject, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(timetable_id, exception_date, period) DO UPDATE SET
       subject    = excluded.subject,
       note       = excluded.note,
       updated_at = datetime('now','localtime')`,
    [timetableId, exceptionDate, period, subj, trimmedNote]
  );
}

/** 删除一条调课例外 = 该天该节恢复周课表默认 */
export async function clearTimetableException(
  timetableId: number,
  exceptionDate: string,
  period: number
): Promise<void> {
  assertCalendarDate(exceptionDate);
  if (!isTauri()) {
    const store = mem();
    store.timetableExceptions = store.timetableExceptions.filter(
      (e) =>
        !(
          e.timetable_id === timetableId &&
          e.exception_date === exceptionDate &&
          e.period === period
        )
    );
    return;
  }
  const db = await getDb();
  await db.execute(
    "DELETE FROM timetable_exceptions WHERE timetable_id = ? AND exception_date = ? AND period = ?",
    [timetableId, exceptionDate, period]
  );
}

/** 某班课表在 [startDate, endDate] 内的调课例外（班级万年历按月查询用） */
export async function listTimetableExceptionsInRange(
  timetableId: number,
  startDate: string,
  endDate: string
): Promise<TimetableException[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .timetableExceptions.filter(
        (e) =>
          e.timetable_id === timetableId &&
          e.exception_date >= startDate &&
          e.exception_date <= endDate
      )
      .sort((a, b) => a.exception_date.localeCompare(b.exception_date) || a.period - b.period)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<TimetableException[]>(
    `SELECT * FROM timetable_exceptions
      WHERE timetable_id = ? AND exception_date >= ? AND exception_date <= ?
      ORDER BY exception_date ASC, period ASC`,
    [timetableId, startDate, endDate]
  );
}

/** 某学期全部班级在日期区间内的调课例外（联班级名，我的课表 / 首页 / Agent 用） */
export async function listTimetableExceptionsWithClass(
  semester: string,
  startDate: string,
  endDate: string
): Promise<TimetableExceptionWithClass[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    const store = mem();
    const byId = new Map(store.timetables.map((t) => [t.id, t]));
    return store.timetableExceptions
      .flatMap((e) => {
        const t = byId.get(e.timetable_id);
        if (!t || t.semester !== semester) return [];
        return [{ ...e, class_name: t.class_name }];
      })
      .filter((e) => e.exception_date >= startDate && e.exception_date <= endDate)
      .sort((a, b) => a.exception_date.localeCompare(b.exception_date) || a.period - b.period);
  }
  const db = await getDb();
  return db.select<TimetableExceptionWithClass[]>(
    `SELECT e.*, t.class_name
       FROM timetable_exceptions e
       INNER JOIN timetables t ON e.timetable_id = t.id
      WHERE t.semester = ? AND e.exception_date >= ? AND e.exception_date <= ?
      ORDER BY e.exception_date ASC, e.period ASC`,
    [semester, startDate, endDate]
  );
}

