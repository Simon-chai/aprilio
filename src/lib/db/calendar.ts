/**
 * 统一日程事件域（拆分自 db.ts）：备忘 / 待办 / 考试 / 作业；班级可空 = 教师个人事件。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { assertCalendarDate } from "./shared";
import type { CalendarEvent, CalendarEventType } from "../../types";

/* ------------------------------------------------------------------ */
/* 统一日程事件：备忘 / 待办 / 考试 / 作业；班级可空 = 教师个人事件          */
/* ------------------------------------------------------------------ */

const EVENT_TYPES: CalendarEventType[] = ["memo", "todo", "exam", "homework"];

/** 新增日程事件：className 传 null = 教师个人事件（只在教师维度展示）；period 传节次 = 落在课表具体格子，返回 id */
export async function addCalendarEvent(
  className: string | null,
  eventDate: string,
  content: string,
  type: CalendarEventType = "memo",
  period: number | null = null
): Promise<number> {
  const cls = className?.trim() || null;
  assertCalendarDate(eventDate);
  const text = content.trim();
  if (!text) throw new Error("日程内容不能为空");
  if (text.length > 200) throw new Error("日程内容请控制在 200 字以内");
  if (!EVENT_TYPES.includes(type)) throw new Error("日程类型不合法");
  if (period !== null && (!Number.isInteger(period) || period < 1 || period > 30)) {
    throw new Error("节次不合法");
  }

  if (!isTauri()) {
    const store = mem();
    const id = store.nextCalendarEventId++;
    store.calendarEvents.push({
      id,
      class_name: cls,
      event_date: eventDate,
      type,
      period,
      content: text,
      title: null,
      done: 0,
      created_at: now(),
      updated_at: now(),
    });
    return id;
  }

  const db = await getDb();
  const result = await db.execute(
    "INSERT INTO calendar_events (class_name, event_date, type, period, content) VALUES (?, ?, ?, ?, ?)",
    [cls, eventDate, type, period, text]
  );
  return Number(result.lastInsertId ?? 0);
}

/** 某班在 [startDate, endDate] 闭区间内的日程事件（班级日历用，按日期升序） */
export async function listClassEventsInRange(
  className: string,
  startDate: string,
  endDate: string
): Promise<CalendarEvent[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .calendarEvents.filter(
        (e) => e.class_name === className && e.event_date >= startDate && e.event_date <= endDate
      )
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<CalendarEvent[]>(
    `SELECT * FROM calendar_events
      WHERE class_name = ? AND event_date >= ? AND event_date <= ?
      ORDER BY event_date ASC, id ASC`,
    [className, startDate, endDate]
  );
}

/**
 * 教师维度在日期区间内的全部日程事件（首页 / 我的课表 / Agent 用）：
 * 含班级事件与个人事件（class_name 为 null）——班主任关心自己所有班的事。
 */
export async function listTeacherEventsInRange(
  startDate: string,
  endDate: string
): Promise<CalendarEvent[]> {
  assertCalendarDate(startDate);
  assertCalendarDate(endDate);
  if (!isTauri()) {
    return mem()
      .calendarEvents.filter((e) => e.event_date >= startDate && e.event_date <= endDate)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<CalendarEvent[]>(
    `SELECT * FROM calendar_events
      WHERE event_date >= ? AND event_date <= ?
      ORDER BY event_date ASC, id ASC`,
    [startDate, endDate]
  );
}

/**
 * 全局搜索（Ctrl+F）：按关键词在日程事件的 AI 标题与正文里模糊匹配，
 * 按日期倒序返回前 limit 条（标题命中与正文命中同等对待）。
 */
export async function searchCalendarEvents(keyword: string, limit = 8): Promise<CalendarEvent[]> {
  const kw = keyword.trim();
  if (!kw) return [];
  const max = limit > 0 ? Math.floor(limit) : 8;
  if (!isTauri()) {
    const k = kw.toLowerCase();
    return mem()
      .calendarEvents.filter((e) =>
        `${e.title ?? ""} ${e.content}`.toLowerCase().includes(k)
      )
      .sort((a, b) => b.event_date.localeCompare(a.event_date) || b.id - a.id)
      .slice(0, max)
      .map((e) => ({ ...e }));
  }
  const db = await getDb();
  return db.select<CalendarEvent[]>(
    `SELECT * FROM calendar_events
      WHERE title LIKE ? OR content LIKE ?
      ORDER BY event_date DESC, id DESC
      LIMIT ?`,
    [`%${kw}%`, `%${kw}%`, max]
  );
}

/** 切换日程事件完成状态 */
export async function setCalendarEventDone(id: number, done: boolean): Promise<void> {
  if (!isTauri()) {
    const event = mem().calendarEvents.find((e) => e.id === id);
    if (event) {
      event.done = done ? 1 : 0;
      event.updated_at = now();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE calendar_events SET done = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [done ? 1 : 0, id]
  );
}

/** 删除一条日程事件 */
export async function deleteCalendarEvent(id: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    store.calendarEvents = store.calendarEvents.filter((e) => e.id !== id);
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM calendar_events WHERE id = ?", [id]);
}

/**
 * 写入日程事件的 AI 快速浏览标题（memo-ai 生成成功后调用，一次生成永久复用）。
 * 仅在已配置 AI 模型时会被调用；title 保持 NULL = 界面退回显示全文前几个字。
 */
export async function setCalendarEventTitle(id: number, title: string): Promise<void> {
  const text = title.trim().slice(0, 30);
  if (!text) return;
  if (!isTauri()) {
    const event = mem().calendarEvents.find((e) => e.id === id);
    if (event) {
      event.title = text;
      event.updated_at = now();
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    "UPDATE calendar_events SET title = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [text, id]
  );
}

