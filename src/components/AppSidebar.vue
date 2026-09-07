<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

const route = useRoute();

interface NavItem {
  name: string;
  label: string;
  icon: "home" | "classes" | "users" | "image" | "trash" | "sparkle" | "gear";
}

const items: NavItem[] = [
  { name: "home", label: "首页", icon: "home" },
  { name: "classes", label: "班级管理", icon: "classes" },
  { name: "students", label: "学生档案", icon: "users" },
  { name: "photos", label: "图片记录", icon: "image" },
  { name: "recycle-bin", label: "回收站", icon: "trash" },
  { name: "design", label: "设计系统", icon: "sparkle" },
  { name: "settings", label: "数据与设置", icon: "gear" },
];

const activeName = computed(() => {
  if (route.name === "student-detail") return "students";
  if (route.name === "class-detail") return "classes";
  return String(route.name ?? "");
});
</script>

<template>
  <aside class="flex w-60 shrink-0 flex-col gap-6 bg-parchment p-5">
    <!-- Brand -->
    <div class="flex items-center gap-2.5">
      <div class="flex h-7 w-7 items-center justify-center rounded-sm bg-ink">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <path
            d="M14 6.5L20.8 21.5H17.3L14 14.1L10.7 21.5H7.2L14 6.5Z"
            fill="#FFFFFF"
          />
        </svg>
      </div>
      <span class="text-[19px] font-semibold -tracking-[0.4px] text-ink">aprilio</span>
    </div>

    <!-- Nav -->
    <nav class="flex flex-col gap-0.5">
      <RouterLink
        v-for="item in items"
        :key="item.name"
        :to="{ name: item.name }"
        class="flex h-10 items-center gap-2.5 rounded-sm px-3 text-caption transition-colors"
        :class="
          activeName === item.name
            ? 'bg-canvas font-semibold text-ink'
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
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
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
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
          />
          <path
            d="M5 13.5l1.5-2h3l1.5 2"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M5 6h4"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'users'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 7.6a2.75 2.75 0 100-5.5 2.75 2.75 0 000 5.5zM1.6 13.6c0-2.2 2-3.7 4.4-3.7s4.4 1.5 4.4 3.7"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path
            d="M11 3.3a2.5 2.5 0 010 4.8M12.4 10.2c1.7.5 2.9 1.7 2.9 3.4"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
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
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
          />
          <circle cx="5.7" cy="6.3" r="1.15" :fill="activeName === item.name ? '#1d1d1f' : '#333333'" />
          <path
            d="M2.3 11.7l3.4-3.2 2.6 2.4 2.4-2.2 3 2.9"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
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
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M6.7 7.2v3.6M9.3 7.2v3.6"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <svg
          v-else-if="item.icon === 'sparkle'"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 2.2l1.5 3.7L13.2 7.4 9.5 8.9 8 12.6 6.5 8.9 2.8 7.4 6.5 5.9 8 2.2z"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <path
            d="M12.6 11.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z"
            :fill="activeName === item.name ? '#1d1d1f' : '#333333'"
          />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="2.2"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
          />
          <path
            d="M8 1.7v1.5M8 12.8v1.5M2.9 2.9l1.1 1.1M12 12l1.1 1.1M1.7 8h1.5M12.8 8h1.5M2.9 13.1l1.1-1.1M12 4l1.1-1.1"
            :stroke="activeName === item.name ? '#1d1d1f' : '#333333'"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        {{ item.label }}
      </RouterLink>
    </nav>

    <div class="flex-1" />

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
