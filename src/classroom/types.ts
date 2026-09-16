import type { Component, InjectionKey } from "vue";
import type { BehaviorDimension, BehaviorInput, Gender } from "../types";
import type { ConfirmOptions } from "../composables/useConfirm";
import type { ToastOptions } from "../composables/useToast";

/**
 * 课堂模式（会话 × 活动 × 事件）的类型契约。
 * 设计依据：docs/superpowers/specs/2026-09-17-classroom-activity-framework-design.md
 * 三条原则：事件流是唯一事实源 / 档案型数据双写透传 / 开闭原则两道门（组合与 kind 开放）。
 *
 * 本文件是「接口冻结面」：db 层、活动定义、UI 组件都只依赖这里；改动需同步全链路。
 */

/* ------------------------------------------------------------------ */
/* 数据模型（对应 lesson_* / seatings / classroom_activity_sets 四表）    */
/* ------------------------------------------------------------------ */

export type LessonStatus = "live" | "ended";

/** 活动组合里的一项：type 指向 LessonActivityDef.type，config 由活动自行解释（框架不解释） */
export interface ActivitySetEntry {
  type: string;
  config?: Record<string, unknown>;
}

/** 节课会话（lesson_sessions 一行） */
export interface LessonSession {
  id: number;
  class_name: string;
  /** 科目自由文本（项目惯例：不做字典表） */
  subject: string;
  /** YYYY-MM-DD；学期由日期推导，不落库 */
  lesson_date: string;
  /** 课表节次；null = 临时课堂（课表外手动开课） */
  period: number | null;
  started_at: string;
  ended_at: string | null;
  status: LessonStatus;
  /** 本次课生效的活动组合快照（解析自 activity_set_json；历史会话重放用当时组合） */
  activities: ActivitySetEntry[];
  /** 下课统计快照（解析自 stats_json；null = 尚未下课） */
  stats: LessonStats | null;
  digest_md: string | null;
  digest_source: "ai" | "data" | null;
  created_at: string;
}

/** 课堂事件（lesson_events 一行）；payload 解析自 TEXT 列 */
export interface LessonEvent {
  id: number;
  session_id: number;
  /** 可空：小组事件等无学生主体 */
  student_id: number | null;
  /** 发出活动的 type，如 'picker' */
  activity: string;
  /** 开放字符串：pick | behavior | group_point | attendance | seat_change | …（未知 kind 必须安全跳过） */
  kind: string;
  payload: Record<string, unknown>;
  /** 双写背引用 student_behavior_records.id；null = 非档案型事件 */
  settled_record_id: number | null;
  occurred_at: string;
  created_at: string;
  /** 非空 = 已撤销；重放与聚合一律跳过 */
  revoked_at: string | null;
}

/** emit 的入参（id/created_at 由 db 层生成） */
export interface LessonEventInput {
  /**
   * 所在会话（lesson_events.session_id）。Context.emit 时由框架自动注入，
   * 直接调 db 层 appendLessonEvent 必须带。
   */
  session_id?: number;
  activity: string;
  kind: string;
  student_id?: number | null;
  payload?: Record<string, unknown>;
  /** 缺省 = 当前时间 */
  occurred_at?: string;
  /**
   * 档案型双写负载：settle='behavior' 的活动发 behavior 事件时必带（框架同事务落
   * student_behavior_records 并把 id 回填进 settled_record_id）。评语正文只存档案，事件不复制。
   */
  behavior?: Omit<BehaviorInput, "student_id" | "recorded_date">;
}

/** 下课统计快照（stats_json 的结构；digest 聚合产物） */
export interface LessonStats {
  /** 点名：每人次数（降序） */
  picks: Array<{ student_id: number; student_name: string; count: number }>;
  /** 点名覆盖率 0~1（被点人数 / 在班人数） */
  pick_coverage: number;
  praise_count: number;
  improve_count: number;
  /** 缺勤名单 */
  absent: Array<{ student_id: number; student_name: string }>;
  /** 小组分数（按组号升序） */
  groups: Array<{ group_no: number; score: number }>;
  /** 沉默预警名单（本轮未发言且最久未被点） */
  silent: Array<{ student_id: number; student_name: string; days: number | null }>;
  /** 课长（分钟） */
  duration_min: number;
}

/** 座位表一行（seatings；学期域状态，无表时按学号回退推导） */
export interface Seating {
  id: number;
  class_name: string;
  /** 学期号 YYYY-YYYY-1/2，写入时由日期推导 */
  semester: string;
  row_no: number;
  col_no: number;
  /** 组号显式列（不由 col 推导，支持团团坐等任意分组） */
  group_no: number;
  student_id: number;
  created_at: string;
}

/** 活动组合配置（classroom_activity_sets 一行）；P0 仅教师自定义时写入 */
export interface ClassroomActivitySet {
  id: number;
  name: string;
  /** 空串 = 通用默认集 */
  subject: string;
  activities: ActivitySetEntry[];
  sort_order: number;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* 读模型（Context 装配产物）                                           */
/* ------------------------------------------------------------------ */

/** 课堂学生：在班名单 + 座位/组号（无座位表时为回退推导结果） */
export interface ClassroomStudent {
  id: number;
  name: string;
  student_no: string;
  gender: Gender;
  /** 行列从 1 起；回退推导也填 */
  row_no: number;
  col_no: number;
  group_no: number;
}

/** 座位网格：cells[row][col] 从 0 起；null = 空位 */
export interface SeatingGrid {
  rows: number;
  cols: number;
  cells: Array<Array<ClassroomStudent | null>>;
  /** true = 未落库，按学号序回退推导（课堂模式 P0 无需先维护座位也能上课） */
  derived: boolean;
}

export interface ClassroomGroup {
  group_no: number;
  /** P0 显示「第 N 组」；P1 自定义组名由 classroom_group_labels 提供 */
  name: string;
  students: ClassroomStudent[];
}

/**
 * 活动只读上下文：reduce 的第三个参数（纯读，无副作用）。
 * students 已应用 attendance 事件（缺勤学生不在其中）。
 */
export interface LessonReadContext {
  session: LessonSession;
  students: ClassroomStudent[];
  seating: SeatingGrid;
  groups: ClassroomGroup[];
  dimensions: BehaviorDimension[];
  /** 沉默读模型：距最后一次未撤销 pick 的天数；从未被点返回 null */
  daysSincePicked(studentId: number): number | null;
}

/* ------------------------------------------------------------------ */
/* 活动定义（接入面唯一接口）                                            */
/* ------------------------------------------------------------------ */

/** 能力声明：Context 启动时按此装配（不需要的能力不装配，容器自动瘦身） */
export type LessonActivityRequirement = "students" | "seating" | "dimensions" | "events";

export interface LessonActivityDef<S = unknown> {
  /** 唯一键（重复注册启动即报错） */
  type: string;
  title: string;
  icon: string;
  requires: LessonActivityRequirement[];
  /** 结算声明：'behavior' = 本活动会产生档案级记录（emit 走双写通道） */
  settle: "behavior" | "session";
  /**
   * 事件归约：活动状态 = f(事件流)。纯函数——撤销、恢复、重开全部靠重放它。
   * 只处理自己认识的 kind，未知 kind 必须原样跳过（红线，新活动零冲突接入的前提）。
   */
  reduce(state: S | null, ev: LessonEvent, ctx: LessonReadContext): S;
  /** 数据缺失降级文案；null = 无需降级（例：无座位表 → 回退提示） */
  fallback?: (ctx: LessonReadContext) => string | null;
  /** UI 组件：框架 provide(LESSON_CTX)，组件内 useLessonContext() 取容器 */
  component: Component;
}

/** 注册表项：活动定义 + 其 config（来自 activity_set_json 快照） */
export interface LessonActivityEntry {
  def: LessonActivityDef<unknown>;
  config: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 运行时容器                                                            */
/* ------------------------------------------------------------------ */

export interface LessonContextUi {
  toast: (text: string, opts?: ToastOptions) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

export interface LessonContext extends LessonReadContext {
  /** 本次课的活动组合（按快照顺序，未知 type 已跳过） */
  activities: LessonActivityEntry[];
  /**
   * 读某活动的当前状态（= reduce 全量重放的产物；撤销/恢复后自动更新）。
   * 视图把 state 作为 prop 传给 def.component；组件内响应式读取即可。
   */
  activityState(type: string): unknown;
  /** 读某活动的 config（activity_set_json 快照透传，框架不解释内容） */
  activityConfig(type: string): Record<string, unknown>;
  /** 统一事件入口：settle='behavior' 的活动发 behavior 事件时自动同事务双写 */
  emit(ev: LessonEventInput): Promise<LessonEvent>;
  /** 撤销：behavior 事件联动删档案，随后广播重放 */
  revoke(eventId: number): Promise<void>;
  /** 活动间联动总线：座位表扬 → group-race 计分跳动、digest 计数都靠它 */
  onEvent(cb: (ev: LessonEvent) => void): () => void;
  ui: LessonContextUi;
}

/** provide/inject 键：ClassroomView 装配后 provide，活动组件 inject */
export const LESSON_CTX: InjectionKey<LessonContext> = Symbol("lesson-context");