/**
 * LessonContext —— 课堂容器与运行时。
 *
 * 职责（活动只写 reduce + UI，其余全在这里一次实现，所有活动受益）：
 * - 装配：按 def.requires 注入学生/座位/维度/事件（缺省从 db 与 seating 编排层取）
 * - 活动状态 = reduce(事件流) 全量重放：撤销、崩溃恢复、重开都走同一条路
 * - emit 双写通道：settle='behavior' 的活动发 behavior 事件时同事务落档案（db 层保证原子）
 * - 广播总线：事件先 insert、后广播；广播失败不回滚事件（事件已是事实），状态下次重放自愈
 */
import { inject, reactive } from "vue";
import { LESSON_CTX } from "./types";
import type {
  ClassroomGroup,
  ClassroomStudent,
  LessonActivityDef,
  LessonContext,
  LessonEvent,
  LessonEventInput,
  LessonReadContext,
  LessonSession,
  SeatingGrid,
} from "./types";
import { resolveActivityEntries } from "./registry";
import { buildClassroomRoster, buildGroups } from "./seating";
import {
  appendLessonEvent,
  lastPickedAtByStudent,
  listBehaviorDimensions,
  listLessonEvents,
  revokeLessonEvent,
} from "../lib/db";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";

/** 本地时间戳（与 SQLite datetime('now','localtime') 同格式） */
function localTs(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 「距上次被点 N 天」：按本地日期差（同天 = 0） */
function daysBetween(ts: string): number | null {
  const datePart = ts.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const [y, m, d] = datePart.split("-").map(Number);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((todayStart.getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
}

export interface BuildLessonContextOptions {
  session: LessonSession;
  /** 以下均为测试/特殊装配的覆盖项；缺省走 db + seating 编排 */
  students?: ClassroomStudent[];
  seating?: SeatingGrid;
  groups?: ClassroomGroup[];
  dimensions?: LessonContext["dimensions"];
  events?: LessonEvent[];
  registry?: Parameters<typeof resolveActivityEntries>[1];
}

/**
 * 装配一节课的容器：读齐名单/座位/维度/事件 → 解析活动组合 → 全量重放建状态。
 * 未知 type 的活动在装配期跳过（skipped 回报给调用方 toast，不阻断开课）。
 */
export async function buildLessonContext(
  opts: BuildLessonContextOptions,
): Promise<{ ctx: LessonContext; skipped: string[] }> {
  const { session } = opts;

  let students = opts.students;
  let seating = opts.seating;
  if (!students || !seating) {
    const roster = await buildClassroomRoster(session.class_name, session.lesson_date);
    students = students ?? roster.students;
    seating = seating ?? roster.seating;
  }
  const dimensions = opts.dimensions ?? (await listBehaviorDimensions());

  let events = opts.events ?? (await listLessonEvents(session.id));
  const { activities, skipped } = resolveActivityEntries(session.activities, opts.registry);

  // 缺勤（attendance 事件：以学生为单位，payload.absent = true 表示缺勤）
  const absentIds = collectAbsentIds(events);
  // 活跃读模型：随事件变化重建（students 已应用 attendance → 缺勤不在其中）
  const holder = reactive({
    students: filterInClass(students, absentIds),
    groups: [] as ClassroomGroup[],
    lastPicked: new Map<number, string>(),
  });
  holder.groups = buildGroups(holder.students);

  const snapshot = await lastPickedAtByStudent(
    students.map((s) => s.id),
    localTs(),
  );
  for (const [id, ts] of snapshot) holder.lastPicked.set(id, ts);

  /** 跨会话沉默读模型快照重拉：撤销/回滚后 daysSincePicked 与库内事实保持一致 */
  const refreshLastPicked = async () => {
    holder.lastPicked.clear();
    const fresh = await lastPickedAtByStudent(students!.map((s) => s.id), localTs());
    for (const [id, ts] of fresh) holder.lastPicked.set(id, ts);
  };

  const readCtx = (): LessonReadContext => ({
    session,
    students: holder.students,
    seating: seating!,
    groups: holder.groups,
    dimensions,
    daysSincePicked: (studentId: number) => {
      const ts = holder.lastPicked.get(studentId);
      return ts ? daysBetween(ts) : null;
    },
  });

  // 活动状态：type → reduce 全量重放产物
  const stateMap = reactive(new Map<string, unknown>());
  const listeners = new Set<(ev: LessonEvent) => void>();

  const rebuildStates = () => {
    const ctx = readCtx();
    for (const { def } of activities) {
      stateMap.set(def.type, replay(def, events, ctx));
    }
  };

  const broadcast = (ev: LessonEvent) => {
    for (const cb of [...listeners]) {
      try {
        cb(ev);
      } catch (e) {
        // 广播失败不回滚事件：事件已是事实，活动状态下次重放自愈
        console.error("[classroom] 事件广播失败", e);
      }
    }
  };

  /** 单事件增量归约（emit 的快路径；撤销/恢复走全量重放） */
  const applyEvent = (ev: LessonEvent) => {
    if (ev.kind === "attendance") {
      // 在班名单变化 → 全量重放：派生读模型（点名池/覆盖率/沉默榜）随之重算
      refreshRoster();
      rebuildStates();
    } else {
      // pick 先落沉默读模型再归约：被点学生当次即反映最新「距上次被点」
      if (ev.kind === "pick" && ev.student_id != null) {
        holder.lastPicked.set(ev.student_id, ev.occurred_at);
      }
      const ctx = readCtx();
      for (const { def } of activities) {
        stateMap.set(def.type, def.reduce(stateMap.get(def.type) ?? null, ev, ctx));
      }
    }
    broadcast(ev);
  };

  /** attendance 变化 → 在班名单/组随之重建（缺勤回到点名池的反向同理） */
  const refreshRoster = () => {
    const all = students!;
    const absent = collectAbsentIds(events);
    holder.students = filterInClass(all, absent);
    holder.groups = buildGroups(holder.students);
  };

  rebuildStates();

  const defOf = (type: string): LessonActivityDef<unknown> | undefined =>
    activities.find((a) => a.def.type === type)?.def;

  const ctx: LessonContext = {
    session,
    get students() {
      return holder.students;
    },
    seating: seating!,
    get groups() {
      return holder.groups;
    },
    dimensions,
    daysSincePicked: (studentId: number) => readCtx().daysSincePicked(studentId),
    activities,
    activityState: (type: string) => stateMap.get(type) ?? null,
    activityConfig: (type: string) => activities.find((a) => a.def.type === type)?.config ?? {},
    async emit(input: LessonEventInput): Promise<LessonEvent> {
      const def = defOf(input.activity);
      if (input.behavior && def?.settle !== "behavior") {
        throw new Error(`活动 ${input.activity} 未声明 settle='behavior'，不能发档案级事件`);
      }
      if (def?.settle === "behavior" && input.kind === "behavior" && !input.behavior) {
        throw new Error("behavior 事件必须带 behavior 负载（档案同事务双写）");
      }
      if (input.kind === "behavior" && input.student_id == null) {
        throw new Error("behavior 事件必须带 student_id");
      }
      const saved = await appendLessonEvent({ ...input, session_id: session.id });
      // 本地事件列表保持与库一致：attendance 的名单联动与全量重放都靠它
      events = [...events, saved];
      applyEvent(saved);
      return saved;
    },
    async revoke(eventId: number): Promise<void> {
      const target = events.find((e) => e.id === eventId) ?? null;
      await revokeLessonEvent(eventId);
      // 撤销后全量重放重建状态（一节课事件量级 ≤ 数百，不做增量撤销）
      events = await listLessonEvents(session.id);
      refreshRoster();
      await refreshLastPicked();
      rebuildStates();
      if (target) broadcast(target);
    },
    onEvent(cb: (ev: LessonEvent) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    ui: { toast: useToast(), confirm: confirmAction },
  };

  return { ctx, skipped };
}

/** 全量重放：未知 kind 由活动自行跳过（红线），框架不预过滤 —— digest 要消费全量历史 */
function replay(def: LessonActivityDef<unknown>, events: LessonEvent[], ctx: LessonReadContext): unknown {
  let state: unknown = null;
  for (const ev of events) {
    state = def.reduce(state as never, ev, ctx);
  }
  return state;
}

/** attendance 事件聚合：最后一条未撤销事件决定该生是否缺勤 */
function collectAbsentIds(events: LessonEvent[]): Set<number> {
  const absent = new Set<number>();
  for (const ev of events) {
    if (ev.kind !== "attendance" || ev.student_id == null) continue;
    if (ev.payload?.absent === true) absent.add(ev.student_id);
    else absent.delete(ev.student_id);
  }
  return absent;
}

function filterInClass(students: ClassroomStudent[], absentIds: Set<number>): ClassroomStudent[] {
  if (!absentIds.size) return [...students];
  return students.filter((s) => !absentIds.has(s.id));
}

/** 组件内取容器；未在 ClassroomView 内使用即报错（fail-fast） */
export function useLessonContext(): LessonContext {
  const ctx = inject(LESSON_CTX);
  if (!ctx) throw new Error("useLessonContext 只能在课堂模式内使用（ClassroomView 未 provide）");
  return ctx;
}