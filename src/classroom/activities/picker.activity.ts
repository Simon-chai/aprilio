/**
 * 点名台（picker）活动定义 —— 数据源：lesson_events 的 `pick` 事件。
 *
 * kind 契约（登记到 kind 契约表）：
 *   kind: "pick"，payload: { mode: "random" | "weighted" | "hand"; weight?: number }
 *   student_id 必带（被点学生；独立列，跨会话「距上次被点 N 天」按学生索引）。
 *
 * 状态 = f(事件流)：已点名单 / 每人次数与最后被点时间 / 点名池 / 覆盖率 / 沉默权重原料。
 * 本活动 settle='session'：不产生档案记录（点评表扬由座位台等行为活动负责）。
 * 撤销不在本文件：框架标记 revoked 后全量重放，reduce 天然回滚。
 * 未知 kind 原样跳过（红线）——新活动零冲突接入的前提。
 */
import type {
  ClassroomStudent,
  LessonActivityDef,
  LessonEvent,
  LessonReadContext,
} from "../types";
import PickerPanel from "../../components/classroom/PickerPanel.vue";

/** pick 事件 payload 的 mode 契约 */
export type PickerMode = "random" | "weighted" | "hand";

/** 一次点名（一条 pick 事件的可读投影；event_id 供撤销） */
export interface PickerPick {
  event_id: number;
  student_id: number;
  student_name: string;
  occurred_at: string;
  mode: PickerMode;
  weight?: number;
}

/** 每人点名统计（已点名单的聚合口径） */
export interface PickerStudentStat {
  student_id: number;
  student_name: string;
  /** 本节课被点次数 */
  count: number;
  /** 最后一次被点时间（事件顺序里最后一条） */
  last_picked_at: string;
}

/** 沉默权重原料（来自跨会话读模型 ctx.daysSincePicked） */
export interface PickerSilence {
  student_id: number;
  student_name: string;
  /** 距最后一次未撤销 pick 的天数；null = 从未被点（按封顶天数计权） */
  days: number | null;
  /** 抽样权重：越久未被点越大（从未被点 = 封顶，优先级最高） */
  weight: number;
}

export interface PickerState {
  /** 已点名单（按事件顺序，一条事件一项） */
  called: PickerPick[];
  /** 每人统计（按首次被点顺序） */
  stats: PickerStudentStat[];
  /** 点名池：在班且本节课未被点过的学生（attendance 已由框架过滤） */
  pool: ClassroomStudent[];
  /** 覆盖率 = 已点且在班人数 / 在班人数（0~1） */
  coverage: number;
  /** 点名人次（= called.length） */
  pick_count: number;
  /** 在班学生的沉默读模型，按权重降序（最久未被点在前） */
  silent: PickerSilence[];
}

/** 沉默权重封顶天数：超过按封顶计（避免历史久远者权重失控） */
export const SILENCE_CAP_DAYS = 21;

/** 沉默权重（纯函数）：未点天数平方加权 + 1，从不被点 / 超过封顶按封顶算 */
export function silenceWeight(days: number | null): number {
  const d = days === null ? SILENCE_CAP_DAYS : Math.max(0, Math.min(days, SILENCE_CAP_DAYS));
  return (d / 3) ** 2 + 1;
}

/** 按权重抽样（纯函数，rand ∈ [0,1)）；权重全为 0 时退回第一个 */
export function weightedIndex(weights: number[], rand: number): number {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return 0;
  let rest = rand * sum;
  for (let i = 0; i < weights.length; i += 1) {
    rest -= weights[i];
    if (rest <= 0) return i;
  }
  return weights.length - 1;
}

/** payload 自校验（spec §14：kind→payload guard 写在活动文件内）：非法 mode 退回 random，非法 weight 丢弃 */
function parsePickPayload(payload: Record<string, unknown>): { mode: PickerMode; weight?: number } {
  const mode = payload?.mode;
  const weight = payload?.weight;
  return {
    mode: mode === "weighted" || mode === "hand" ? mode : "random",
    weight: typeof weight === "number" && Number.isFinite(weight) ? weight : undefined,
  };
}

/** 由已点名明细 + 只读上下文推导完整状态（纯函数；池与覆盖率随名单变化重算） */
function buildPickerState(called: PickerPick[], ctx: LessonReadContext): PickerState {
  const inClass = new Set(ctx.students.map((s) => s.id));
  const stats: PickerStudentStat[] = [];
  const statById = new Map<number, PickerStudentStat>();
  for (const pick of called) {
    let stat = statById.get(pick.student_id);
    if (!stat) {
      stat = {
        student_id: pick.student_id,
        student_name: pick.student_name,
        count: 0,
        last_picked_at: pick.occurred_at,
      };
      statById.set(pick.student_id, stat);
      stats.push(stat);
    }
    stat.count += 1;
    stat.last_picked_at = pick.occurred_at;
  }

  const pool = ctx.students.filter((s) => !statById.has(s.id));
  const pickedInClass = [...statById.keys()].filter((id) => inClass.has(id)).length;
  const silent: PickerSilence[] = ctx.students
    .map((s) => {
      const days = ctx.daysSincePicked(s.id);
      return { student_id: s.id, student_name: s.name, days, weight: silenceWeight(days) };
    })
    .sort((a, b) => b.weight - a.weight);

  return {
    called: [...called],
    stats,
    pool,
    coverage: inClass.size ? pickedInClass / inClass.size : 0,
    pick_count: called.length,
    silent,
  };
}

/** 空态：零点名时的读模型（池 = 全班在班学生）；组件在 state 为 null 时用它渲染 */
export function emptyPickerState(ctx: LessonReadContext): PickerState {
  return buildPickerState([], ctx);
}

/**
 * 事件归约（纯函数）：只认识 `pick`，其余 kind 原样跳过（引用不变）。
 * 学生姓名优先取当前在班名单（可能已被标缺勤），查不到则沿用历史名或占位名。
 */
export function reduce(
  state: PickerState | null,
  ev: LessonEvent,
  ctx: LessonReadContext,
): PickerState {
  if (ev.kind !== "pick") return state ?? emptyPickerState(ctx);
  if (ev.student_id == null) return state ?? emptyPickerState(ctx);

  const parsed = parsePickPayload(ev.payload);
  const name =
    ctx.students.find((s) => s.id === ev.student_id)?.name ??
    state?.stats.find((st) => st.student_id === ev.student_id)?.student_name ??
    `同学 ${ev.student_id}`;

  const called: PickerPick[] = [
    ...(state?.called ?? []),
    {
      event_id: ev.id,
      student_id: ev.student_id,
      student_name: name,
      occurred_at: ev.occurred_at,
      mode: parsed.mode,
      weight: parsed.weight,
    },
  ];
  return buildPickerState(called, ctx);
}

const pickerActivity = {
  type: "picker",
  title: "点名台",
  icon: "",
  requires: ["students", "dimensions"],
  settle: "session",
  reduce,
  /** 降级文案：全班缺勤时点名台无池可用 */
  fallback: (ctx: LessonReadContext) => (ctx.students.length ? null : "本班当前无在班学生，无法点名"),
  component: PickerPanel,
} satisfies LessonActivityDef<PickerState>;

export default pickerActivity;