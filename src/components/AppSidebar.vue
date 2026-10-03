<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import appIcon from "../assets/app-icon.png";
import { useFullscreen } from "../composables/useFullscreen";
import { isConfigRoute, useNavReturn } from "../composables/useNavReturn";

const route = useRoute();
const { isFullscreen, toggleFullscreen } = useFullscreen();

interface NavItem {
  name: string;
  label: string;
  icon: "home" | "classes" | "image" | "trash" | "prompt" | "gear";
}

/** 教学区条目：日常业务主战场，配置类页面一律不混入 */
const bizItems: NavItem[] = [
  { name: "home", label: "首页", icon: "home" },
  { name: "classes", label: "班级管理", icon: "classes" },
  { name: "photos", label: "图片记录", icon: "image" },
];

/** 配置世界条目：回收站属数据安全管理，与提示词、数据与设置一起归入设置中心 */
const configItems: NavItem[] = [
  { name: "prompts", label: "提示词管理", icon: "prompt" },
  { name: "recycle-bin", label: "回收站", icon: "trash" },
  { name: "settings", label: "数据与设置", icon: "gear" },
];

const { returnTo } = useNavReturn();

/** 双世界由当前路由推导：Agent 跳转、浏览器前进后退、深链接都天然成立 */
const inConfigWorld = computed(() => isConfigRoute(route.name));
const items = computed(() => (inConfigWorld.value ? configItems : bizItems));

const activeName = computed(() => {
  // 班级详情与学生详情都是从「班级管理」下钻的层级，侧栏沿用同一高亮
  if (route.name === "class-detail" || route.name === "student-detail") return "classes";
  return String(route.name ?? "");
});
</script>

<template>
  <aside class="flex w-60 shrink-0 flex-col gap-6 bg-parchment p-5">
    <!-- Brand -->
    <div class="flex items-center gap-2.5">
      <img
        :src="appIcon"
        alt="aprilio"
        class="h-7 w-7 rounded-sm object-cover"
        draggable="false"
      />
      <span class="text-[19px] font-semibold -tracking-[0.4px] text-ink">aprilio</span>
    </div>

    <!-- 配置世界头部：返回教学（回到进入前的业务页）+ 标题，标明与教学区的边界 -->
    <div v-if="inConfigWorld" class="flex flex-col">
      <RouterLink
        :to="returnTo()"
        class="-ml-2 flex h-8 items-center gap-1.5 self-start rounded-sm px-2 text-caption text-primary transition-colors duration-200 hover:bg-primary-soft"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M9.5 3.5L5 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        返回教学
      </RouterLink>
      <div class="mt-2">
        <p class="text-body font-semibold text-ink">设置中心</p>
        <p class="mt-0.5 text-fine text-weak">影响全局的基础配置，与日常教学分开</p>
      </div>
    </div>

    <!-- Nav -->
    <nav class="flex flex-col gap-0.5" :class="inConfigWorld ? 'mt-1' : ''">
      <RouterLink
        v-for="item in items"
        :key="item.name"
        :to="{ name: item.name }"
        class="flex h-10 items-center gap-2.5 rounded-sm px-3 text-caption transition-[color,background-color,transform,box-shadow] duration-200"
        :class="
          activeName === item.name
            ? /* 提起感：整行轻微放大并向左上偏移，像被从导航里拎起来，浅影托底 */
              'bg-canvas font-semibold text-ink origin-left scale-[1.04] -translate-x-0.5 -translate-y-0.5 shadow-[0_4px_12px_rgba(29,29,31,0.10)]'
            : 'text-muted hover:bg-canvas/60'
        "
      >
        <svg
          v-if="item.icon === 'home'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.2 7.2L8 2.4l5.8 4.8M3.6 6.4v6.8h8.8V6.4"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'classes'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="2"
            y="2.5"
            width="12"
            height="9"
            rx="1.5"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M5 13.5l1.5-2h3l1.5 2"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M5 6h4"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'image'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="1.8"
            y="2.8"
            width="12.4"
            height="10.4"
            rx="2.2"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <circle cx="5.7" cy="6.3" r="1.15" fill="currentColor" />
          <path
            d="M2.3 11.7l3.4-3.2 2.6 2.4 2.4-2.2 3 2.9"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'trash'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M6.7 7.2v3.6M9.3 7.2v3.6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'prompt'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2.8 3.6h10.4a1.1 1.1 0 0 1 1.1 1.1v6.1a1.1 1.1 0 0 1-1.1 1.1H6l-2.9 2.3V4.7a1.1 1.1 0 0 1 1.1-1.1Z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M5 6.6h6M5 9h3.8"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg
          v-else
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="2.2"
            stroke="currentColor"
            stroke-width="1.4"
          />
          <path
            d="M8 1.7v1.5M8 12.8v1.5M2.9 2.9l1.1 1.1M12 12l1.1 1.1M1.7 8h1.5M12.8 8h1.5M2.9 13.1l1.1-1.1M12 4l1.1-1.1"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        {{ item.label }}
      </RouterLink>
    </nav>

    <div class="flex-1" />

    <!-- 设置中心唯一入口：教学世界的底部按钮，配置类页面全部从这里进（仅教学世界显示） -->
    <RouterLink
      v-if="!inConfigWorld"
      :to="{ name: 'settings-center' }"
      data-test="settings-center-entry"
      class="flex h-10 items-center gap-2.5 rounded-sm border border-hairline bg-pearl px-3 text-caption text-muted transition-[color,background-color,box-shadow] duration-200 hover:bg-canvas hover:text-primary hover:shadow-[0_4px_12px_rgba(29,29,31,0.08)]"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M8 1.7v1.5M8 12.8v1.5M2.9 2.9l1.1 1.1M12 12l1.1 1.1M1.7 8h1.5M12.8 8h1.5M2.9 13.1l1.1-1.1M12 4l1.1-1.1"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
      设置中心
      <span class="ml-auto text-fine text-weak">Ctrl+,</span>
    </RouterLink>

    <!-- 全屏切换：与系统标题栏互补，F11 同效 -->
    <button
      type="button"
      class="flex h-9 w-full items-center gap-2.5 rounded-sm px-3 text-caption text-muted transition-colors duration-200 hover:bg-canvas/60 hover:text-ink"
      @click="toggleFullscreen"
    >
      <svg
        v-if="!isFullscreen"
        class="text-muted"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <svg
        v-else
        class="text-muted"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      {{ isFullscreen ? "退出全屏" : "进入全屏" }}
      <span class="ml-auto text-fine text-weak">{{ isFullscreen ? "F11 · Esc" : "F11" }}</span>
    </button>

    <!-- 本地数据库状态 -->
    <div class="rounded-md border border-hairline bg-pearl p-3">
      <p class="text-fine text-weak">本地数据库</p>
      <div class="mt-1.5 flex items-center gap-1.5">
        <span class="h-1.5 w-1.5 rounded-full bg-success" />
        <span class="text-fine text-muted">SQLite · 已连接</span>
      </div>
    </div>
  </aside>
</template>
