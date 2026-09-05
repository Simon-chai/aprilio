/**
 * 页面动作总线：Agent（ui_action 工具）→ 视图 的单向通知通道。
 *
 * 「打开新建对话框」这类动作需要视图内部状态（dialogOpen），工具执行体
 * 拿不到组件实例，于是走总线广播；视图在 onMounted 挂监听即可被 Agent 感知：
 *
 *   const off = onPageAction("students/create-student", () => (dialogOpen.value = true));
 *   onBeforeUnmount(off);
 *
 * 这与容器（container.ts）分工：容器管「有哪些动作」（声明、枚举、确认门），
 * 总线管「把动作递进视图」（执行通道）。
 */
type Handler<T = unknown> = (payload?: T) => void;

const listeners = new Map<string, Set<Handler<unknown>>>();

/** 订阅一个页面动作；返回取消订阅函数 */
export function onPageAction<T = unknown>(actionId: string, handler: (payload?: T) => void): () => void {
  const set = listeners.get(actionId) ?? new Set<Handler<unknown>>();
  set.add(handler as Handler<unknown>);
  listeners.set(actionId, set);
  return () => {
    set.delete(handler as Handler<unknown>);
    if (!set.size) listeners.delete(actionId);
  };
}

/** 容器执行动作时广播；返回是否有视图接住了（没有接住说明动作声明了但视图未挂监听） */
export function emitPageAction<T = unknown>(actionId: string, payload?: T): boolean {
  const set = listeners.get(actionId);
  if (!set || !set.size) return false;
  for (const handler of [...set]) handler(payload);
  return true;
}
