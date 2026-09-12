/**
 * 页面上下文总线：视图 → Agent 的单向上报通道（page-action-bus 的对称面）。
 *
 * 「当前页面渲染了什么」只有视图自己知道（路由参数、当前页签、加载完成的真实数据）。
 * 视图在 onMounted / 数据刷新 / 页签切换时上报快照，Agent 侧两处消费：
 * 1. loop 每轮构造 system prompt 时读取最新快照（模型不调工具也知道「这个班」是谁）
 * 2. current_page 工具（模型主动查看页面渲染详情）
 *
 * 与 page-action 总线分工一致：容器管不了视图内部状态，总线只做存取，
 * 视图持有事实。快照摘要须与页面数据同源（同查 db 层），数字才不会两说。
 */
export interface PageContextSnapshot {
  /** 页面标识（路由名，与 NAV_TARGETS.routeName 对齐），如 class-detail */
  page: string;
  /** 页面标题（含实体名），如「班级详情 · 三年级二班」 */
  title: string;
  /** 路由参数快照，如 { name: "三年级二班" } */
  params?: Record<string, string>;
  /** 给模型看的渲染摘要：关键数字与当前状态，几行以内，不含敏感字段 */
  summary: string;
  /** 上报时刻（毫秒时间戳），排查快照新鲜度用 */
  reportedAt: number;
}

const snapshots = new Map<string, PageContextSnapshot>();

/** 视图上报/更新本页面的上下文快照（onMounted、数据刷新、页签切换时调用） */
export function reportPageContext(snapshot: Omit<PageContextSnapshot, "reportedAt">): void {
  snapshots.set(snapshot.page, { ...snapshot, reportedAt: Date.now() });
}

/** 读取某页面的最新快照；没有上报过返回 undefined，调用方回退到路由名 */
export function getPageContext(page: string): PageContextSnapshot | undefined {
  return snapshots.get(page);
}

/** 视图卸载时清除自己的快照，避免残留过期上下文 */
export function clearPageContext(page: string): void {
  snapshots.delete(page);
}
