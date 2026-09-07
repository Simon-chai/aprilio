<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";
import AgentChat from "./components/agent/AgentChat.vue";
import { purgeExpiredRecycleItems } from "./lib/db";

const route = useRoute();

// 仅首页全屏沉浸展示，其他页面均常驻侧边栏
const fullBleed = computed(() => route.name === "home");

// 启动时清一次回收站过期项（保留期外彻底删除，连带清图片文件）
onMounted(() => {
  purgeExpiredRecycleItems().catch(() => {});
});
</script>

<template>
  <div class="app-no-select flex h-full w-full overflow-hidden bg-canvas text-ink">
    <AppSidebar v-if="!fullBleed" />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <RouterView />
    </main>
    <!-- AI 助手全局浮层：任何页面都可唤起，由自主 Agent 框架驱动 -->
    <AgentChat />
  </div>
</template>
