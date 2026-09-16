<script setup lang="ts">
import { computed } from "vue";

type Variant = "primary" | "secondary" | "pearl" | "dark" | "danger" | "link";

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    disabled?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "primary", disabled: false, type: "button" }
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();

const VARIANTS: Record<Variant, string> = {
  /* 渐变实底 + 内侧高光；hover 泛起主色光晕并轻微上浮 */
  primary:
    "h-9 px-[18px] rounded-pill btn-grad text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.25),var(--shadow-glow)] hover:-translate-y-px",
  /* 渐变描边：hover 泛起光环 */
  secondary: "h-9 px-[18px] rounded-pill grad-border text-primary hover:shadow-[var(--shadow-halo)]",
  pearl: "h-8 px-3.5 rounded-md grad-border text-primary hover:shadow-[var(--shadow-halo)]",
  dark: "h-8 px-[15px] rounded-sm bg-ink text-white hover:bg-ink-deep",
  danger:
    "h-9 px-[18px] rounded-pill grad-border-danger text-danger hover:shadow-[var(--shadow-halo-danger)]",
  link: "h-9 px-0 text-primary hover:text-primary-focus",
};

const cls = computed(() => [
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-caption",
  "transition-[transform,background-color,box-shadow] duration-150 active:scale-[0.95]",
  "disabled:pointer-events-none disabled:opacity-40",
  VARIANTS[props.variant],
]);
</script>

<template>
  <button :type="props.type" :class="cls" :disabled="props.disabled" @click="emit('click', $event)">
    <slot />
  </button>
</template>
