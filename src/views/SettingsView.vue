<script setup lang="ts">
import { onMounted, ref } from "vue";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import { clearAll, getStats, isTauri } from "../lib/db";
import { getPhotosDir } from "../lib/photos";
import type { Stats } from "../types";

const photosDir = ref("");
const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });

async function refresh() {
  photosDir.value = await getPhotosDir();
  stats.value = await getStats();
}

onMounted(refresh);

async function onClear() {
  const ok = window.confirm("将清空全部学生与图片记录，且无法撤销。确认继续？");
  if (!ok) return;
  await clearAll();
  await refresh();
}
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">数据与设置</h1>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="max-w-[720px] space-y-5">
      <AppCard>
        <h3 class="mb-4 text-body font-semibold text-ink">运行环境</h3>
        <dl class="space-y-3">
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">运行模式</dt>
            <dd class="text-caption text-ink">
              {{ isTauri() ? "Tauri 桌面端（本地 SQLite）" : "浏览器预览（内存示例数据）" }}
            </dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">数据库</dt>
            <dd class="text-caption text-ink">sqlite:aprilio.db</dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">学生 / 图片</dt>
            <dd class="text-caption text-ink">{{ stats.students }} 条 / {{ stats.photos }} 张</dd>
          </div>
          <div class="flex items-start justify-between">
            <dt class="text-fine text-weak">图片目录</dt>
            <dd class="max-w-[420px] break-all text-right text-caption text-muted">
              {{ photosDir || "（仅 Tauri 外壳内可用）" }}
            </dd>
          </div>
        </dl>
      </AppCard>

      <AppCard>
        <h3 class="mb-1 text-body font-semibold text-ink">清空数据</h3>
        <p class="mb-4 text-caption text-weak">删除所有学生与图片记录，操作不可撤销。</p>
        <AppButton variant="danger" @click="onClear">清空全部数据</AppButton>
      </AppCard>
    </div>
  </div>
</template>
