/**
 * 会话生命周期（设计规范 §6）：detect（课表节次感知）→ start（开课/幂等恢复）→ 恢复查询。
 *
 * - detect：复用 buildMyDays / resolveDaySlots 的「我的课表」投影（与首页课表面板同源），
 *   按传入时刻命中「今天第 N 节」的一节课；无命中 → 上层退化为手动选班开临时课堂（period null）
 * - start：解析活动组合 → 快照进 lesson_sessions.activity_set_json → 槽位幂等（同班同日同节已开即恢复）
 * - 下课与结算不在本文件：由 digest.ts#finishLesson 负责（本文件不 import 它，避免循环依赖）
 */
import {
  getProfile,
  listLiveLessonSessions,
  listTimetableExceptionsWithClass,
  listTimetableSlotsWithClass,
  openLessonSession,
} from "../lib/db";
import { buildMyDays, currentSemester, mineOfClassResolver, sessionIsNow } from "../lib/timetable";
import { resolveActivitySet } from "./activity-sets";
import { resolveActivityEntries } from "./registry";
import type { LessonSession } from "./types";

/** 节次感知命中的一节课：班级/科目/日期/节次 + 起止时间（来自该班节次配置） */
export interface DetectedLesson {
  class_name: string;
  subject: string;
  /** YYYY-MM-DD */
  lesson_date: string;
  period: number;
  start: string;
  end: string;
}

/** 本地日期 YYYY-MM-DD */
function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 节次感知：按传入时刻（缺省 now）命中「今天第 N 节」的我的一节课；无命中返回 null
 * （→ 手动选班开临时课堂）。
 * - 停课例外（state = cancelled）跳过
 * - 多命中时按「节次最小 → 班级名」排序取第一（跨班连堂/撞课时的确定性口径）
 */
export async function detectCurrentLesson(now: Date = new Date()): Promise<DetectedLesson | null> {
  const today = localDateStr(now);
  const semester = currentSemester(now);
  const [rows, exceptions, profile] = await Promise.all([
    listTimetableSlotsWithClass(semester),
    listTimetableExceptionsWithClass(semester, today, today),
    getProfile(),
  ]);
  const mineOf = mineOfClassResolver(rows, profile.my_subjects ?? []);
  const sessions = buildMyDays(rows, exceptions, mineOf, [today]).get(today) ?? [];

  const hit = sessions
    .filter((s) => s.state !== "cancelled" && sessionIsNow(s, now))
    .sort((a, b) => a.period - b.period || a.class_name.localeCompare(b.class_name, "zh"))[0];
  if (!hit) return null;

  return {
    class_name: hit.class_name,
    subject: hit.subject,
    lesson_date: today,
    period: hit.period,
    start: hit.start,
    end: hit.end,
  };
}

/**
 * 开课：解析活动组合 → 快照 → openLessonSession 幂等（同班同日同节已存在即恢复，不新建）。
 * 班级名空 / 日期格式错等校验由 db 层（openLessonSession）统一负责，这里不重复校验。
 * 返回 skipped = 组合中未注册的活动 type（快照里引用了未安装的活动 → 上层 toast，不阻断开课）。
 */
export async function startLesson(input: {
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
}): Promise<{ session: LessonSession; created: boolean; skipped: string[] }> {
  const resolved = await resolveActivitySet(input.subject);
  const { session, created } = await openLessonSession({
    class_name: input.class_name,
    subject: input.subject,
    lesson_date: input.lesson_date,
    period: input.period,
    activities: resolved.activities,
  });
  // 以会话里的快照为准解析（恢复既有会话时用当时的组合，而非当前配置）
  const { skipped } = resolveActivityEntries(session.activities);
  return { session, created, skipped };
}

/**
 * 入口快捷开课（首页课表面板「上课了」/ 我的课表 / Agent classroom/start）：
 * 命中当前节次 → 开课（槽位幂等）；无命中 → null，由调用方引导到启动页手动选班。
 */
export async function startDetectedLesson(
  now: Date = new Date(),
): Promise<{ session: LessonSession; created: boolean; skipped: string[] } | null> {
  const detected = await detectCurrentLesson(now);
  if (!detected) return null;
  return startLesson({
    class_name: detected.class_name,
    subject: detected.subject,
    lesson_date: detected.lesson_date,
    period: detected.period,
  });
}

/** 崩溃恢复：全部 live 会话（多班连堂可能多个，逐个重放恢复） */
export async function listResumableSessions(): Promise<LessonSession[]> {
  return listLiveLessonSessions();
}