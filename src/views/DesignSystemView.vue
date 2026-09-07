<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import AppInput from "../components/ui/AppInput.vue";
import AppLink from "../components/ui/AppLink.vue";
import { ref } from "vue";

const swatches = [
  { name: "Primary", hex: "#0066cc", cls: "bg-primary" },
  { name: "Primary Focus", hex: "#0071e3", cls: "bg-primary-focus" },
  { name: "Link On Dark", hex: "#2997ff", cls: "bg-primary-on-dark" },
  { name: "Ink", hex: "#1d1d1f", cls: "bg-ink" },
  { name: "Muted", hex: "#333333", cls: "bg-muted" },
  { name: "Weak", hex: "#7a7a7a", cls: "bg-weak" },
  { name: "Hairline", hex: "#e0e0e0", cls: "bg-hairline" },
  { name: "Parchment", hex: "#f5f5f7", cls: "bg-parchment" },
];

const radii = [
  { label: "rounded-sm", value: "8px", cls: "rounded-sm" },
  { label: "rounded-md", value: "11px", cls: "rounded-md" },
  { label: "rounded-lg", value: "18px", cls: "rounded-lg" },
  { label: "rounded-pill", value: "9999px", cls: "rounded-pill" },
];

const search = ref("");
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">设计系统</h1>
    <span class="text-fine text-weak">Tauri + Vue + Tailwind v4 · 1440 × 900</span>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="max-w-[1200px] space-y-12">
      <!-- 颜色 -->
      <section class="space-y-5">
        <h2 class="text-tagline font-semibold text-ink">颜色</h2>
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(152px, 1fr))">
          <div v-for="s in swatches" :key="s.hex" class="space-y-2">
            <div class="h-14 rounded-sm" :class="s.cls" />
            <p class="text-fine font-semibold text-ink">{{ s.name }}</p>
            <p class="text-fine text-weak">{{ s.hex }}</p>
          </div>
        </div>
        <p class="text-fine text-weak">
          全站只有一个交互色 Primary；其余变化靠 Ink / Muted / Weak 三级灰和底色分层完成。
        </p>
      </section>

      <!-- 字体 -->
      <section class="space-y-4">
        <h2 class="text-tagline font-semibold text-ink">字体</h2>
        <div class="space-y-3">
          <p class="text-hero font-semibold text-ink">Hero · 40 / 600 / -0.4px</p>
          <p class="text-display font-semibold text-ink">Display · 34 / 600 / -0.37px</p>
          <p class="text-stat font-semibold text-ink">Stat · 28 / 600 / -0.3px</p>
          <p class="text-tagline font-semibold text-ink">Tagline · 21 / 600 / +0.23px</p>
          <p class="text-body text-ink">Body · 17 / 400 / 1.47 —— 正文比常见的 16px 高一档，读起来更从容。</p>
          <p class="text-caption text-muted">Caption · 14 / 400 —— 表格、按钮、次要说明。</p>
          <p class="text-fine text-weak">Fine Print · 12 / 400 —— 标签、时间戳、脚注。</p>
        </div>
      </section>

      <!-- 组件 -->
      <section class="space-y-5">
        <h2 class="text-tagline font-semibold text-ink">组件</h2>
        <div class="flex flex-wrap items-center gap-3">
          <AppButton>新建学生</AppButton>
          <AppButton variant="secondary">编辑档案</AppButton>
          <AppButton variant="pearl">导出 CSV</AppButton>
          <AppButton variant="dark">备份数据库</AppButton>
          <AppButton variant="danger">删除学生</AppButton>
          <AppButton variant="link">查看全部图片</AppButton>
        </div>
        <AppInput v-model="search" placeholder="搜索姓名或学号" />
        <!-- 跳转 = chip 胶囊按钮（悬浮底色浮出、箭头平移）；原地动作 = action 轻文字 -->
        <div class="flex flex-wrap items-center gap-3">
          <AppLink to="/home" class="font-medium">查看全部图片</AppLink>
          <AppLink to="/home" icon="back" size="sm">返回</AppLink>
          <AppLink tone="onDark" to="/home">深色底</AppLink>
          <AppLink tone="onDarkSolid" to="/home" class="font-medium">深色底主按钮</AppLink>
          <AppLink tone="danger" variant="action" class="text-fine">清空</AppLink>
          <AppLink variant="action" class="text-fine">＋ 添加节次</AppLink>
        </div>
      </section>

      <!-- 圆角与阴影 -->
      <section class="space-y-5">
        <h2 class="text-tagline font-semibold text-ink">圆角与阴影</h2>
        <div class="flex flex-wrap gap-4">
          <div
            v-for="r in radii"
            :key="r.label"
            class="flex h-[72px] w-[120px] items-center justify-center border border-hairline bg-pearl text-fine text-weak"
            :class="r.cls"
          >
            {{ r.value }}
          </div>
        </div>
        <p class="max-w-[720px] text-caption leading-[22px] text-weak">
          全系统只有一处投影：<code class="text-muted">3px 5px 30px rgba(0,0,0,.22)</code>，只作用于图片与窗口。
          卡片、按钮、文字一律不加阴影 —— 层级靠底色切换（白 / 浅灰 #f5f5f7 / 深色 #272729）与 1px 发丝线表达。
        </p>
      </section>
    </div>
  </div>
</template>
