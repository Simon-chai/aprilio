/**
 * 课程表纯函数：学期推导 / 节次配置 / 网格构建 / 我的课表聚合。
 *
 * 与 db.ts 分离，方便 vitest 直测；「我的课表」永远是从班级课表格子
 * （subject ∈ profile.my_subjects）推导的投影，不落库。
 * 设计说明见 docs/TIMETABLE.md。
 */
import type {
  CalendarEvent,
  TimetableExceptionWithClass,
  TimetablePeriod,
  TimetableSession,
  TimetableSlot,
  TimetableSlotWithClass,
} from "../types";

/** 网格固定周一~周五（不考虑周六补课，见 docs/TIMETABLE.md 决策 ④） */
export const WEEKDAY_COUNT = 5;

export const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五"];

/** 科目预设：与成绩导入的科目关键词同口径，可自由输入不限于候选 */
export const SUBJECT_PRESETS = [
  "语文",
  "数学",
  "英语",
  "道德与法治",
  "科学",
  "体育",
  "音乐",
  "美术",
  "信息科技",
  "劳动",
  "班会",
  "自习",
];

/* ------------------------------------------------------------------ */
/* 学期                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 学期号推导：9~12 月 → Y-(Y+1)-1（秋季）；1~2 月仍属上一年度秋季 → (Y-1)-Y-1；
 * 3~8 月 → (Y-1)-Y-2（春季）。无需任何设置项。
 */
export function currentSemester(date = new Date()): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  if (m >= 9) return `${y}-${y + 1}-1`;
  if (m <= 2) return `${y - 1}-${y}-1`;
  return `${y - 1}-${y}-2`;
}

/** 学期展示标签：2026-2027-1 → 「2026–2027 秋季学期」；非学期号原样返回 */
export function semesterLabel(semester: string): string {
  const match = /^(\d{4})-(\d{4})-([12])$/.exec(semester);
  if (!match) return semester;
  return `${match[1]}–${match[2]} ${match[3] === "1" ? "秋季" : "春季"}学期`;
}

/** 星期几（1=周一 … 5=周五）；周末返回 null */
export function weekdayOf(date = new Date()): number | null {
  const day = date.getDay();
  return day >= 1 && day <= 5 ? day : null;
}

/* ------------------------------------------------------------------ */
/* 节次配置                                                             */
/* ------------------------------------------------------------------ */

/** 默认小学 8 节：上午 4 节 08:00 起，下午 4 节 14:00 起（可改） */
export function defaultPeriods(): TimetablePeriod[] {
  return [
    { period: 1, session: "morning", start: "08:00", end: "08:40" },
    { period: 2, session: "morning", start: "08:50", end: "09:30" },
    { period: 3, session: "morning", start: "10:00", end: "10:40" },
    { period: 4, session: "morning", start: "10:50", end: "11:30" },
    { period: 5, session: "afternoon", start: "14:00", end: "14:40" },
    { period: 6, session: "afternoon", start: "14:50", end: "15:30" },
    { period: 7, session: "afternoon", start: "15:40", end: "16:20" },
    { period: 8, session: "afternoon", start: "16:30", end: "17:10" },
  ];
}

/**
 * 合并多班节次配置：按 period 升序去重，时间取首个非空值；全空回退默认节次。
 * 「我的课表」「首页面板」的网格行数来源——画满学校节次结构，不随有课节次缩水。
 */
export function periodsUnion(lists: (TimetablePeriod[] | null)[]): TimetablePeriod[] {
  const byPeriod = new Map<number, TimetablePeriod>();
  for (const list of lists) {
    for (const p of list ?? []) {
      const existing = byPeriod.get(p.period);
      if (!existing) {
        byPeriod.set(p.period, { ...p });
      } else {
        if (!existing.start && p.start) existing.start = p.start;
        if (!existing.end && p.end) existing.end = p.end;
      }
    }
  }
  const merged = [...byPeriod.values()].sort((a, b) => a.period - b.period);
  return merged.length ? merged : defaultPeriods();
}

/**
 * 课表行 my_subjects JSON 解析：NULL / 空串 / 脏数据 → null（未标记，回退全局任教学科）；
 * JSON 数组取非空字符串去重（空数组原样返回 = 明确标记「本班没有我的课」）。
 */
export function parseMySubjectsJson(raw: unknown): string[] | null {
  if (raw == null || raw === "") return null;
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return null;
  const seen: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

/** 课表行 periods_json 解析：脏数据 → null（退回默认节次） */
export function parsePeriodsJson(raw: unknown): TimetablePeriod[] | null {
  if (raw == null || raw === "") return null;
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return null;
  const periods: TimetablePeriod[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const p = item as Record<string, unknown>;
    const period = Number(p.period);
    if (!Number.isInteger(period) || period < 1) continue;
    const session: TimetableSession = p.session === "afternoon" ? "afternoon" : "morning";
    const start = typeof p.start === "string" ? p.start : "";
    const end = typeof p.end === "string" ? p.end : "";
    periods.push({ period, session, start, end });
  }
  return periods.length ? periods : null;
}

/** HH:mm → 当日分钟数；格式不合法返回 null */
function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  return h * 60 + m;
}

/**
 * 当前所处节次（1 起）：按本地时间命中 start~end 区间。
 * 未配置节次时间、不在任何区间内 → null（界面退化为不高亮）。
 */
export function currentPeriod(periods: TimetablePeriod[] | null, date = new Date()): number | null {
  if (!periods?.length) return null;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  for (const p of periods) {
    const start = minutesOf(p.start);
    const end = minutesOf(p.end);
    if (start === null || end === null) continue;
    if (nowMin >= start && nowMin < end) return p.period;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 班级网格                                                             */
/* ------------------------------------------------------------------ */

/**
 * (天, 节) → 格子 的网格：grid[periodIdx][dayIdx]（dayIdx 0=周一）。
 * 行序跟随 periods 配置；网格只含配置内的节次，配置外的格子数据不显示。
 */
export function buildGrid(
  slots: TimetableSlot[],
  periods: TimetablePeriod[]
): (TimetableSlot | null)[][] {
  const byKey = new Map<string, TimetableSlot>();
  for (const slot of slots) {
    byKey.set(`${slot.day_of_week}:${slot.period}`, slot);
  }
  return periods.map((p) =>
    Array.from({ length: WEEKDAY_COUNT }, (_, dayIdx) =>
      byKey.get(`${dayIdx + 1}:${p.period}`) ?? null
    )
  );
}

/* ------------------------------------------------------------------ */
/* 连堂合并（纯渲染层，数据模型不动）                                       */
/* ------------------------------------------------------------------ */

/** 一列（某天）的渲染块：content = 单课 / 同节多课（撞课原样数组）/ null（空格） */
export interface MergedColumnBlock<T> {
  content: T | T[] | null;
  /** 跨越的节次行数（≥1） */
  span: number;
  /** 被上方的跨行块覆盖，渲染时跳过 */
  covered: boolean;
}

/**
 * 把一列按节次顺序的格子合并成渲染块：连续格子都是「单课且键相同」→ 并成一个跨行块。
 * 同节多课（撞课）与空格不参与合并；合并键由调用方给（科目+备注 / 班级+科目+状态）。
 * 返回数组与输入一一对应，渲染时跳过 covered 项即可。
 */
export function mergeColumnBlocks<T>(
  cells: (T | T[] | null)[],
  keyOf: (item: T) => string
): MergedColumnBlock<T>[] {
  const result: MergedColumnBlock<T>[] = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i];
    if (cell === null || Array.isArray(cell)) {
      result.push({ content: cell, span: 1, covered: false });
      i += 1;
      continue;
    }
    let span = 1;
    while (
      i + span < cells.length &&
      cells[i + span] !== null &&
      !Array.isArray(cells[i + span]) &&
      keyOf(cells[i + span] as T) === keyOf(cell)
    ) {
      span += 1;
    }
    result.push({ content: cell, span, covered: false });
    for (let k = 1; k < span; k += 1) {
      result.push({ content: cells[i + k], span: 1, covered: true });
    }
    i += span;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 我的课表聚合（纯投影，不落库）                                          */
/* ------------------------------------------------------------------ */

/** 我的一节课：哪个班、周几、第几节（start/end 由该班节次配置解析，未配置为空串） */
export interface MyScheduleSession {
  class_name: string;
  day_of_week: number;
  period: number;
  note: string | null;
  start: string;
  end: string;
}

/** 按科目分块：组内会话按 周几 → 节次 排序 */
export interface MyScheduleSubjectBlock {
  subject: string;
  /** 该科每周课时数 */
  weekly_count: number;
  sessions: MyScheduleSession[];
}

/** 跨班撞课：任教学科在同一 (天, 节) 出现在多个班级 */
export interface MyScheduleConflict {
  day_of_week: number;
  period: number;
  entries: { subject: string; class_name: string }[];
}

export interface MySchedule {
  /** 按周课时数降序 */
  bySubject: MyScheduleSubjectBlock[];
  conflicts: MyScheduleConflict[];
  /** 每周总课时 */
  weekly_total: number;
}

/** 任教学科判定：trim 后精确相等（录入候选来自库内科目，天然对得上） */
export function isMySubject(subject: string, mySubjects: string[]): boolean {
  const s = subject.trim();
  return mySubjects.some((m) => m.trim() === s && s !== "");
}

/** 跨班撞课条目：同一 (天, 节) 上其他班级的「我的课」 */
export interface CrossClassConflict {
  class_name: string;
  subject: string;
}

/**
 * 某个 (天, 节) 上其他班级的「我的课」列表——跨班撞课检测（网格编辑 / 导入预览）共用口径，
 * 与 buildMySchedule 的 conflicts 一致：只统计 subject ∈ 该班生效「我的科目」（mineOf 三态）的格子。
 * excludeTimetableId 排除本班自身（网格编辑场景）；导入场景由调用方先按 class_name 过滤掉目标班。
 * 「待保存科目是否我的科目」的门不在本函数——由调用方判定（网格用本班 effectiveMine，导入用目标班标记）。
 */
export function crossClassConflictsAt(
  rows: TimetableSlotWithClass[],
  mineOf: MineOfClass,
  at: { day_of_week: number; period: number; excludeTimetableId?: number }
): CrossClassConflict[] {
  const hits: CrossClassConflict[] = [];
  for (const row of rows) {
    if (row.day_of_week !== at.day_of_week || row.period !== at.period) continue;
    if (at.excludeTimetableId !== undefined && row.timetable_id === at.excludeTimetableId) continue;
    if (!isMySubject(row.subject, mineOf(row.class_name))) continue;
    hits.push({ class_name: row.class_name, subject: row.subject.trim() });
  }
  return hits.sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
}

/* ---------------- 我的科目：班级 × 科目 标记 ---------------- */

/** 标记集合归一化：trim、去空、去重；顺序按中文 locale 稳定排序 */
export function normalizeMySubjects(subjects: string[]): string[] {
  const seen: string[] = [];
  for (const raw of subjects) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen.sort((a, b) => a.localeCompare(b, "zh"));
}

/**
 * 单班「我的科目」判定：标记过（含空数组）按标记，未标记（null）回退全局任教学科。
 * 与 db.saveTimetableMySubjects 的存值语义一一对应。
 */
export function resolveClassMySubjects(
  marked: string[] | null,
  profileMySubjects: string[]
): string[] {
  return marked === null ? profileMySubjects : marked;
}

/** 「我的科目」判定器：输入班级名返回该班生效的我的科目 */
export type MineOfClass = (className: string) => string[];

/**
 * 从联表格子行构造判定器：每班取一次 my_subjects 标记，
 * 标记过（含空数组）按标记，未标记回退全局任教学科。
 */
export function mineOfClassResolver(
  rows: Pick<TimetableSlotWithClass, "class_name" | "my_subjects">[],
  profileMySubjects: string[]
): MineOfClass {
  const markedByClass = new Map<string, string[] | null>();
  for (const row of rows) {
    if (!markedByClass.has(row.class_name)) {
      markedByClass.set(row.class_name, row.my_subjects);
    }
  }
  return (className: string) =>
    resolveClassMySubjects(markedByClass.get(className) ?? null, profileMySubjects);
}

/** 从全部班级课表格子聚合出「我的课表」（口径：每班按 mineOf 判定） */
export function buildMySchedule(rows: TimetableSlotWithClass[], mineOf: MineOfClass): MySchedule {
  const bySubject = new Map<string, MyScheduleSession[]>();
  const matched: (TimetableSlotWithClass & { subject: string })[] = [];

  for (const row of rows) {
    if (!isMySubject(row.subject, mineOf(row.class_name))) continue;
    const subject = row.subject.trim();
    matched.push({ ...row, subject });
    // 节次时间：该班自己的节次配置，未配置则退回默认节次
    const time = (row.periods ?? defaultPeriods()).find((p) => p.period === row.period);
    const sessions = bySubject.get(subject) ?? [];
    sessions.push({
      class_name: row.class_name,
      day_of_week: row.day_of_week,
      period: row.period,
      note: row.note,
      start: time?.start ?? "",
      end: time?.end ?? "",
    });
    bySubject.set(subject, sessions);
  }

  const blocks: MyScheduleSubjectBlock[] = [...bySubject.entries()].map(([subject, sessions]) => {
    sessions.sort((a, b) => a.day_of_week - b.day_of_week || a.period - b.period);
    return { subject, weekly_count: sessions.length, sessions };
  });
  blocks.sort((a, b) => b.weekly_count - a.weekly_count || a.subject.localeCompare(b.subject, "zh"));

  // 冲突：同一 (天, 节) 有 ≥2 条我的课（无论科目），班主任分身乏术
  const byKey = new Map<string, MyScheduleConflict["entries"]>();
  for (const m of matched) {
    const key = `${m.day_of_week}:${m.period}`;
    const entries = byKey.get(key) ?? [];
    entries.push({ subject: m.subject, class_name: m.class_name });
    byKey.set(key, entries);
  }
  const conflicts: MyScheduleConflict[] = [];
  for (const [key, entries] of byKey) {
    if (entries.length < 2) continue;
    const [day, period] = key.split(":").map(Number);
    conflicts.push({ day_of_week: day, period, entries });
  }
  conflicts.sort((a, b) => a.day_of_week - b.day_of_week || a.period - b.period);

  return { bySubject: blocks, conflicts, weekly_total: matched.length };
}

/** 我的课表中某天的全部会话（按节次升序），首页「今日课程」条用 */
export function mySessionsOnDay(
  schedule: MySchedule,
  day: number
): (MyScheduleSession & { subject: string })[] {
  const sessions: (MyScheduleSession & { subject: string })[] = [];
  for (const block of schedule.bySubject) {
    for (const session of block.sessions) {
      if (session.day_of_week === day) {
        sessions.push({ ...session, subject: block.subject });
      }
    }
  }
  return sessions.sort((a, b) => a.period - b.period);
}

/** 会话是否正在进行中（按其 start~end 判断）；未配置时间恒为 false */
export function sessionIsNow(
  session: Pick<MyScheduleSession, "start" | "end">,
  date = new Date()
): boolean {
  const start = minutesOf(session.start);
  const end = minutesOf(session.end);
  if (start === null || end === null) return false;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  return nowMin >= start && nowMin < end;
}

/**
 * 会话进行中的进度（0~1），用于进度条；未配置时间或不在进行中返回 null。
 * 进度按当前时刻在 start~end 区间内的位置线性推导。
 */
export function sessionProgress(
  session: Pick<MyScheduleSession, "start" | "end">,
  date = new Date()
): number | null {
  const start = minutesOf(session.start);
  const end = minutesOf(session.end);
  if (start === null || end === null || end <= start) return null;
  const nowMin = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  if (nowMin < start || nowMin >= end) return null;
  return (nowMin - start) / (end - start);
}

/* ------------------------------------------------------------------ */
/* 调课例外：某天某节对周课表的一次性覆盖                                  */
/* ------------------------------------------------------------------ */

/** 一节课在「某一天」的实际形态：normal=按周课表，changed=换课，added=加课，cancelled=停课 */
export type EffectiveSlotState = "normal" | "changed" | "added" | "cancelled";

export interface EffectiveSlot {
  period: number;
  subject: string;
  note: string | null;
  state: EffectiveSlotState;
}

/** 例外状态在界面上的徽标文案（normal 无徽标） */
export const EXCEPTION_STATE_LABELS: Record<EffectiveSlotState, string> = {
  normal: "",
  changed: "调",
  added: "加",
  cancelled: "停",
};

/**
 * 把某天的调课例外套到周课表上，得到当天逐节实际课程。
 * - 例外 subject 为空串 → 该节停课（保留原科目用于划线展示）
 * - 例外 subject 与周课相同 → 视为 normal（只可能更新备注）
 * - 加课 = 周课没有该节但例外有内容
 * exceptions 传入前需已按「该日期」过滤；weekend/空课日期自然得到空数组或仅例外节次。
 */
export function resolveDaySlots(
  baseSlots: Pick<TimetableSlot, "period" | "subject" | "note">[],
  dayExceptions: Pick<TimetableExceptionWithClass, "period" | "subject" | "note">[]
): EffectiveSlot[] {
  const baseByPeriod = new Map(baseSlots.map((s) => [s.period, s]));
  const excByPeriod = new Map(dayExceptions.map((e) => [e.period, e]));
  const periods = new Set<number>([...baseByPeriod.keys(), ...excByPeriod.keys()]);

  const result: EffectiveSlot[] = [];
  for (const period of periods) {
    const base = baseByPeriod.get(period);
    const exc = excByPeriod.get(period);
    if (exc) {
      const subject = exc.subject.trim();
      if (!subject) {
        // 停课：只有原本有课才值得展示（对空格子记录停课无意义）
        if (base?.subject) {
          result.push({ period, subject: base.subject, note: exc.note ?? base.note, state: "cancelled" });
        }
        continue;
      }
      const state: EffectiveSlotState =
        base?.subject && base.subject !== subject ? "changed" : base?.subject ? "normal" : "added";
      result.push({ period, subject, note: exc.note ?? base?.note ?? null, state });
      continue;
    }
    if (base?.subject) {
      result.push({ period, subject: base.subject, note: base.note, state: "normal" });
    }
  }
  return result.sort((a, b) => a.period - b.period);
}

/* ------------------------------------------------------------------ */
/* 我的课表（带日期）：周课表 + 调课例外 → 具体某天的实际行程              */
/* ------------------------------------------------------------------ */

/** 我在某天的实际一节课：调课后的形态也带班级与节次时间 */
export interface MyDaySession {
  /** YYYY-MM-DD */
  date: string;
  class_name: string;
  period: number;
  subject: string;
  note: string | null;
  start: string;
  end: string;
  state: EffectiveSlotState;
}

/**
 * 计算指定若干日期里「我的课」实际行程（跨班聚合，套用调课例外）。
 * - 换成别人的课（科目不再是任教学科）→ 我这节消失
 * - 我的课被停 → 保留（state=cancelled，界面划线展示「今天这节不用上」）
 * - 别的课调成了我的科目 → 出现（state=changed/added）
 * 每天结果按节次排序，返回 Map<日期, 会话[]>。
 */
export function buildMyDays(
  rows: TimetableSlotWithClass[],
  exceptions: TimetableExceptionWithClass[],
  mineOf: MineOfClass,
  dates: string[]
): Map<string, MyDaySession[]> {
  const weekdayOfDate = (dateStr: string): number => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return ((new Date(y, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7) + 1;
  };

  // 班级 → 该班周课格子 + 节次配置（rows 已联班级名）
  const baseByClass = new Map<string, TimetableSlotWithClass[]>();
  const periodsByClass = new Map<string, TimetablePeriod[] | null>();
  for (const row of rows) {
    const list = baseByClass.get(row.class_name) ?? [];
    list.push(row);
    baseByClass.set(row.class_name, list);
    periodsByClass.set(row.class_name, row.periods);
  }
  // 班级 → 日期 → 例外
  const excByClassDate = new Map<string, Map<string, TimetableExceptionWithClass[]>>();
  for (const exc of exceptions) {
    const byDate = excByClassDate.get(exc.class_name) ?? new Map();
    const list = byDate.get(exc.exception_date) ?? [];
    list.push(exc);
    byDate.set(exc.exception_date, list);
    excByClassDate.set(exc.class_name, byDate);
  }

  const result = new Map<string, MyDaySession[]>();
  for (const date of dates) {
    const weekday = weekdayOfDate(date);
    const sessions: MyDaySession[] = [];
    for (const [className, base] of baseByClass) {
      const dayExc = excByClassDate.get(className)?.get(date) ?? [];
      const effective = resolveDaySlots(
        base.filter((s) => s.day_of_week === weekday),
        dayExc
      );
      for (const slot of effective) {
        if (!isMySubject(slot.subject, mineOf(className))) continue;
        const time = (periodsByClass.get(className) ?? defaultPeriods()).find(
          (p) => p.period === slot.period
        );
        sessions.push({
          date,
          class_name: className,
          period: slot.period,
          subject: slot.subject,
          note: slot.note,
          start: time?.start ?? "",
          end: time?.end ?? "",
          state: slot.state,
        });
      }
    }
    sessions.sort((a, b) => a.period - b.period || a.class_name.localeCompare(b.class_name, "zh"));
    result.set(date, sessions);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 历史备忘背景：把事件放回「它当天所在的课表格子」                        */
/* ------------------------------------------------------------------ */

/** 历史备忘的「当时那节课」背景：日期落在周几、那节课是什么（已套调课例外） */
export interface EventContext {
  /** 1=周一 … 7=周日 */
  weekday: number;
  /** 该格的课程；班级事件最多 1 条，个人事件可多班命中（跨班任教），无课为空数组 */
  sessions: { class_name: string; subject: string; state: EffectiveSlotState }[];
}

/**
 * 历史备忘背景推导（实时推导、零迁移）：按事件日期定位学期课表，
 * 还原「当时那节课」的科目与班级，帮助回忆备忘的背景。
 * - 绑班级的事件：取该班当天该节的实际课程（套调课例外），不判是否我的科目
 * - 个人事件（class_name 为空）：取当天该节命中「我的科目」的班级（可能多班）
 * - period 为空（全天）/ 周末 / 那节没课：sessions 为空
 * 口径与「我的课表」同源：周课表为基准，例外只覆盖单日。
 */
export function resolveEventContexts(
  events: Pick<CalendarEvent, "id" | "class_name" | "event_date" | "period">[],
  rows: TimetableSlotWithClass[],
  exceptions: TimetableExceptionWithClass[],
  mineOf: MineOfClass
): Map<number, EventContext> {
  // 班级 → 周几 → 该天周课格子
  const baseByClass = new Map<string, Map<number, TimetableSlotWithClass[]>>();
  for (const row of rows) {
    const byDay = baseByClass.get(row.class_name) ?? new Map<number, TimetableSlotWithClass[]>();
    const list = byDay.get(row.day_of_week) ?? [];
    list.push(row);
    byDay.set(row.day_of_week, list);
    baseByClass.set(row.class_name, byDay);
  }
  // 班级 → 日期 → 例外（只有例外、没有周课格子的班也要参与，加课才还原得出来）
  const excByClassDate = new Map<string, Map<string, TimetableExceptionWithClass[]>>();
  for (const exc of exceptions) {
    const byDate = excByClassDate.get(exc.class_name) ?? new Map<string, TimetableExceptionWithClass[]>();
    const list = byDate.get(exc.exception_date) ?? [];
    list.push(exc);
    byDate.set(exc.exception_date, list);
    excByClassDate.set(exc.class_name, byDate);
  }
  const classNames = new Set<string>([...baseByClass.keys(), ...excByClassDate.keys()]);

  const weekdayOfDate = (dateStr: string): number => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return ((new Date(y, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7) + 1;
  };

  const result = new Map<number, EventContext>();
  for (const event of events) {
    const weekday = weekdayOfDate(event.event_date);
    const sessions: EventContext["sessions"] = [];
    if (event.period != null && weekday <= WEEKDAY_COUNT) {
      for (const className of classNames) {
        if (event.class_name && className !== event.class_name) continue;
        const dayExc = excByClassDate.get(className)?.get(event.event_date) ?? [];
        const effective = resolveDaySlots(
          baseByClass.get(className)?.get(weekday) ?? [],
          dayExc
        );
        const slot = effective.find((s) => s.period === event.period);
        if (!slot) continue;
        // 个人事件只认「我的科目」命中的班；班级事件是班级事实，不做科目过滤
        if (!event.class_name && !isMySubject(slot.subject, mineOf(className))) continue;
        sessions.push({ class_name: className, subject: slot.subject, state: slot.state });
      }
      sessions.sort((a, b) => a.class_name.localeCompare(b.class_name, "zh"));
    }
    result.set(event.id, { weekday, sessions });
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 科目配色：同一科目永远同色，网格 / 日历 / 首页共用                      */
/* ------------------------------------------------------------------ */

export type SubjectColorName =
  | "rose"
  | "sky"
  | "emerald"
  | "amber"
  | "violet"
  | "green"
  | "pink"
  | "orange"
  | "cyan"
  | "slate"
  | "teal"
  | "fuchsia"
  | "lime"
  | "stone";

/** 常用科目的固定配色（预设外的科目按字符散列取色，同一科目稳定同色） */
const SUBJECT_COLOR_PRESETS: Record<string, SubjectColorName> = {
  语文: "rose",
  数学: "sky",
  英语: "emerald",
  道德与法治: "amber",
  科学: "violet",
  体育: "green",
  音乐: "pink",
  美术: "orange",
  信息科技: "cyan",
  劳动: "lime",
  班会: "slate",
  自习: "stone",
  晨读: "teal",
  心理: "fuchsia",
};

const SUBJECT_COLOR_PALETTE: SubjectColorName[] = [
  "rose",
  "sky",
  "emerald",
  "amber",
  "violet",
  "green",
  "pink",
  "orange",
  "cyan",
  "teal",
  "fuchsia",
  "lime",
];

/** 科目 → 色名；预设外的自由科目按码点散列稳定取色 */
export function subjectColorName(subject: string): SubjectColorName {
  const key = subject.trim();
  const preset = SUBJECT_COLOR_PRESETS[key];
  if (preset) return preset;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return SUBJECT_COLOR_PALETTE[hash % SUBJECT_COLOR_PALETTE.length];
}

/** 浅底胶囊：网格 / 日历 / 周视图的科目格子（Tailwind v4 从源码字面量提取） */
const SUBJECT_CHIP_CLASSES: Record<SubjectColorName, string> = {
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  green: "bg-green-50 text-green-700 border-green-200",
  pink: "bg-pink-50 text-pink-700 border-pink-200",
  orange: "bg-orange-50 text-orange-700 border-orange-200",
  cyan: "bg-cyan-50 text-cyan-700 border-cyan-200",
  slate: "bg-slate-100 text-slate-700 border-slate-300",
  teal: "bg-teal-50 text-teal-700 border-teal-200",
  fuchsia: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  lime: "bg-lime-50 text-lime-700 border-lime-200",
  stone: "bg-stone-100 text-stone-700 border-stone-300",
};

/** 色点：浅色底与深色玻璃底都可用的实心圆点 */
const SUBJECT_DOT_CLASSES: Record<SubjectColorName, string> = {
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  green: "bg-green-500",
  pink: "bg-pink-500",
  orange: "bg-orange-500",
  cyan: "bg-cyan-500",
  slate: "bg-slate-500",
  teal: "bg-teal-500",
  fuchsia: "bg-fuchsia-500",
  lime: "bg-lime-500",
  stone: "bg-stone-500",
};

/** 科目格子底色类（bg / text / border 三件套），空科目退回中性 */
export function subjectChipClass(subject: string): string {
  return subject.trim()
    ? SUBJECT_CHIP_CLASSES[subjectColorName(subject)]
    : "bg-pearl text-muted border-hairline";
}

/** 深色毛玻璃面板的课程块：半饱和彩底 + 近白字 + 同色内描边（玻璃上叠彩色玻璃） */
const SUBJECT_GLASS_CLASSES: Record<SubjectColorName, string> = {
  rose: "bg-rose-500/30 text-rose-50 inset-ring-1 inset-ring-rose-300/40",
  sky: "bg-sky-500/30 text-sky-50 inset-ring-1 inset-ring-sky-300/40",
  emerald: "bg-emerald-500/30 text-emerald-50 inset-ring-1 inset-ring-emerald-300/40",
  amber: "bg-amber-500/30 text-amber-50 inset-ring-1 inset-ring-amber-300/40",
  violet: "bg-violet-500/30 text-violet-50 inset-ring-1 inset-ring-violet-300/40",
  green: "bg-green-500/30 text-green-50 inset-ring-1 inset-ring-green-300/40",
  pink: "bg-pink-500/30 text-pink-50 inset-ring-1 inset-ring-pink-300/40",
  orange: "bg-orange-500/30 text-orange-50 inset-ring-1 inset-ring-orange-300/40",
  cyan: "bg-cyan-500/30 text-cyan-50 inset-ring-1 inset-ring-cyan-300/40",
  slate: "bg-slate-400/30 text-slate-50 inset-ring-1 inset-ring-slate-300/40",
  teal: "bg-teal-500/30 text-teal-50 inset-ring-1 inset-ring-teal-300/40",
  fuchsia: "bg-fuchsia-500/30 text-fuchsia-50 inset-ring-1 inset-ring-fuchsia-300/40",
  lime: "bg-lime-500/30 text-lime-50 inset-ring-1 inset-ring-lime-300/40",
  stone: "bg-stone-400/30 text-stone-50 inset-ring-1 inset-ring-stone-300/40",
};

/** 深色毛玻璃底（首页课表面板）的科目块类；空科目退回中性玻璃 */
export function subjectGlassBlockClass(subject: string): string {
  return subject.trim()
    ? SUBJECT_GLASS_CLASSES[subjectColorName(subject)]
    : "bg-white/5 text-white/70 inset-ring-1 inset-ring-white/15";
}

/** 科目色点类，空科目退回中性灰 */
export function subjectDotClass(subject: string): string {
  return subject.trim() ? SUBJECT_DOT_CLASSES[subjectColorName(subject)] : "bg-faint";
}

/* ------------------------------------------------------------------ */
/* 日程事件类型元数据（备忘 / 待办 / 考试 / 作业）                          */
/* ------------------------------------------------------------------ */

/** 类型展示元数据：中文标签 + 色点（浅色底 / 深色玻璃底通用） */
export const CALENDAR_EVENT_META: Record<
  string,
  { label: string; dot: string }
> = {
  memo: { label: "备忘", dot: "bg-stone-400" },
  todo: { label: "待办", dot: "bg-primary" },
  exam: { label: "考试", dot: "bg-danger" },
  homework: { label: "作业", dot: "bg-amber-500" },
};

/** 日程类型快捷录入顺序 */
export const CALENDAR_EVENT_TYPES = ["memo", "todo", "exam", "homework"] as const;

/** 类型中文名；未知类型退回「备忘」 */
export function calendarEventLabel(type: string): string {
  return CALENDAR_EVENT_META[type]?.label ?? "备忘";
}

/**
 * 备忘的时间标签：绑节次 → 「第N节」；全天 / 日报事件（period 为空，含记在列头的备忘）→ 「全天」。
 * 各处展示备忘（日历格子、日详情、课表格子、历史抽屉、首页今日日程）共用同一口径。
 */
export function eventPeriodLabel(event: Pick<CalendarEvent, "period">): string {
  return event.period == null ? "全天" : `第${event.period}节`;
}

/* ------------------------------------------------------------------ */
/* 备忘快速浏览标题：AI 总结标题优先，未配置 AI 退回全文前几个字            */
/* ------------------------------------------------------------------ */

/** 无 AI 标题时的预览长度（「前几个字」） */
export const MEMO_PREVIEW_LEN = 8;

/** 全文前几个字：截断加省略号，避免把尾部空白带进预览 */
export function memoPreviewText(content: string): string {
  const text = content.trim();
  if (text.length <= MEMO_PREVIEW_LEN) return text;
  return `${text.slice(0, MEMO_PREVIEW_LEN).replace(/\s+$/, "")}…`;
}

/** 格子 / 列表里的快速浏览标题：有 AI 标题用标题，否则退回全文前几个字 */
export function eventQuickTitle(event: Pick<CalendarEvent, "content" | "title">): string {
  const title = event.title?.trim();
  return title || memoPreviewText(event.content);
}
