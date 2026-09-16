import { reactive } from "vue";

/**
 * 全局命令式确认（单例）：替换全部原生 confirm / window.confirm 的唯一确认模式。
 *
 * 用法：const ok = await confirmAction({ title: "删除学生", tone: "danger" });
 * 宿主为 App.vue 挂载的 ConfirmHost，读 useConfirm() 的状态渲染 ConfirmDialog。
 * 防重入：上一个确认未关闭时再次调用返回同一个进行中的 Promise，禁止叠弹。
 */

export type ConfirmTone = "default" | "danger";

export interface ConfirmOptions {
  title: string;
  message?: string;
  tone?: ConfirmTone;
  confirmText?: string;
  cancelText?: string;
}

/** ConfirmHost 渲染所需的全部状态（resolve 后整体清空） */
interface ConfirmSnapshot {
  open: boolean;
  title: string;
  message?: string;
  tone: ConfirmTone;
  confirmText?: string;
  cancelText?: string;
}

// 模块级单例状态：全应用共享（同 useFullscreen 先例）
const state = reactive<ConfirmSnapshot>({
  open: false,
  title: "",
  message: undefined,
  tone: "default",
  confirmText: undefined,
  cancelText: undefined,
});

let pending: Promise<boolean> | null = null;
let resolvePending: ((ok: boolean) => void) | null = null;

/**
 * 弹出全局确认，resolve(true) = 确认，resolve(false) = 取消（含 Esc / 遮罩点击）。
 * 未决期间重复调用返回同一个 Promise，不覆盖第一次的内容。
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  if (pending) return pending;
  state.open = true;
  state.title = opts.title;
  state.message = opts.message;
  state.tone = opts.tone ?? "default";
  state.confirmText = opts.confirmText;
  state.cancelText = opts.cancelText;
  pending = new Promise<boolean>((resolve) => {
    resolvePending = resolve;
  });
  return pending;
}

/** 结算并清空状态：确认 / 取消共用 */
function settle(ok: boolean) {
  if (!pending || !resolvePending) return;
  resolvePending(ok);
  pending = null;
  resolvePending = null;
  state.open = false;
  state.title = "";
  state.message = undefined;
  state.tone = "default";
  state.confirmText = undefined;
  state.cancelText = undefined;
}

/** 宿主（ConfirmHost）读状态渲染，并提供确认 / 取消的结算入口 */
export function useConfirm() {
  return {
    state,
    /** 确认路径（点确认按钮 / 回车）→ resolve(true) */
    confirm: () => settle(true),
    /** 取消路径（点取消按钮 / Esc / 遮罩点击）→ resolve(false) */
    cancel: () => settle(false),
  };
}
