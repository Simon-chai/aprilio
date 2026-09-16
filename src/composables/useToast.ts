import { reactive } from "vue";

/**
 * 全局轻反馈（单例）：toast("已保存") / toast("删除失败", { tone: "error" })。
 * 宿主为 App.vue 挂载的 ToastHost（顶部居中、z-[70] 高于一切弹层）。
 * 同屏最多 3 条纵向堆叠，超出丢弃最旧；每条按时长自动消失。
 */

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  /** 停留毫秒数；缺省按 tone 取默认值 */
  duration?: number;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

/** 同屏最多条数：超出丢弃最旧 */
const MAX_VISIBLE = 3;
/** 各 tone 默认停留时长（毫秒）：error 更长，保证读得完 */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 2400,
  success: 2400,
  error: 3600,
};

// 模块级单例队列：全应用共享（同 useFullscreen 先例）
const items = reactive<ToastItem[]>([]);

let seq = 0;
// 条目自动消失计时器：id → timer，移除时一并取消
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) items.splice(index, 1);
}

function toast(text: string, opts?: ToastOptions) {
  const tone = opts?.tone ?? "info";
  const item: ToastItem = { id: ++seq, text, tone };
  items.push(item);
  // 超出上限：淘汰最旧（连带取消其计时器）
  while (items.length > MAX_VISIBLE) {
    dismiss(items[0].id);
  }
  const duration = opts?.duration ?? DEFAULT_DURATION[tone];
  timers.set(item.id, setTimeout(() => dismiss(item.id), duration));
}

function clearAll() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  items.splice(0, items.length);
}

/** 全局轻反馈入口：返回的可调用函数即 toast 本身，任意组件直接调用 */
export function useToast() {
  return toast;
}

/** ToastHost 专用：读队列渲染 + 卸载时清空（宿主销毁即清，用于测试隔离） */
export function useToastState() {
  return { items, clearAll };
}
