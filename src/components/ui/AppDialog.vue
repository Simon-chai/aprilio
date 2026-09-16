<script lang="ts">
// 模块级弹层栈：本块只执行一次、所有实例共享，记录打开顺序；
// Esc 与 Tab 圈定只对栈顶生效（嵌套弹层让位给上层）
const dialogStack: object[] = [];
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

/**
 * 统一弹层壳：遮罩 / 居中与抽屉容器 / Esc / 焦点圈定 / aria / 过渡。
 * 只做「壳」，内容与底部操作区全走插槽——迁移弹窗时内容原样搬、data-test 全保留。
 *
 * - 不用 Teleport：就地 fixed 渲染，保证 wrapper.find() 可查内容
 * - Esc 只关栈顶：dialogStack 记录打开顺序，非栈顶不响应
 * - 焦点圈定纯 DOM API：打开时记住 activeElement 并聚焦面板（或首个 [autofocus]），
 *   Tab / Shift+Tab 在面板内循环，关闭时还原焦点
 */

defineOptions({ inheritAttrs: false });

type Variant = "center" | "drawer";
type Width = "sm" | "md" | "lg";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 标题：自动生成 id 并通过 aria-labelledby 关联到面板 */
    title: string;
    /** 标题下的弱化说明（可选） */
    description?: string;
    /** drawer = 右侧抽屉（全高贴右）；默认 center 居中 */
    variant?: Variant;
    /** 面板宽度：sm 440 / md 560 / lg 720，默认 md */
    width?: Width;
    /** 层级，默认 50；嵌套弹层透传抬高（如图片裁剪传 60） */
    z?: number;
    /** 遮罩点击是否关闭，默认 true；导入向导等防误关场景传 false */
    closeOnOverlay?: boolean;
  }>(),
  { variant: "center", width: "md", z: 50, closeOnOverlay: true }
);

const emit = defineEmits<{ close: [] }>();

const PANEL_WIDTH: Record<Width, string> = {
  sm: "w-[440px]",
  md: "w-[560px]",
  lg: "w-[720px]",
};

const titleId = useId();
const panelRef = ref<HTMLElement | null>(null);

// 面板进出场前的位移：center 上浮，drawer 从右侧滑入
const panelShiftClass = computed(() =>
  props.variant === "drawer" ? "opacity-0 translate-x-full" : "opacity-0 translate-y-2"
);

const panelClass = computed(() => [
  "pointer-events-auto max-w-full rounded-lg bg-canvas p-6 shadow-window focus:outline-none",
  PANEL_WIDTH[props.width],
  props.variant === "drawer" ? "fixed bottom-0 right-0 top-0" : "relative",
]);

let stackToken: object | null = null;
let savedActiveElement: HTMLElement | null = null;

// 焦点圈定可聚焦元素查询（面板自身 tabindex=-1，不参与循环）
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isTopDialog() {
  return stackToken !== null && dialogStack[dialogStack.length - 1] === stackToken;
}

function focusPanel() {
  const panel = panelRef.value;
  if (!panel) return;
  // 优先聚焦面板内显式声明 autofocus 的元素，否则聚焦面板本身
  const autofocus = panel.querySelector<HTMLElement>("[autofocus]");
  (autofocus ?? panel).focus();
}

function onDocumentKeydown(e: KeyboardEvent) {
  // Esc：仅栈顶弹层响应（嵌套弹层时下层不关）
  if (e.key === "Escape") {
    if (isTopDialog()) emit("close");
    return;
  }
  // Tab / Shift+Tab：焦点在面板内循环；非栈顶（被嵌套弹层覆盖）时让给上层
  if (e.key !== "Tab" || !isTopDialog()) return;
  const panel = panelRef.value;
  if (!panel) return;

  const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (focusables.length === 0) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && panel.contains(active);
  if (e.shiftKey) {
    if (active === first || !inside) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !inside) {
    e.preventDefault();
    first.focus();
  }
}

/** 出栈 + 移除监听 +（可选）还原焦点；open 变 false 与组件卸载共用 */
function release(restoreFocus: boolean) {
  if (stackToken) {
    const index = dialogStack.indexOf(stackToken);
    if (index >= 0) dialogStack.splice(index, 1);
    stackToken = null;
  }
  document.removeEventListener("keydown", onDocumentKeydown, true);
  if (restoreFocus && savedActiveElement && savedActiveElement.isConnected) {
    savedActiveElement.focus();
  }
  savedActiveElement = null;
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      stackToken = {};
      dialogStack.push(stackToken);
      // 捕获阶段监听：Tab 先于浏览器默认行为拦截
      document.addEventListener("keydown", onDocumentKeydown, true);
      savedActiveElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void nextTick(focusPanel);
    } else {
      release(true);
    }
  },
  { immediate: true }
);

// 打开状态下被卸载（父级 v-if 移除等）：同样出栈、移除监听并还原焦点
onBeforeUnmount(() => release(true));

function onOverlayMousedown() {
  if (props.closeOnOverlay) emit("close");
}
</script>

<template>
  <!-- 弹层根：常驻占位但从不拦截鼠标，关闭时不挡下层交互；层级由 z 透传 -->
  <div
    class="pointer-events-none fixed inset-0 flex items-center justify-center p-8"
    :style="{ zIndex: z }"
  >
    <!-- 遮罩：统一 bg-black/30，mousedown 即关（比 click 更跟手，不误触拖拽释放） -->
    <Transition
      enter-active-class="transition-opacity duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition-opacity duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        data-test="dialog-overlay"
        class="pointer-events-auto absolute inset-0 bg-black/30"
        @mousedown="onOverlayMousedown"
      />
    </Transition>
    <!-- 面板：$attrs（class / data-test 等）透传到这里；drawer 变体 fixed 贴右全高 -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      leave-active-class="transition duration-150 ease-in"
      :enter-from-class="panelShiftClass"
      :leave-to-class="panelShiftClass"
    >
      <div
        v-if="open"
        ref="panelRef"
        v-bind="$attrs"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        :class="panelClass"
      >
        <h2 :id="titleId" class="text-tagline font-semibold text-ink">{{ title }}</h2>
        <p v-if="description" class="mt-3 text-caption leading-relaxed text-muted">
          {{ description }}
        </p>
        <slot />
        <slot name="footer" />
      </div>
    </Transition>
  </div>
</template>
