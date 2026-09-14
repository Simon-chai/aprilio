<script setup lang="ts">
import { computed } from "vue";

/**
 * 图标按钮：方案 C 渐变描边皮肤，可操作语义常显。
 * - showLabel：升级为「图标 + 文字」胶囊（低频关键操作用，如 编辑/归档/删除/导入），
 *   不再依赖悬浮 tooltip 说明自己是什么
 * - tone="danger"：危险操作红渐变描边
 * - size="sm"：showLabel 时的小号（h-6），用于卡片行内
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
  "group/icon-btn relative inline-flex shrink-0 items-center justify-center whitespace-nowrap",
  "transition-[color,box-shadow,transform] duration-150 active:scale-[0.95]",
  "disabled:pointer-events-none disabled:opacity-40",
  props.showLabel
    ? props.size === "sm"
      ? "h-6 w-auto gap-1 rounded-pill px-2.5 text-[11px] font-medium"
      : "h-7 w-auto gap-1.5 rounded-pill px-3 text-fine font-medium"
    : "h-8 w-8 rounded-md",
  TONE[props.tone],
]);
</script>

<template>
  <button
    type="button"
    :class="cls"
    :disabled="props.disabled"
    :aria-label="props.label"
    @click="emit('click', $event)"
  >
    <slot />
    <template v-if="props.showLabel">{{ label }}</template>
    <!-- 悬浮说明文案：仅图标形态需要（showLabel 已自带文字）；WebView 中原生 title 不可靠，自绘保证可见 -->
    <span
      v-if="!props.showLabel"
      role="tooltip"
      class="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-tile px-2.5 py-1 text-fine text-white opacity-0 shadow-md transition-opacity duration-150 group-hover/icon-btn:opacity-100 group-focus-visible/icon-btn:opacity-100"
    >
      {{ label }}
    </span>
  </button>
</template>
