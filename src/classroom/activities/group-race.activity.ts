/**
 * 小组积分赛（group-race）活动定义 —— 数据源：lesson_events 的 `group_point` 事件。
 *
 * kind 契约（登记到 kind 契约表）：
 *   kind: "group_point"，payload: { group_no: number; delta: number; reason: string }
 *   student_id 为 null（小组事件无学生主体）；组号从 1 起（0 = 未分组，不参与积分赛）。
 *
 * 状态 = f(事件流)：各组分数、领先组、每组分数变化流水（供跳动动画）。
 * **不落独立分值表**：分数永远是 group_point 事件的聚合值，下课快照写进 stats_json。
 * 未知 kind 原样跳过（红线）；撤销由框架标记 revoked 后全量重放，本文件不含撤销逻辑。
 */
import type {
  ClassroomStudent,
  LessonActivityDef,
  LessonEvent,
  LessonReadContext,
} from "../types";
import GroupRacePanel from "../../components/classroom/GroupRacePanel.vue";

/** 一次加减分（一条 group_point 事件的可读投影；event_id 供撤销） */
export interface GroupRacePoint {
  event_id: number;
  group_no: number;
  delta: number;
  reason: string;
  occurred_at: string;
  /** 该组累计到这条事件后的分数（供跳动动画定位「加完是几分」） */
  score_after: number;
}

/** 单个小组的积分态 */
export interface GroupRaceGroup {
  group_no: number;
  /** P0 显示「第 N 组」（组名来自 ctx.groups，事件引入的新组按组号兜底命名） */
  name: string;
  score: number;
  /** 组内成员（来自座位分组；事件引入的新组为空数组） */
  members: ClassroomStudent[];
  /** 本组分数变化流水（按事件顺序） */
  history: GroupRacePoint[];
}

export interface GroupRaceState {
  /** 全部加减分事件（按发生顺序，重放原料） */
  points: GroupRacePoint[];
  /** 各组积分（按组号升序，含本节课 0 分的组） */
  groups: GroupRaceGroup[];
  /** 领先组组号（最高分且 > 0；并列取组号最小者）；null = 尚无领先 */
  leader_group_no: number | null;
  /** 领先分数（0 = 尚无领先） */
  leader_score: number;
  /** 全部加减分之和 */
  total_points: number;
  /** 最近一条加减分的事件 id（组件「撤销刚才的加分」的目标） */
  last_event_id: number | null;
}

/** payload 自校验（spec §14）：组号必须是 ≥1 的整数、delta 必须是有穷非零数 */
function parseGroupPoint(ev: LessonEvent): Omit<GroupRacePoint, "score_after"> | null {
  const payload = ev.payload ?? {};
  const groupNo = payload.group_no;
  const delta = payload.delta;
  if (typeof groupNo !== "number" || !Number.isInteger(groupNo) || groupNo < 1) return null;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) return null;
  const reason = typeof payload.reason === "string" ? payload.reason : "";
  return {
    event_id: ev.id,
    group_no: groupNo,
    delta,
    reason,
    occurred_at: ev.occurred_at,
  };
}

/** 由加减分明细 + 只读上下文推导完整状态（纯函数；组名/成员随座位分组变化重算） */
function buildGroupRaceState(
  points: Omit<GroupRacePoint, "score_after">[],
  ctx: LessonReadContext,
): GroupRaceState {
  const groups = new Map<number, GroupRaceGroup>();
  for (const g of ctx.groups) {
    groups.set(g.group_no, {
      group_no: g.group_no,
      name: g.name,
      score: 0,
      members: g.students,
      history: [],
    });
  }

  const history: GroupRacePoint[] = [];
  for (const p of points) {
    let group = groups.get(p.group_no);
    if (!group) {
      group = {
        group_no: p.group_no,
        name: `第 ${p.group_no} 组`,
        score: 0,
        members: [],
        history: [],
      };
      groups.set(p.group_no, group);
    }
    group.score += p.delta;
    const point: GroupRacePoint = { ...p, score_after: group.score };
    group.history.push(point);
    history.push(point);
  }

  const list = [...groups.values()].sort((a, b) => a.group_no - b.group_no);
  // 领先组：最高分且 > 0；按组号升序扫描 + 严格大于 → 并列时取组号最小者
  let leader: GroupRaceGroup | null = null;
  for (const g of list) {
    if (g.score > 0 && (!leader || g.score > leader.score)) leader = g;
  }

  return {
    points: history,
    groups: list,
    leader_group_no: leader ? leader.group_no : null,
    leader_score: leader ? leader.score : 0,
    total_points: history.reduce((sum, p) => sum + p.delta, 0),
    last_event_id: history.length ? history[history.length - 1].event_id : null,
  };
}

/** 空态：零加减分时的读模型（各组 0 分）；组件在 state 为 null 时用它渲染 */
export function emptyGroupRaceState(ctx: LessonReadContext): GroupRaceState {
  return buildGroupRaceState([], ctx);
}

/**
 * 事件归约（纯函数）：只认识 `group_point`，其余 kind 原样跳过（引用不变）。
 * payload 非法（组号/分数不合法）同样跳过——事件已入流但本活动不消费。
 */
export function reduce(
  state: GroupRaceState | null,
  ev: LessonEvent,
  ctx: LessonReadContext,
): GroupRaceState {
  if (ev.kind !== "group_point") return state ?? emptyGroupRaceState(ctx);
  const point = parseGroupPoint(ev);
  if (!point) return state ?? emptyGroupRaceState(ctx);
  return buildGroupRaceState([...(state?.points ?? []), point], ctx);
}

const groupRaceActivity = {
  type: "group-race",
  title: "小组积分赛",
  icon: "",
  requires: ["students", "seating"],
  settle: "session",
  reduce,
  /** 降级文案：无座位分组时无法按组计分 */
  fallback: (ctx: LessonReadContext) => (ctx.groups.length ? null : "本班尚无座位分组，先排座位再开积分赛"),
  component: GroupRacePanel,
} satisfies LessonActivityDef<GroupRaceState>;

export default groupRaceActivity;