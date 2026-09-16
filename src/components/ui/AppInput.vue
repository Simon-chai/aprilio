<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    variant?: "search" | "field";
    width?: string;
    type?: string;
    /** 透传给内部 input（如密钥框传 off 防浏览器记忆） */
    autocomplete?: string;
    /** 关联 datalist 的 id（模型 ID 输入框用：点开显示拉取到的候选） */
    list?: string;
  }>(),
  { placeholder: "", variant: "search", width: "240px", type: "text", autocomplete: undefined }
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const inputEl = ref<HTMLInputElement | null>(null);

const onInput = (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value);

/** 供浮层（如全局搜索）打开后主动聚焦 */
function focus() {
  inputEl.value?.focus();
}
defineExpose({ focus });

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
      class="shrink-0 text-weak"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="6.2" cy="6.2" r="4.4" stroke="currentColor" stroke-width="1.5" />
      <path d="M9.6 9.6L12.4 12.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
    <input
      ref="inputEl"
      :value="props.modelValue"
      :type="props.type"
      :placeholder="props.placeholder"
      :autocomplete="props.autocomplete"
      :list="props.list"
      class="w-full bg-transparent text-caption text-ink outline-none placeholder:text-weak"
      @input="onInput"
    />
  </div>
</template>
