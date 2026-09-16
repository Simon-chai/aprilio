<script setup lang="ts">
/**
 * 轻量图标：从静态注册表 icons.ts 取 name 对应的 svg 内部元素渲染。
 * - 不引入图标库，保持现有 Apple 式手绘细线条风格（规格 §3.5）
 * - 颜色永远继承文字色（currentColor），组件本身不含任何色值，
 *   需要变色时在使用处加 text-* token 类（如 text-weak / text-primary / text-danger）
 * - 未知 name 渲染空 svg，dev 环境 console.warn 告警但不崩溃
 *   （对齐 Agent 未知工具兜底原则）
 */
import { computed } from "vue";
import { ICONS } from "./icons";

const props = defineProps<{ name: string; size?: number }>();

/** 注册表查不到时回退空串；dev 环境顺带告警，让拼写错误尽早暴露 */
const markup = computed(() => {
  const icon = ICONS[props.name];
  if (icon === undefined && import.meta.env.DEV) {
    console.warn(`[AppIcon] 未注册的图标名：${props.name}`);
  }
  return icon ?? "";
});
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  />
</template>
