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

const emit = defineEmits<{ click: [] }>();

const VARIANTS: Record<Variant, string> = {
  primary: "h-9 px-[18px] rounded-pill bg-primary text-white hover:bg-primary-focus",
  secondary:
    "h-9 px-[18px] rounded-pill border border-primary text-primary hover:bg-primary-soft",
  pearl: "h-8 px-3.5 rounded-md border border-hairline bg-pearl text-muted hover:bg-parchment",
  dark: "h-8 px-[15px] rounded-sm bg-ink text-white hover:bg-[#000000]",
  danger: "h-9 px-[18px] rounded-pill border border-danger text-danger hover:bg-[#fdeef0]",
  link: "h-9 px-0 text-primary hover:text-primary-focus",
};

const cls = computed(() => [
  "inline-flex shrink-0 items-center justify-center gap-1.5 text-caption",
  "transition-[transform,background-color] duration-150 active:scale-[0.95]",
  "disabled:pointer-events-none disabled:opacity-40",
  VARIANTS[props.variant],
]);
</script>

<template>
  <button :type="props.type" :class="cls" :disabled="props.disabled" @click="emit('click')">
    <slot />
  </button>
</template>
