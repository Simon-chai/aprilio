<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";
import AgentChat from "./components/agent/AgentChat.vue";
import GlobalSearch from "./components/GlobalSearch.vue";
import ParentSummaryBatchDialog from "./components/ParentSummaryBatchDialog.vue";
import ConfirmHost from "./components/ui/ConfirmHost.vue";
import ToastHost from "./components/ui/ToastHost.vue";
import { purgeExpiredRecycleItems } from "./lib/db";
import { useFullscreen } from "./composables/useFullscreen";
import { useNavReturn } from "./composables/useNavReturn";

const route = useRoute();
const router = useRouter();

// 常驻记录教学足迹：App 全程挂载，首页 / 课堂模式这些无侧栏页面也会被记到，
// 「返回教学」才能回到进入设置中心前正在操作的页面
const { track } = useNavReturn();
router.afterEach((to) => track(to));

// 仅首页与课堂模式全屏沉浸展示，其他页面均常驻侧边栏
const fullBleed = computed(() => route.name === "home" || route.name === "classroom");

// 注册 F11 全屏切换与状态同步（App 常驻，保证任何页面都能响应快捷键）
useFullscreen();

// Ctrl+, 全局打开设置中心：侧栏入口按钮上公示的快捷键，首页/课堂模式没有侧栏也要能响应
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === ",") {
    e.preventDefault();
    if (route.name !== "settings-center") void router.push({ name: "settings-center" });
  }
}

// 启动时清一次回收站过期项（保留期外彻底删除，连带清图片文件）
onMounted(() => {
  purgeExpiredRecycleItems().catch(() => {});
  window.addEventListener("keydown", onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
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
    <!-- 家校沟通总结批量对话框（班级层）：班级详情入口与 Agent 全班发起共用（任意页面可唤起）；
         单个学生的生成在学生档案「家校沟通」页签，不走全局弹层 -->
    <ParentSummaryBatchDialog />
    <!-- 全局轻反馈 Toast：所有页面的提示统一从这里顶部弹出，层级高于一切弹层 -->
    <ToastHost />
    <!-- 全局确认弹层宿主：confirmAction() 命令式确认的唯一渲染出口 -->
    <ConfirmHost />
  </div>
</template>
