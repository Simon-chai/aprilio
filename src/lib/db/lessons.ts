/**
 * 课堂模式域（拆分自 db.ts）：会话 × 事件流 × 座位 × 活动组合（四表 + 槽位幂等）。
 */
import { getDb, isTauri } from "./core";
import { mem, now } from "./memory-store";
import { localDateStr } from "../format";
import type {
  ActivitySetEntry,
  ClassroomActivitySet,
  LessonEvent,
  LessonEventInput,
  LessonSession,
  LessonStats,
  Seating,
} from "../../classroom/types";

/* ------------------------------------------------------------------ */
/* 课堂模式：会话 × 事件流 × 座位 × 活动组合                              */
/* 设计依据 docs/superpowers/specs/2026-09-17-classroom-activity-framework-design.md */
/* 事件流是唯一事实源：活动状态 = reduce(事件流)；档案型数据同事务双写透传。 */
/* ------------------------------------------------------------------ */

/** 开课入参：唯一槽位（班+日期+节次）已存在时复用，period = null 为临时课堂 */
export interface OpenLessonSessionInput {
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
  activities: ActivitySetEntry[];
}

/** 会话列表过滤（start/end 为 lesson_date 闭区间） */
export interface LessonSessionFilter {
  class_name?: string;
  lesson_date?: string;
  start?: string;
  end?: string;
  limit?: number;
}

/** 座位写入入参：一人一座 + 按格覆盖，两者都幂等 */
export interface UpsertSeatingInput {
  class_name: string;
  semester: string;
  row_no: number;
  col_no: number;
  group_no: number;
  student_id: number;
}

/** 活动组合存盘入参：有 id 按 id 更新，否则按 (name, subject) 命中更新 */
export interface SaveActivitySetInput {
  id?: number;
  name: string;
  subject: string;
  activities: ActivitySetEntry[];
  sort_order?: number;
}

/** SQLite 行：activity_set_json / stats_json 以 JSON 字符串落库，取出时解析 */
type LessonSessionRaw = Omit<LessonSession, "status" | "activities" | "stats" | "digest_source"> & {
  status: string;
  activity_set_json: string | null;
  stats_json: string | null;
  digest_source: string | null;
};

/** SQLite 行：payload 以 JSON 字符串落库 */
type LessonEventRaw = Omit<LessonEvent, "payload"> & { payload: string | null };

/** SQLite 行：activities_json 以 JSON 字符串落库 */
type ClassroomActivitySetRaw = Omit<ClassroomActivitySet, "activities"> & {
  activities_json: string | null;
};

/** 容错 JSON 解析：坏数据一律回 null（TEXT 列历史脏数据的统一兜底） */
function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 容错对象解析（lesson_events.payload）：坏 JSON / 非对象 → {} */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  const parsed = parseJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** 活动组合解析：坏 JSON / 非数组 → []；条目缺 type 的丢弃 */
function parseActivities(raw: unknown): ActivitySetEntry[] {
  const parsed = Array.isArray(raw) ? raw : parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const entries: ActivitySetEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { type, config } = item as { type?: unknown; config?: unknown };
    if (typeof type !== "string" || !type) continue;
    entries.push(
      config && typeof config === "object" && !Array.isArray(config)
        ? { type, config: config as Record<string, unknown> }
        : { type }
    );
  }
  return entries;
}

/** 统计快照解析：坏 JSON / 非对象 → null（未下课与损坏同等对待） */
function parseLessonStats(raw: unknown): LessonStats | null {
  const parsed = parseJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as LessonStats)
    : null;
}

function toLessonSession(raw: LessonSessionRaw): LessonSession {
  return {
    id: raw.id,
    class_name: raw.class_name,
    subject: raw.subject,
    lesson_date: raw.lesson_date,
    period: raw.period ?? null,
    started_at: raw.started_at,
    ended_at: raw.ended_at ?? null,
    status: raw.status === "ended" ? "ended" : "live",
    activities: parseActivities(raw.activity_set_json),
    stats: parseLessonStats(raw.stats_json),
    digest_md: raw.digest_md ?? null,
    digest_source:
      raw.digest_source === "ai" || raw.digest_source === "data" ? raw.digest_source : null,
    created_at: raw.created_at,
  };
}

function toLessonEvent(raw: LessonEventRaw): LessonEvent {
  const { payload, ...rest } = raw;
  return { ...rest, payload: parseJsonObject(payload) };
}

function toClassroomActivitySet(raw: ClassroomActivitySetRaw): ClassroomActivitySet {
  const { activities_json, ...rest } = raw;
  return { ...rest, activities: parseActivities(activities_json) };
}

function cloneActivityEntries(entries: ActivitySetEntry[]): ActivitySetEntry[] {
  return entries.map((e) => (e.config ? { type: e.type, config: { ...e.config } } : { type: e.type }));
}

function cloneLessonSession(s: LessonSession): LessonSession {
  return { ...s, activities: cloneActivityEntries(s.activities), stats: s.stats ? { ...s.stats } : null };
}

function cloneLessonEvent(e: LessonEvent): LessonEvent {
  return { ...e, payload: { ...e.payload } };
}

function cloneActivitySet(s: ClassroomActivitySet): ClassroomActivitySet {
  return { ...s, activities: cloneActivityEntries(s.activities) };
}

function assertLessonClassName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("班级名不能为空");
  return trimmed;
}

function assertSemester(semester: string): string {
  if (!/^\d{4}-\d{4}-[12]$/.test(semester)) throw new Error("学期号格式应为 YYYY-YYYY-1/2");
  return semester;
}

function assertLessonDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式应为 YYYY-MM-DD");
}

function assertPeriod(period: number | null): void {
  if (period === null) return;
  if (!Number.isInteger(period) || period < 1) throw new Error("节次应为 1 及以上的整数或 null");
}

function assertActivities(activities: ActivitySetEntry[]): void {
  if (!Array.isArray(activities)) throw new Error("活动组合必须是数组");
}

/** 按唯一槽位取会话（不筛状态）；period = null 时匹配临时课堂 */
async function findSessionBySlot(
  className: string,
  lessonDate: string,
  period: number | null
): Promise<LessonSession | null> {
  if (!isTauri()) {
    const found = mem().lessonSessions.find(
      (s) => s.class_name === className && s.lesson_date === lessonDate && s.period === period
    );
    return found ? cloneLessonSession(found) : null;
  }
  const db = await getDb();
  const rows = await db.select<LessonSessionRaw[]>(
    `SELECT * FROM lesson_sessions
      WHERE class_name = ? AND lesson_date = ? AND (period = ? OR (? IS NULL AND period IS NULL))
      ORDER BY id ASC LIMIT 1`,
    [className, lessonDate, period, period]
  );
  return rows[0] ? toLessonSession(rows[0]) : null;
}

/** 单条课堂会话；不存在返回 null */
export async function getLessonSession(id: number): Promise<LessonSession | null> {
  if (!isTauri()) {
    const found = mem().lessonSessions.find((s) => s.id === id);
    return found ? cloneLessonSession(found) : null;
  }
  const db = await getDb();
  const rows = await db.select<LessonSessionRaw[]>(
    "SELECT * FROM lesson_sessions WHERE id = ? LIMIT 1",
    [id]
  );
  return rows[0] ? toLessonSession(rows[0]) : null;
}

/** 按唯一槽位查进行中的会话（开课幂等 / 防重复开课） */
export async function findLiveLessonSession(
  className: string,
  lessonDate: string,
  period: number | null
): Promise<LessonSession | null> {
  const session = await findSessionBySlot(className, lessonDate, period);
  return session && session.status === "live" ? session : null;
}

/** 全部进行中的会话（崩溃恢复横幅用，按 started_at 降序） */
export async function listLiveLessonSessions(): Promise<LessonSession[]> {
  if (!isTauri()) {
    return mem()
      .lessonSessions.filter((s) => s.status === "live")
      .slice()
      .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id)
      .map(cloneLessonSession);
  }
  const db = await getDb();
  const rows = await db.select<LessonSessionRaw[]>(
    "SELECT * FROM lesson_sessions WHERE status = 'live' ORDER BY started_at DESC, id DESC"
  );
  return rows.map(toLessonSession);
}

/**
 * 开课：唯一槽位（班 + 日期 + 节次）幂等——已存在则原样返回（重开 = 恢复，含已结束的）。
 * period = null 的临时课堂不查重（早读/自习同日可开多次）。
 */
export async function openLessonSession(
  input: OpenLessonSessionInput
): Promise<{ session: LessonSession; created: boolean }> {
  const className = assertLessonClassName(input.class_name);
  assertLessonDate(input.lesson_date);
  assertPeriod(input.period);
  assertActivities(input.activities);
  const subject = (input.subject ?? "").trim();

  if (input.period !== null) {
    const existing = await findSessionBySlot(className, input.lesson_date, input.period);
    if (existing) return { session: existing, created: false };
  }

  if (!isTauri()) {
    const store = mem();
    const ts = now();
    const session: LessonSession = {
      id: store.nextLessonSessionId++,
      class_name: className,
      subject,
      lesson_date: input.lesson_date,
      period: input.period,
      started_at: ts,
      ended_at: null,
      status: "live",
      activities: cloneActivityEntries(input.activities),
      stats: null,
      digest_md: null,
      digest_source: null,
      created_at: ts,
    };
    store.lessonSessions.push(session);
    return { session: cloneLessonSession(session), created: true };
  }

  const db = await getDb();
  const result = await db.execute(
    `INSERT INTO lesson_sessions
       (class_name, subject, lesson_date, period, started_at, status, activity_set_json, created_at)
     VALUES (?, ?, ?, ?, datetime('now','localtime'), 'live', ?, datetime('now','localtime'))`,
    [className, subject, input.lesson_date, input.period, JSON.stringify(input.activities)]
  );
  const rows = await db.select<LessonSessionRaw[]>("SELECT * FROM lesson_sessions WHERE id = ?", [
    Number(result.lastInsertId ?? 0),
  ]);
  return { session: toLessonSession(rows[0]), created: true };
}

/** 下课：状态迁移 + 统计/小结落库（事件流 append-only，事后修正走表现时间轴） */
export async function endLessonSession(
  id: number,
  input: { stats: LessonStats; digest_md: string; digest_source: "ai" | "data" }
): Promise<void> {
  if (!isTauri()) {
    const session = mem().lessonSessions.find((s) => s.id === id);
    if (!session) return;
    session.status = "ended";
    session.ended_at = now();
    session.stats = input.stats;
    session.digest_md = input.digest_md;
    session.digest_source = input.digest_source;
    return;
  }
  const db = await getDb();
  await db.execute(
    `UPDATE lesson_sessions
        SET status = 'ended', ended_at = datetime('now','localtime'),
            stats_json = ?, digest_md = ?, digest_source = ?
      WHERE id = ?`,
    [JSON.stringify(input.stats), input.digest_md, input.digest_source, id]
  );
}

/** 会话列表：按 lesson_date DESC, started_at DESC；limit 缺省不限制 */
export async function listLessonSessions(
  filter: LessonSessionFilter = {}
): Promise<LessonSession[]> {
  const className = filter.class_name;
  const lessonDate = filter.lesson_date;
  const start = filter.start;
  const end = filter.end;
  const limit = filter.limit === undefined ? -1 : filter.limit;

  if (!isTauri()) {
    return mem()
      .lessonSessions.filter(
        (s) =>
          (className === undefined || s.class_name === className) &&
          (lessonDate === undefined || s.lesson_date === lessonDate) &&
          (start === undefined || s.lesson_date >= start) &&
          (end === undefined || s.lesson_date <= end)
      )
      .slice()
      .sort(
        (a, b) =>
          b.lesson_date.localeCompare(a.lesson_date) ||
          b.started_at.localeCompare(a.started_at) ||
          b.id - a.id
      )
      .slice(0, limit < 0 ? undefined : limit)
      .map(cloneLessonSession);
  }
  const db = await getDb();
  const rows = await db.select<LessonSessionRaw[]>(
    `SELECT * FROM lesson_sessions
      WHERE (? IS NULL OR class_name = ?)
        AND (? IS NULL OR lesson_date = ?)
        AND (? IS NULL OR lesson_date >= ?)
        AND (? IS NULL OR lesson_date <= ?)
      ORDER BY lesson_date DESC, started_at DESC, id DESC
      LIMIT ?`,
    [
      className ?? null,
      className ?? null,
      lessonDate ?? null,
      lessonDate ?? null,
      start ?? null,
      start ?? null,
      end ?? null,
      end ?? null,
      limit,
    ]
  );
  return rows.map(toLessonSession);
}

/**
 * 追加一条课堂事件。
 * behavior 存在时走双写通道：同事务写 student_behavior_records（既有档案域，消费者零改动）
 * 并把新记录 id 回填进 settled_record_id。评语正文只存档案，事件不复制。
 * 结算与否由活动声明（settle）决定，db 层不校验。
 */
export async function appendLessonEvent(input: LessonEventInput): Promise<LessonEvent> {
  const sessionId = input.session_id;
  if (!sessionId) throw new Error("缺少课堂会话");
  const activity = (input.activity ?? "").trim();
  if (!activity) throw new Error("发出活动不能为空");
  const kind = (input.kind ?? "").trim();
  if (!kind) throw new Error("事件类型不能为空");
  const studentId = input.student_id ?? null;
  const behavior = input.behavior;
  if (behavior && !studentId) throw new Error("档案型事件必须指定学生");
  const occurredAt = input.occurred_at?.trim() || now();
  const payloadJson = JSON.stringify(input.payload ?? {});

  if (!isTauri()) {
    const store = mem();
    const ts = now();
    let settledRecordId: number | null = null;
    if (behavior) {
      const session = store.lessonSessions.find((s) => s.id === sessionId);
      const recordId = store.nextBehaviorRecordId++;
      store.behaviorRecords.push({
        id: recordId,
        student_id: studentId as number,
        dimension_id: behavior.dimension_id,
        dimension_name_snap: behavior.dimension_name_snap,
        category_snap: behavior.category_snap,
        type: behavior.type,
        comment: behavior.comment,
        recorded_date: session?.lesson_date ?? localDateStr(),
        created_at: ts,
      });
      settledRecordId = recordId;
    }
    const event: LessonEvent = {
      id: store.nextLessonEventId++,
      session_id: sessionId,
      student_id: studentId,
      activity,
      kind,
      payload: { ...(input.payload ?? {}) },
      settled_record_id: settledRecordId,
      occurred_at: occurredAt,
      created_at: ts,
      revoked_at: null,
    };
    store.lessonEvents.push(event);
    return cloneLessonEvent(event);
  }

  const db = await getDb();
  if (behavior) {
    // 单次 execute + 显式事务：两条 INSERT 原子落库；
    // settled_record_id 由同批次的 last_insert_rowid() 子查询回填。
    const sessionRows = await db.select<{ lesson_date: string }[]>(
      "SELECT lesson_date FROM lesson_sessions WHERE id = ? LIMIT 1",
      [sessionId]
    );
    const recordedDate = sessionRows[0]?.lesson_date ?? localDateStr();
    const result = await db.execute(
      `BEGIN IMMEDIATE;
       INSERT INTO student_behavior_records
         (student_id, dimension_id, dimension_name_snap, category_snap, type, comment, recorded_date)
       VALUES (?, ?, ?, ?, ?, ?, ?);
       INSERT INTO lesson_events
         (session_id, student_id, activity, kind, payload, settled_record_id, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?,
         (SELECT id FROM student_behavior_records WHERE rowid = last_insert_rowid()),
         ?, datetime('now','localtime'));
       COMMIT;`,
      [
        studentId,
        behavior.dimension_id,
        behavior.dimension_name_snap,
        behavior.category_snap,
        behavior.type,
        behavior.comment,
        recordedDate,
        sessionId,
        studentId,
        activity,
        kind,
        payloadJson,
        occurredAt,
      ]
    );
    const rows = await db.select<LessonEventRaw[]>("SELECT * FROM lesson_events WHERE id = ?", [
      Number(result.lastInsertId ?? 0),
    ]);
    return toLessonEvent(rows[0]);
  }

  const result = await db.execute(
    `INSERT INTO lesson_events
       (session_id, student_id, activity, kind, payload, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
    [sessionId, studentId, activity, kind, payloadJson, occurredAt]
  );
  const rows = await db.select<LessonEventRaw[]>("SELECT * FROM lesson_events WHERE id = ?", [
    Number(result.lastInsertId ?? 0),
  ]);
  return toLessonEvent(rows[0]);
}

/**
 * 撤销一条课堂事件（幂等）：置 revoked_at + 同事务删除双写档案记录。
 * 已撤销 / 不存在都不报错；settled_record_id 为 NULL 时删除命中 0 行。
 */
export async function revokeLessonEvent(eventId: number): Promise<void> {
  if (!isTauri()) {
    const store = mem();
    const event = store.lessonEvents.find((e) => e.id === eventId);
    if (!event) return;
    event.revoked_at = now();
    if (event.settled_record_id !== null) {
      const recordId = event.settled_record_id;
      store.behaviorRecords = store.behaviorRecords.filter((r) => r.id !== recordId);
    }
    return;
  }
  const db = await getDb();
  await db.execute(
    `BEGIN IMMEDIATE;
     UPDATE lesson_events SET revoked_at = datetime('now','localtime')
       WHERE id = ? AND revoked_at IS NULL;
     DELETE FROM student_behavior_records
       WHERE id = (SELECT settled_record_id FROM lesson_events WHERE id = ?);
     COMMIT;`,
    [eventId, eventId]
  );
}

/** 某会话的事件流（按 id 升序）；默认只返回未撤销的（重放与聚合一律跳过撤销项） */
export async function listLessonEvents(
  sessionId: number,
  opts: { includeRevoked?: boolean } = {}
): Promise<LessonEvent[]> {
  if (!isTauri()) {
    return mem()
      .lessonEvents.filter(
        (e) => e.session_id === sessionId && (opts.includeRevoked || e.revoked_at === null)
      )
      .slice()
      .sort((a, b) => a.id - b.id)
      .map(cloneLessonEvent);
  }
  const db = await getDb();
  const rows = await db.select<LessonEventRaw[]>(
    `SELECT * FROM lesson_events WHERE session_id = ?
       ${opts.includeRevoked ? "" : "AND revoked_at IS NULL"}
     ORDER BY id ASC`,
    [sessionId]
  );
  return rows.map(toLessonEvent);
}

/**
 * 跨会话沉默读模型：每人最后一次未撤销 pick 的时间（MAX(occurred_at) ≤ beforeIso）。
 * 走 idx_lesson_events_student_pick 部分索引；从未被点的人不出现在 Map 里。
 */
export async function lastPickedAtByStudent(
  studentIds: number[],
  beforeIso: string
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const ids = [...new Set(studentIds.filter((id) => Number.isFinite(id)))];
  if (!ids.length) return map;

  if (!isTauri()) {
    const wanted = new Set(ids);
    for (const ev of mem().lessonEvents) {
      if (ev.kind !== "pick" || ev.revoked_at !== null) continue;
      if (ev.student_id === null || !wanted.has(ev.student_id)) continue;
      if (ev.occurred_at > beforeIso) continue;
      const prev = map.get(ev.student_id);
      if (!prev || ev.occurred_at > prev) map.set(ev.student_id, ev.occurred_at);
    }
    return map;
  }

  const db = await getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db.select<{ student_id: number; last_at: string }[]>(
    `SELECT student_id, MAX(occurred_at) AS last_at FROM lesson_events
      WHERE kind = 'pick' AND revoked_at IS NULL
        AND occurred_at <= ? AND student_id IN (${placeholders})
      GROUP BY student_id`,
    [beforeIso, ...ids]
  );
  for (const row of rows) map.set(row.student_id, row.last_at);
  return map;
}

/** 某班某学期的座位表（按 row_no, col_no 升序）；无记录时由上层按学号回退推导 */
export async function listSeating(className: string, semester: string): Promise<Seating[]> {
  if (!isTauri()) {
    return mem()
      .seatings.filter((s) => s.class_name === className && s.semester === semester)
      .slice()
      .sort((a, b) => a.row_no - b.row_no || a.col_no - b.col_no)
      .map((s) => ({ ...s }));
  }
  const db = await getDb();
  return db.select<Seating[]>(
    `SELECT * FROM seatings WHERE class_name = ? AND semester = ?
      ORDER BY row_no ASC, col_no ASC`,
    [className, semester]
  );
}

/**
 * 写入一格座位（幂等命令）：先清掉该生在同班同学期的旧座（一人一座），
 * 再按 (class_name, semester, row_no, col_no) 覆盖该格（原占位者让位）。
 */
export async function upsertSeating(input: UpsertSeatingInput): Promise<Seating> {
  const className = assertLessonClassName(input.class_name);
  const semester = assertSemester(input.semester);
  if (!Number.isInteger(input.row_no) || input.row_no < 1) {
    throw new Error("行号应为 1 及以上的整数");
  }
  if (!Number.isInteger(input.col_no) || input.col_no < 1) {
    throw new Error("列号应为 1 及以上的整数");
  }
  if (!Number.isInteger(input.group_no) || input.group_no < 0) {
    throw new Error("组号应为 0 及以上的整数");
  }
  if (!input.student_id) throw new Error("缺少学生");

  if (!isTauri()) {
    const store = mem();
    store.seatings = store.seatings.filter(
      (s) =>
        !(s.class_name === className && s.semester === semester && s.student_id === input.student_id)
    );
    const existing = store.seatings.find(
      (s) =>
        s.class_name === className &&
        s.semester === semester &&
        s.row_no === input.row_no &&
        s.col_no === input.col_no
    );
    if (existing) {
      existing.student_id = input.student_id;
      existing.group_no = input.group_no;
      return { ...existing };
    }
    const seat: Seating = {
      id: store.nextSeatingId++,
      class_name: className,
      semester,
      row_no: input.row_no,
      col_no: input.col_no,
      group_no: input.group_no,
      student_id: input.student_id,
      created_at: now(),
    };
    store.seatings.push(seat);
    return { ...seat };
  }

  const db = await getDb();
  await db.execute(
    `BEGIN IMMEDIATE;
     DELETE FROM seatings WHERE class_name = ? AND semester = ? AND student_id = ?;
     INSERT INTO seatings (class_name, semester, row_no, col_no, group_no, student_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(class_name, semester, row_no, col_no) DO UPDATE SET
         student_id = excluded.student_id,
         group_no   = excluded.group_no;
     COMMIT;`,
    [
      className,
      semester,
      input.student_id,
      className,
      semester,
      input.row_no,
      input.col_no,
      input.group_no,
      input.student_id,
    ]
  );
  const rows = await db.select<Seating[]>(
    `SELECT * FROM seatings WHERE class_name = ? AND semester = ? AND row_no = ? AND col_no = ? LIMIT 1`,
    [className, semester, input.row_no, input.col_no]
  );
  return rows[0];
}

/** 撤销某生的座位（幂等） */
export async function removeSeatingStudent(
  className: string,
  semester: string,
  studentId: number
): Promise<void> {
  if (!isTauri()) {
    mem().seatings = mem().seatings.filter(
      (s) => !(s.class_name === className && s.semester === semester && s.student_id === studentId)
    );
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM seatings WHERE class_name = ? AND semester = ? AND student_id = ?", [
    className,
    semester,
    studentId,
  ]);
}

/** 清空某班某学期的座位表（幂等） */
export async function clearSeating(className: string, semester: string): Promise<void> {
  if (!isTauri()) {
    mem().seatings = mem().seatings.filter(
      (s) => !(s.class_name === className && s.semester === semester)
    );
    return;
  }
  const db = await getDb();
  await db.execute("DELETE FROM seatings WHERE class_name = ? AND semester = ?", [
    className,
    semester,
  ]);
}

/** 活动组合配置列表（按 sort_order, id 升序）；P0 仅在教师自定义时才有数据 */
export async function listClassroomActivitySets(): Promise<ClassroomActivitySet[]> {
  if (!isTauri()) {
    return mem()
      .activitySets.slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map(cloneActivitySet);
  }
  const db = await getDb();
  const rows = await db.select<ClassroomActivitySetRaw[]>(
    "SELECT * FROM classroom_activity_sets ORDER BY sort_order ASC, id ASC"
  );
  return rows.map(toClassroomActivitySet);
}

/** 存活动组合：有 id 按 id 更新；否则按 (name, subject) 命中则更新，否则插入 */
export async function saveClassroomActivitySet(
  input: SaveActivitySetInput
): Promise<ClassroomActivitySet> {
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("活动组合名称不能为空");
  assertActivities(input.activities);
  const subject = (input.subject ?? "").trim();
  const sortOrder = input.sort_order ?? 0;
  const activitiesJson = JSON.stringify(input.activities);

  if (!isTauri()) {
    const store = mem();
    const existing =
      input.id !== undefined
        ? store.activitySets.find((s) => s.id === input.id)
        : store.activitySets.find((s) => s.name === name && s.subject === subject);
    if (input.id !== undefined && !existing) throw new Error("活动组合不存在");
    if (existing) {
      existing.name = name;
      existing.subject = subject;
      existing.activities = cloneActivityEntries(input.activities);
      existing.sort_order = sortOrder;
      return cloneActivitySet(existing);
    }
    const set: ClassroomActivitySet = {
      id: store.nextActivitySetId++,
      name,
      subject,
      activities: cloneActivityEntries(input.activities),
      sort_order: sortOrder,
      created_at: now(),
    };
    store.activitySets.push(set);
    return cloneActivitySet(set);
  }

  const db = await getDb();
  if (input.id !== undefined) {
    await db.execute(
      `UPDATE classroom_activity_sets
          SET name = ?, subject = ?, activities_json = ?, sort_order = ?
        WHERE id = ?`,
      [name, subject, activitiesJson, sortOrder, input.id]
    );
    const rows = await db.select<ClassroomActivitySetRaw[]>(
      "SELECT * FROM classroom_activity_sets WHERE id = ? LIMIT 1",
      [input.id]
    );
    if (!rows[0]) throw new Error("活动组合不存在");
    return toClassroomActivitySet(rows[0]);
  }

  const hit = await db.select<ClassroomActivitySetRaw[]>(
    "SELECT * FROM classroom_activity_sets WHERE name = ? AND subject = ? ORDER BY id ASC LIMIT 1",
    [name, subject]
  );
  if (hit[0]) {
    await db.execute(
      "UPDATE classroom_activity_sets SET activities_json = ?, sort_order = ? WHERE id = ?",
      [activitiesJson, sortOrder, hit[0].id]
    );
    const rows = await db.select<ClassroomActivitySetRaw[]>(
      "SELECT * FROM classroom_activity_sets WHERE id = ? LIMIT 1",
      [hit[0].id]
    );
    return toClassroomActivitySet(rows[0]);
  }

  const result = await db.execute(
    `INSERT INTO classroom_activity_sets (name, subject, activities_json, sort_order, created_at)
     VALUES (?, ?, ?, ?, datetime('now','localtime'))`,
    [name, subject, activitiesJson, sortOrder]
  );
  const rows = await db.select<ClassroomActivitySetRaw[]>(
    "SELECT * FROM classroom_activity_sets WHERE id = ? LIMIT 1",
    [Number(result.lastInsertId ?? 0)]
  );
  return toClassroomActivitySet(rows[0]);
}
