<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    variant?: "search" | "field";
    width?: string;
    type?: string;
    /** 透传给内部 input（如密钥框传 off 防浏览器记忆） */
    autocomplete?: string;
  }>(),
  { placeholder: "", variant: "search", width: "240px", type: "text", autocomplete: undefined }
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const onInput = (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value);

const shellCls = computed(() => [
  "flex h-9 items-center gap-2 bg-canvas border border-hairline text-caption",
  "focus-within:border-primary-focus transition-colors",
  props.variant === "search" ? "rounded-pill px-3.5" : "rounded-sm px-3",
]);
</script>

<template>
  <div :class="shellCls" :style="{ width: props.width }">
    <svg
      v-if="props.variant === 'search'"
      class="shrink-0"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="6.2" cy="6.2" r="4.4" stroke="#7a7a7a" stroke-width="1.5" />
      <path d="M9.6 9.6L12.4 12.4" stroke="#7a7a7a" stroke-width="1.5" stroke-linecap="round" />
    </svg>
    <input
      :value="props.modelValue"
      :type="props.type"
      :placeholder="props.placeholder"
      :autocomplete="props.autocomplete"
      class="w-full bg-transparent text-caption text-ink outline-none placeholder:text-weak"
      @input="onInput"
    />
  </div>
</template>
