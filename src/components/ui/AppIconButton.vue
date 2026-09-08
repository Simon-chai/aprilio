<script setup lang="ts">
defineProps<{ label: string; disabled?: boolean }>();

const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="group/icon-btn relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-hairline bg-canvas text-weak transition-[color,border-color,transform] duration-150 hover:border-ink hover:text-ink active:scale-[0.95] disabled:pointer-events-none disabled:opacity-40"
    :disabled="disabled"
    :aria-label="label"
    @click="emit('click')"
  >
    <slot />
    <!-- 悬浮说明文案：WebView 中原生 title 提示不可靠，自绘 tooltip 保证可见 -->
    <span
      role="tooltip"
      class="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-tile px-2.5 py-1 text-fine text-white opacity-0 shadow-md transition-opacity duration-150 group-hover/icon-btn:opacity-100 group-focus-visible/icon-btn:opacity-100"
    >
      {{ label }}
    </span>
  </button>
</template>
