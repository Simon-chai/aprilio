<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";
import AgentChat from "./components/agent/AgentChat.vue";
import { purgeExpiredRecycleItems } from "./lib/db";
import { useFullscreen } from "./composables/useFullscreen";

const route = useRoute();

// 仅首页全屏沉浸展示，其他页面均常驻侧边栏
const fullBleed = computed(() => route.name === "home");

// 注册 F11 全屏切换与状态同步（App 常驻，保证任何页面都能响应快捷键）
useFullscreen();

// 启动时清一次回收站过期项（保留期外彻底删除，连带清图片文件）
onMounted(() => {
  purgeExpiredRecycleItems().catch(() => {});
});
</script>

<template>
  <!-- 小屏兜底：主内容保底 880px，窗口不够宽时整体左右滚动，任何页面不再压缩换行或隐藏字段 -->
  <div class="app-no-select scroll-thin flex h-full w-full overflow-x-auto overflow-y-hidden bg-canvas text-ink">
    <AppSidebar v-if="!fullBleed" class="sticky left-0 top-0 z-20 self-stretch" />
    <main class="flex min-w-[880px] flex-1 flex-col overflow-hidden">
      <RouterView />
    </main>
    <!-- AI 助手全局浮层：任何页面都可唤起，由自主 Agent 框架驱动 -->
    <AgentChat />
  </div>
</template>
