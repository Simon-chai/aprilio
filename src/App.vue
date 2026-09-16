<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";
import AgentChat from "./components/agent/AgentChat.vue";
import GlobalSearch from "./components/GlobalSearch.vue";
import ConfirmHost from "./components/ui/ConfirmHost.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import { purgeExpiredRecycleItems } from "./lib/db";
import { useFullscreen } from "./composables/useFullscreen";

const route = useRoute();

// 仅首页与课堂模式全屏沉浸展示，其他页面均常驻侧边栏
const fullBleed = computed(() => route.name === "home" || route.name === "classroom");

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
    <!-- Ctrl+F 全局搜索浮层：跨学生 / 班级 / 考试 / 照片 / 备忘搜索并跳转 -->
    <GlobalSearch />
    <!-- 全局轻反馈 Toast：所有页面的提示统一从这里顶部弹出，层级高于一切弹层 -->
    <ToastHost />
    <!-- 全局确认弹层宿主：confirmAction() 命令式确认的唯一渲染出口 -->
    <ConfirmHost />
  </div>
</template>
