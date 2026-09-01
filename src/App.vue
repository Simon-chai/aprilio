<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";

const route = useRoute();

// 首页与班级管理按新设计全宽呈现，不挂侧边栏
const fullBleed = computed(
  () => route.name === "home" || route.name === "classes"
);
</script>

<template>
  <div class="app-no-select flex h-full w-full overflow-hidden bg-canvas text-ink">
    <AppSidebar v-if="!fullBleed" />
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>
