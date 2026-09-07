import { onBeforeUnmount, onMounted, ref, toValue, type MaybeRefOrGetter, type Ref } from "vue";

/** 一次滚轮手势累计超过这个量才翻页，触控板的碎步不会误触 */
const WHEEL_THRESHOLD = 26;
/** 两次滚动事件间隔超过这个时长，认为是一个新手势，累计量清零 */
const GESTURE_GAP = 220;
/** 翻页动画期间锁住输入，避免连翻 */
const LOCK_MS = 620;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * 整页翻页滚动：滚轮 / 方向键 / PageDown / 空格 / Home / End 都能翻。
 * 滚轮是主动接管而非依赖 scroll-snap —— 触控板轻扫一下也能稳定翻一整页。
 *
 * @param pageCount 总页数
 * @param viewport  滚动容器（每页高度 = 容器高度）
 * @param enabled   可选开关：为 false 时忽略滚轮/按键翻页（如番茄钟沉浸层打开时），goTo 仍可用
 */
export function usePagedScroll(
  pageCount: number,
  viewport: Ref<HTMLElement | null>,
  enabled?: MaybeRefOrGetter<boolean>,
) {
  const canPage = () => toValue(enabled ?? true);
  /** 当前页序号 */
  const index = ref(0);
  /** 连续进度：0 表示第 1 页顶部，1 表示第 2 页顶部，用于视差 */
  const progress = ref(0);
  /** 第 1 页滚出的比例，0~1 */
  const heroProgress = ref(0);

  let locked = false;
  let acc = 0;
  let lastTs = 0;
  let lockTimer = 0;
  let rafId = 0;

  const lock = () => {
    locked = true;
    window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(() => {
      locked = false;
      acc = 0;
    }, LOCK_MS);
  };

  const goTo = (target: number, smooth = true) => {
    const node = viewport.value;
    if (!node) return;
    const clamped = Math.max(0, Math.min(pageCount - 1, target));
    if (clamped === index.value && smooth) {
      // 已在目标页，只同步一下位置，避免半页残留
      node.scrollTo({ top: clamped * node.clientHeight, behavior: "smooth" });
      return;
    }
    node.scrollTo({
      top: clamped * node.clientHeight,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
    index.value = clamped;
    lock();
  };

  const next = () => goTo(index.value + 1);
  const prev = () => goTo(index.value - 1);

  /** 当前页内部还能滚就别抢它的滚轮 */
  const innerCanScroll = (delta: number): boolean => {
    const node = viewport.value;
    if (!node) return false;
    const inner = node.querySelector<HTMLElement>(`[data-page="${index.value}"] [data-page-scroll]`);
    if (!inner) return false;
    const max = inner.scrollHeight - inner.clientHeight;
    if (max <= 2) return false;
    if (delta > 0) return inner.scrollTop < max - 1;
    return inner.scrollTop > 1;
  };

  const onWheel = (e: WheelEvent) => {
    if (!canPage()) return;
    if (innerCanScroll(e.deltaY)) return;
    e.preventDefault();

    const ts = performance.now();
    if (ts - lastTs > GESTURE_GAP) acc = 0;
    lastTs = ts;
    if (locked) return;

    acc += e.deltaY;
    if (Math.abs(acc) < WHEEL_THRESHOLD) return;

    const dir = acc > 0 ? 1 : -1;
    acc = 0;
    goTo(index.value + dir);
  };

  const onKeydown = (e: KeyboardEvent) => {
    if (!canPage()) return;
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;

    switch (e.key) {
      case "ArrowDown":
      case "PageDown":
      case " ":
      case "Spacebar":
        e.preventDefault();
        next();
        break;
      case "ArrowUp":
      case "PageUp":
        e.preventDefault();
        prev();
        break;
      case "Home":
        e.preventDefault();
        goTo(0);
        break;
      case "End":
        e.preventDefault();
        goTo(pageCount - 1);
        break;
    }
  };

  const measure = () => {
    rafId = 0;
    const node = viewport.value;
    if (!node) return;
    const h = node.clientHeight || 1;
    const p = node.scrollTop / h;
    progress.value = Math.max(0, Math.min(pageCount - 1, p));
    heroProgress.value = Math.max(0, Math.min(1, p));
    index.value = Math.round(p);
  };

  const onScroll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(measure);
  };

  const onResize = () => {
    const node = viewport.value;
    if (!node) return;
    node.scrollTo({ top: index.value * node.clientHeight, behavior: "auto" });
    measure();
  };

  onMounted(() => {
    const node = viewport.value;
    if (node) {
      node.addEventListener("wheel", onWheel, { passive: false });
      node.addEventListener("scroll", onScroll, { passive: true });
      // 每次回到首页都从第 1 屏开始
      node.scrollTo({ top: 0, behavior: "auto" });
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", onResize);
    measure();
  });

  onBeforeUnmount(() => {
    const node = viewport.value;
    node?.removeEventListener("wheel", onWheel);
    node?.removeEventListener("scroll", onScroll);
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", onResize);
    window.clearTimeout(lockTimer);
    if (rafId) cancelAnimationFrame(rafId);
  });

  return { index, progress, heroProgress, goTo, next, prev };
}
