<script setup lang="ts">
/**
 * 设置中心：业务与配置分离后的「配置世界」枢纽（方案 B · 双世界）。
 *
 * 侧栏在教学世界只保留业务项，底部「设置中心」进入本页；本页是配置类页面
 * （提示词管理 / 回收站 / 数据与设置）的总览入口，先给一句话说明再进具体页，
 * 以后新增配置页在这里加一张卡片、侧栏 configItems 加一行即可。
 */
import AppIcon from "../components/ui/AppIcon.vue";

/** 配置世界入口卡片：icon 取 AppIcon 静态注册表，desc 说明该页实际管什么 */
const entries = [
  {
    key: "prompts",
    to: { name: "prompts" },
    icon: "prompt",
    title: "提示词管理",
    desc: "按分组调整各 AI 功能的系统提示词，支持本机覆盖与恢复默认。",
  },
  {
    key: "recycle",
    to: { name: "recycle-bin" },
    icon: "trash",
    title: "回收站",
    desc: "已删除的班级与学生先落在这里，保留期内可随时恢复。",
  },
  {
    key: "settings",
    to: { name: "settings" },
    icon: "gear",
    title: "数据与设置",
    desc: "AI 模型方案、必应壁纸、运行环境与数据清空等本机设置。",
  },
] as const;
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">设置中心</h1>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="max-w-[880px]">
      <p class="text-caption text-weak">日常教学用不到的都在这里 · 改完点侧栏「返回教学」即可回到业务</p>

      <div class="mt-5 grid grid-cols-3 gap-4">
        <RouterLink
          v-for="e in entries"
          :key="e.key"
          :to="e.to"
          :data-test="`hub-${e.key}`"
          class="rounded-lg border border-hairline bg-canvas p-5 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(29,29,31,0.07)]"
        >
          <span
            class="flex h-9 w-9 items-center justify-center rounded-sm border border-hairline bg-pearl text-muted"
          >
            <AppIcon :name="e.icon" :size="16" />
          </span>
          <h3 class="mt-3 text-body font-semibold text-ink">{{ e.title }}</h3>
          <p class="mt-1.5 text-caption leading-relaxed text-weak">{{ e.desc }}</p>
          <span class="mt-3 inline-flex items-center gap-0.5 text-caption font-medium text-primary">
            进入
            <AppIcon name="chevron-right" :size="12" />
          </span>
        </RouterLink>
      </div>
    </div>
  </div>
</template>
