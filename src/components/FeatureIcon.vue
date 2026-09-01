<script setup lang="ts">
import { computed } from "vue";

type IconName = "classes" | "students" | "photos" | "settings" | "sparkle";

const props = withDefaults(
  defineProps<{ name: IconName; size?: number; color?: string }>(),
  { size: 26, color: "currentColor" }
);

const d = computed(() => {
  switch (props.name) {
    // 班级：一大一小两个人
    case "classes":
      return [
        "M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8Z",
        "M3.2 19.4c0-3.1 2.6-5.2 5.8-5.2s5.8 2.1 5.8 5.2",
        "M15.6 5.5a3.2 3.2 0 0 1 0 5.2",
        "M17.8 14.6c1.7.8 2.9 2.4 2.9 4.6",
      ];
    // 学生：单人档案卡
    case "students":
      return [
        "M4.5 3.6h15a1.4 1.4 0 0 1 1.4 1.4v14a1.4 1.4 0 0 1-1.4 1.4h-15a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4Z",
        "M8.6 11.4a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z",
        "M5.2 16.6c.5-1.9 1.8-3 3.4-3s2.9 1.1 3.4 3",
        "M15 7.6h4M15 11h4M15 14.2h2.6",
      ];
    // 图片：相片 + 山
    case "photos":
      return [
        "M3.6 4.8h16.8a1.6 1.6 0 0 1 1.6 1.6v11.2a1.6 1.6 0 0 1-1.6 1.6H3.6a1.6 1.6 0 0 1-1.6-1.6V6.4a1.6 1.6 0 0 1 1.6-1.6Z",
        "M2.6 16.2 7.9 11l3.6 3.4 3.2-3 6.7 6.3",
      ];
    // 设置：齿轮
    case "settings":
      return [
        "M12 15.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Z",
        "M19.2 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-2.5 1v.3a1.9 1.9 0 1 1-3.8 0v-.2a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0-1-2.5H4a1.9 1.9 0 1 1 0-3.8h.2a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 2.5-1V4a1.9 1.9 0 1 1 3.8 0v.2a1.5 1.5 0 0 0 2.5 1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0 1 2.5h.2a1.9 1.9 0 1 1 0 3.8h-.2a1.5 1.5 0 0 0-1.2.9Z",
      ];
    // 设计系统：星芒
    default:
      return [
        "M12 2.6l2.3 5.6 5.6 2.3-5.6 2.3L12 18.4l-2.3-5.6L4.1 10.5l5.6-2.3L12 2.6Z",
        "M18.8 16.4l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z",
      ];
  }
});

const withDot = computed(() => props.name === "photos");
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    :stroke="props.color"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(p, i) in d" :key="i" :d="p" />
    <circle v-if="withDot" cx="16.2" cy="9.2" r="1.25" :fill="props.color" stroke="none" />
  </svg>
</template>
