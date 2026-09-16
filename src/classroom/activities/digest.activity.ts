/**
 * 小结活动（只读）：不发出任何事件，只消费全量事件流做实时统计与 AI/数据版小结预览。
 *
 * - reduce 只累积事件（`{ events }`），统计聚合交给 digest.ts 的纯函数
 * - settle = 'session'（不产生档案级记录，零双写）
 * - 已撤销事件不入状态（撤销由框架全量重放，这里再兜一层幂等）
 */
import DigestPanel from "../../components/classroom/DigestPanel.vue";
import type { LessonActivityDef, LessonEvent, LessonReadContext } from "../types";

export interface DigestActivityState {
  /** 未撤销事件全量（按 id 升序，与事件流同序） */
  events: LessonEvent[];
}

function reduce(
  state: DigestActivityState | null,
  ev: LessonEvent,
  _ctx: LessonReadContext,
): DigestActivityState {
  const prev = state ?? { events: [] };
  if (ev.revoked_at !== null) return prev;
  return { events: [...prev.events, ev] };
}

export const digestActivity: LessonActivityDef<DigestActivityState> = {
  type: "digest",
  title: "下课小结",
  icon: "archive",
  requires: ["students", "dimensions"],
  settle: "session",
  reduce,
  component: DigestPanel,
};

export default digestActivity;