<script setup lang="ts">
/**
 * 课堂容器 provide 壳：ClassroomView 装配出 LessonContext 后包一层，
 * 让「provide(LESSON_CTX)」发生在 setup 同步期（Vue 要求），活动组件 inject 才拿得到。
 */
import { provide } from "vue";
import { LESSON_CTX } from "../../classroom/types";
import type { LessonContext } from "../../classroom/types";

const props = defineProps<{ ctx: LessonContext }>();

provide(LESSON_CTX, props.ctx);
</script>

<template>
  <slot />
</template>