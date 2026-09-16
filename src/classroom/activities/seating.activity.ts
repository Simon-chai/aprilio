/**
 * 座位活动（emit 双写的主战场）。
 *
 * 事件契约（spec §7，payload 最小充分，评语正文只进档案）：
 * - `behavior`      payload `{ dimension_id, type: 'praise'|'improve'|'neutral', via: 'seat' }`
 *                   + 必须带 student_id 与 behavior 负载（框架同事务双写 student_behavior_records）
 * - `attendance`    payload `{ absent: boolean }`（true 缺勤 / false 归班；撤销后回到名单与点名池）
 * - `seat_change`   payload `{ student_id, from: {row,col}, to: {row,col} }`（可选，仅摘要；
 *                   真正的座位调整是幂等命令 assignSeat()，不撤销）
 *
 * reduce 产出：座位角标（本课表扬计数）、缺勤名单、座位调整摘要、最近操作时间线。
 * 未知 kind 一律原样跳过（红线）。
 */
import SeatGridPanel from "../../components/classroom/SeatGridPanel.vue";
import type {
  ClassroomStudent,
  LessonActivityDef,
  LessonEvent,
  LessonReadContext,
} from "../types";

export interface SeatPos {
  row: number;
  col: number;
}

/** 时间线条目（最近操作，倒序，最多 KEEP_TIMELINE 条） */
export interface SeatingTimelineEntry {
  /** 事件 id（撤销按钮用） */
  id: number;
  kind: string;
  student_id: number | null;
  student_name: string;
  text: string;
  occurred_at: string;
}

export interface SeatingActivityState {
  /** 学生 id → 本课表扬次数（座位角标） */
  praise: Record<number, number>;
  /** 学生 id → 本课待改进次数 */
  improve: Record<number, number>;
  /** 缺勤名单（attendance 事件末态） */
  absent: Array<{ student_id: number; student_name: string }>;
  /** 座位调整摘要（仅 seat_change 事件，供小结/回放展示） */
  seatChanges: Array<{ student_id: number; student_name: string; from: SeatPos | null; to: SeatPos | null }>;
  /** 最近操作时间线（倒序） */
  timeline: SeatingTimelineEntry[];
}

const KEEP_TIMELINE = 12;

const POLARITY_LABEL: Record<string, string> = {
  praise: "表扬",
  improve: "待改进",
  neutral: "中立",
};

function createInitialState(): SeatingActivityState {
  return { praise: {}, improve: {}, absent: [], seatChanges: [], timeline: [] };
}

/** 学生名查找：在班名单优先（缺勤学生已不在 ctx.students，回座位网格里找） */
function studentName(ctx: LessonReadContext, studentId: number): string {
  const inClass = ctx.students.find((s) => s.id === studentId);
  if (inClass) return inClass.name;
  for (const row of ctx.seating.cells) {
    for (const cell of row) {
      if (cell && cell.id === studentId) return cell.name;
    }
  }
  return `#${studentId}`;
}

/** 维度名（时间线展示用；维度被删/改名时回退「表现」） */
function dimensionName(ctx: LessonReadContext, dimensionId: unknown): string {
  const id = Number(dimensionId);
  if (!Number.isFinite(id)) return "表现";
  return ctx.dimensions.find((d) => d.id === id)?.name ?? "表现";
}

function pushTimeline(state: SeatingActivityState, entry: SeatingTimelineEntry): SeatingTimelineEntry[] {
  return [entry, ...state.timeline].slice(0, KEEP_TIMELINE);
}

/** 座位坐标（空位 / 未入座返回 null） */
function seatPosOf(student: ClassroomStudent | undefined): SeatPos | null {
  if (!student || student.row_no < 1 || student.col_no < 1) return null;
  return { row: student.row_no, col: student.col_no };
}

/** 事件 → 单步归约（纯函数，等活动状态 = 事件流全量重放） */
function reduce(
  state: SeatingActivityState | null,
  ev: LessonEvent,
  ctx: LessonReadContext,
): SeatingActivityState {
  const prev = state ?? createInitialState();

  /* 记表现（点名入口发的 behavior 也计入，同一档案域、同一角标） */
  if (ev.kind === "behavior") {
    if (ev.student_id == null) return prev;
    const type = typeof ev.payload?.type === "string" ? ev.payload.type : "neutral";
    const name = studentName(ctx, ev.student_id);
    const label = dimensionName(ctx, ev.payload?.dimension_id);
    const timeline = pushTimeline(prev, {
      id: ev.id,
      kind: ev.kind,
      student_id: ev.student_id,
      student_name: name,
      text: `${name} · ${label} · ${POLARITY_LABEL[type] ?? "记录"}`,
      occurred_at: ev.occurred_at,
    });
    const praise = { ...prev.praise };
    const improve = { ...prev.improve };
    if (type === "praise") praise[ev.student_id] = (praise[ev.student_id] ?? 0) + 1;
    else if (type === "improve") improve[ev.student_id] = (improve[ev.student_id] ?? 0) + 1;
    return { ...prev, praise, improve, timeline };
  }

  /* 缺勤 / 归班：末条事件定状态（与 Context 的表格过滤同口径） */
  if (ev.kind === "attendance") {
    if (ev.student_id == null) return prev;
    const absent = prev.absent.filter((a) => a.student_id !== ev.student_id);
    const name = studentName(ctx, ev.student_id);
    const isAbsent = ev.payload?.absent === true;
    if (isAbsent) absent.push({ student_id: ev.student_id, student_name: name });
    return {
      ...prev,
      absent,
      timeline: pushTimeline(prev, {
        id: ev.id,
        kind: ev.kind,
        student_id: ev.student_id,
        student_name: name,
        text: `${name} · ${isAbsent ? "标记缺勤" : "归班"}`,
        occurred_at: ev.occurred_at,
      }),
    };
  }

  /* 调座摘要（真实座位命令走 assignSeat，幂等不撤销） */
  if (ev.kind === "seat_change") {
    const studentId = Number(ev.payload?.student_id ?? ev.student_id);
    if (!Number.isFinite(studentId)) return prev;
    const name = studentName(ctx, studentId);
    const to = parsePos(ev.payload?.to);
    const from = parsePos(ev.payload?.from) ?? seatPosOf(ctx.students.find((s) => s.id === studentId));
    return {
      ...prev,
      seatChanges: [...prev.seatChanges, { student_id: studentId, student_name: name, from, to }],
      timeline: pushTimeline(prev, {
        id: ev.id,
        kind: ev.kind,
        student_id: studentId,
        student_name: name,
        text: `${name} · 调座 ${posText(from)} → ${posText(to)}`,
        occurred_at: ev.occurred_at,
      }),
    };
  }

  /* 未知 kind：必须原样跳过（新活动零冲突接入的前提） */
  return prev;
}

function parsePos(raw: unknown): SeatPos | null {
  if (!raw || typeof raw !== "object") return null;
  const { row, col } = raw as { row?: unknown; col?: unknown };
  const r = Number(row);
  const c = Number(col);
  return Number.isFinite(r) && Number.isFinite(c) && r >= 1 && c >= 1 ? { row: r, col: c } : null;
}

function posText(pos: SeatPos | null): string {
  return pos ? `第${pos.row}排${pos.col}列` : "未入座";
}

export const seatingActivity: LessonActivityDef<SeatingActivityState> = {
  type: "seating",
  title: "座位表",
  icon: "podium",
  requires: ["students", "seating", "dimensions"],
  // 本活动产生档案级记录：behavior 事件走 Context 的双写通道
  settle: "behavior",
  reduce,
  /** 无座位表 → 回退提示（不是错误）：课堂模式 P0 无表也能上课 */
  fallback: (ctx) =>
    ctx.seating.derived ? "未维护座位表，本次按学号临时排座（调整结果会写入学期座位表）" : null,
  component: SeatGridPanel,
};

export default seatingActivity;