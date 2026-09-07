<script setup lang="ts">
/**
 * 轻量链接：统一替代裸的「蓝字 + 下划线」锚点。
 * - variant="chip"：按钮形态（默认），用于页面跳转 / 导航——hairline 描边胶囊 + 箭头，
 *   悬浮底色浮出、箭头平移；深色底用 tone="onDark" 切换玻璃胶囊
 * - variant="action"：原地动作（清空 / 换课 / 添加…）——无框文字，悬浮浮出浅色胶囊底
 * - to 存在渲染 RouterLink，否则渲染 button（转发 click）；icon 控制箭头方向
 * 字号与字重可由使用处的 class 微调（透传合并）。
 */
import { computed } from "vue";
import { RouterLink } from "vue-router";

type Tone = "primary" | "onDark" | "onDarkSolid" | "danger" | "muted";
type Icon = "arrow" | "back" | "none";
type Variant = "chip" | "action";
type Size = "sm" | "md";

const props = withDefaults(
  defineProps<{
    to?: string;
    variant?: Variant;
    tone?: Tone;
    icon?: Icon;
    size?: Size;
    disabled?: boolean;
  }>(),
  {
    to: undefined,
    variant: "chip",
    tone: "primary",
    icon: "arrow",
    size: "md",
    disabled: false,
  }
);

const emit = defineEmits<{ click: [] }>();

/* chip：按钮形态的配色（描边 + 底色 + 文字）；onDarkSolid 为深色底主按钮实底强调 */
const CHIP: Record<Tone, string> = {
  primary: "border-hairline bg-canvas text-weak hover:border-faint hover:bg-pearl hover:text-ink",
  onDark: "border-white/25 bg-white/10 text-white/85 hover:bg-white/20 hover:text-white",
  onDarkSolid: "border-transparent bg-primary-on-dark text-ink hover:bg-[#4da5ff]",
  danger: "border-danger/40 bg-canvas text-danger hover:bg-danger-soft",
  muted: "border-hairline bg-canvas text-muted hover:border-faint hover:bg-pearl hover:text-ink",
};

/* action：原地动作的配色（无框文字 + 悬浮胶囊底） */
const ACTION: Record<Tone, string> = {
  primary: "text-primary hover:bg-primary-soft",
  onDark: "text-primary-on-dark hover:bg-white/15",
  onDarkSolid: "text-primary-on-dark hover:bg-white/15",
  danger: "text-danger hover:bg-danger-soft",
  muted: "text-muted hover:bg-pearl hover:text-ink",
};

/* chip 的尺寸（action 无框，不吃尺寸） */
const SIZES: Record<Size, string> = {
  sm: "h-6 gap-0.5 px-2 text-fine",
  md: "h-7 gap-1 px-2.5 text-caption",
};

const rootCls = computed(() => [
  "group/link inline-flex shrink-0 cursor-pointer select-none items-center",
  "transition-[color,background-color,border-color,opacity] duration-150 active:scale-[0.97]",
  "disabled:pointer-events-none disabled:opacity-40",
  props.variant === "chip"
    ? ["rounded-pill border", SIZES[props.size], CHIP[props.tone]]
    : ["-mx-1 gap-1 rounded-sm px-1 text-left", ACTION[props.tone]],
]);
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="rootCls">
    <svg
      v-if="icon === 'back'"
      class="shrink-0 rotate-180 transition-transform duration-150 group-hover/link:-translate-x-0.5"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <slot />
    <svg
      v-if="icon === 'arrow'"
      class="shrink-0 transition-transform duration-150 group-hover/link:translate-x-0.5"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </RouterLink>
  <button v-else type="button" :class="rootCls" :disabled="disabled" @click="emit('click')">
    <svg
      v-if="icon === 'back'"
      class="shrink-0 rotate-180 transition-transform duration-150 group-hover/link:-translate-x-0.5"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <slot />
    <svg
      v-if="icon === 'arrow'"
      class="shrink-0 transition-transform duration-150 group-hover/link:translate-x-0.5"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</template>
