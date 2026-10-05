<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

/**
 * 图标按钮：方案 C 渐变描边皮肤，可操作语义常显。
 * - showLabel：升级为「图标 + 文字」胶囊（低频关键操作用，如 编辑/归档/删除/导入），
 *   不再依赖悬浮 tooltip 说明自己是什么
 * - tone="danger"：危险操作红渐变描边
 * - size="sm"：showLabel 时的小号（h-6），用于卡片行内
 * - 悬浮说明（仅图标形态）：Teleport 到 body 的 fixed 气泡，hover / 键盘聚焦可见。
 *   禁止改回按钮内原位绝对定位——compact 的 overflow-x-auto 工具栏（班级详情页
 *   学生条目区等）会把上弹气泡整颗裁掉；z-[60] 介于弹层（≤z-50）与 toast（z-[70]）之间
 */
const props = withDefaults(
  defineProps<{
    label: string;
    disabled?: boolean;
    tone?: "default" | "danger";
    showLabel?: boolean;
    size?: "md" | "sm";
  }>(),
  { disabled: false, tone: "default", showLabel: false, size: "md" }
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const TONE = {
  default: "grad-border text-primary hover:shadow-[var(--shadow-halo)]",
  danger: "grad-border-danger text-danger hover:shadow-[var(--shadow-halo-danger)]",
} as const;

const cls = computed(() => [
  "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap",
  "transition-[color,box-shadow,transform] duration-150 active:scale-[0.95]",
  "disabled:pointer-events-none disabled:opacity-40",
  props.showLabel
    ? props.size === "sm"
      ? "h-6 w-auto gap-1 rounded-pill px-2.5 text-[11px] font-medium"
      : "h-7 w-auto gap-1.5 rounded-pill px-3 text-fine font-medium"
    : "h-8 w-8 rounded-md",
  TONE[props.tone],
]);

const GAP = 6; // 气泡与按钮的间距
const EDGE = 8; // 气泡距视口边缘的最小间距

const btnRef = ref<HTMLButtonElement | null>(null);
const tipRef = ref<HTMLDivElement | null>(null);
const open = ref(false);
const pos = ref({ left: 0, top: 0 });

// 气泡挂在 body 下，需按按钮的视口坐标反推位置：上方放不下翻到下方，横向钳在视口内
function place() {
  const btn = btnRef.value;
  const tip = tipRef.value;
  if (!btn || !tip) return;
  const r = btn.getBoundingClientRect();
  const th = tip.offsetHeight;
  const tw = tip.offsetWidth;
  let top = r.top - GAP - th;
  if (top < EDGE && r.bottom + GAP + th <= window.innerHeight - EDGE) {
    top = r.bottom + GAP;
  }
  const left = Math.min(
    Math.max(EDGE, r.left + r.width / 2 - tw / 2),
    Math.max(EDGE, window.innerWidth - tw - EDGE)
  );
  pos.value = { left: Math.round(left), top: Math.round(top) };
}

function show() {
  if (props.disabled || props.showLabel) return;
  place();
  open.value = true;
}

function hide() {
  open.value = false;
}

// 键盘聚焦（focus-visible）与 hover 同等可见；鼠标点击带来的普通聚焦不弹
function onFocus(e: FocusEvent) {
  try {
    if (!(e.target instanceof HTMLElement) || !e.target.matches(":focus-visible")) return;
  } catch {
    return;
  }
  show();
}

// 气泡 fixed 定位不随内容滚动，滚动 / 缩放时按按钮当前位置重新对位
function onViewportChange() {
  if (open.value) place();
}

window.addEventListener("scroll", onViewportChange, true);
window.addEventListener("resize", onViewportChange);
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
});
</script>

<template>
  <button
    ref="btnRef"
    type="button"
    :class="cls"
    :disabled="props.disabled"
    :aria-label="props.label"
    @click="emit('click', $event)"
    @mouseenter="show"
    @mouseleave="hide"
    @focus="onFocus"
    @blur="hide"
  >
    <slot />
    <template v-if="props.showLabel">{{ label }}</template>
    <!-- 悬浮说明必须 Teleport 出去：放回按钮内会被 overflow 祖先裁剪（见头注释） -->
    <Teleport to="body">
      <div
        v-if="!props.showLabel"
        ref="tipRef"
        role="tooltip"
        class="pointer-events-none fixed z-[60] whitespace-nowrap rounded-sm bg-tile px-2.5 py-1 text-fine text-white shadow-md transition-opacity duration-150"
        :class="open ? 'opacity-100' : 'opacity-0'"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      >
        {{ label }}
      </div>
    </Teleport>
  </button>
</template>
