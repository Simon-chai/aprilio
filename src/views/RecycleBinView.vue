<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { confirm } from "@tauri-apps/plugin-dialog";
import AppButton from "../components/ui/AppButton.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import {
  clearRecycleBin,
  isTauri,
  listRecycleItems,
  purgeRecycleItem,
  recycleRemainingDays,
  restoreRecycleItem,
} from "../lib/db";
import { formatShort } from "../lib/format";
import type { ClassSnapshot, RecycleItem } from "../types";
import { RECYCLE_RETENTION_DAYS } from "../types";

/** 桌面端走原生确认框，浏览器演示态退回 window.confirm */
async function ask(message: string, title: string): Promise<boolean> {
  return isTauri()
    ? confirm(message, { title, kind: "warning" })
    : window.confirm(message);
}

const items = ref<RecycleItem[]>([]);
const loading = ref(true);
const error = ref("");
const busyId = ref<number | null>(null);

const classCount = computed(() => items.value.filter((i) => i.entity_type === "class").length);
const studentCount = computed(() => items.value.filter((i) => i.entity_type === "student").length);

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    items.value = await listRecycleItems();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

/** 恢复条目：班级整体 / 学生档案重新入库 */
async function onRestore(item: RecycleItem) {
  busyId.value = item.id;
  try {
    await restoreRecycleItem(item.id);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
  }
}

/** 彻底删除：快照与落盘图片一并清除，不可恢复 */
async function onPurge(item: RecycleItem) {
  const ok = await ask(`彻底删除「${item.label}」？快照与图片文件将一并清除，不可恢复。`, "彻底删除");
  if (!ok) return;
  busyId.value = item.id;
  try {
    await purgeRecycleItem(item.id);
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
  }
}

/** 清空回收站 */
async function onClearAll() {
  const ok = await ask("清空回收站？所有快照与图片文件将彻底删除，不可恢复。", "清空回收站");
  if (!ok) return;
  try {
    await clearRecycleBin();
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function asClassSnapshot(item: RecycleItem): ClassSnapshot {
  return item.payload as ClassSnapshot;
}

/** 班级条目备注：恢复时整班学生与照片一起回来 */
function classHint(item: RecycleItem): string {
  const snap = asClassSnapshot(item);
  return snap.students.length
    ? `恢复时 ${snap.students.length} 名学生与照片将一并还原`
    : "空班级，恢复后可重新导入学生";
}
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <div class="flex items-baseline gap-3">
      <h1 class="text-tagline font-semibold text-ink">回收站</h1>
      <span class="text-fine text-weak">删除的班级与学生保留 {{ RECYCLE_RETENTION_DAYS }} 天，过期自动彻底删除</span>
    </div>
    <AppButton
      v-if="items.length"
      variant="danger"
      data-test="clear-recycle-btn"
      @click="onClearAll"
    >
      清空回收站
    </AppButton>
  </header>

  <!-- 内容 -->
  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="max-w-[860px] space-y-5">
      <p v-if="error" class="rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
        {{ error }}
      </p>

      <div class="flex gap-5">
        <div class="flex-1 rounded-lg border border-hairline bg-canvas p-5">
          <p class="text-fine text-weak">待恢复班级</p>
          <p class="mt-1.5 text-stat font-semibold text-ink">{{ classCount }}</p>
        </div>
        <div class="flex-1 rounded-lg border border-hairline bg-canvas p-5">
          <p class="text-fine text-weak">待恢复学生</p>
          <p class="mt-1.5 text-stat font-semibold text-ink">{{ studentCount }}</p>
        </div>
        <div class="flex-1 rounded-lg border border-hairline bg-canvas p-5">
          <p class="text-fine text-weak">保留期限</p>
          <p class="mt-1.5 text-stat font-semibold text-ink">{{ RECYCLE_RETENTION_DAYS }} 天</p>
        </div>
      </div>

      <div
        v-for="item in items"
        :key="item.id"
        data-test="recycle-item"
        class="flex items-center gap-4 rounded-lg border border-hairline bg-canvas p-5"
      >
        <!-- 类型图标 -->
        <div
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-parchment"
          :title="item.entity_type === 'class' ? '班级' : '学生'"
        >
          <!-- 班级：讲台板书 -->
          <svg v-if="item.entity_type === 'class'" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="4" y="7" width="16" height="13" rx="2" stroke="#0066cc" stroke-width="1.8" />
            <path d="M12 7V4.5M12 4.5l7 2.5-7 2.5L5 7l7-2.5z" stroke="#0066cc" stroke-width="1.8" stroke-linejoin="round" />
          </svg>
          <!-- 学生：头像 -->
          <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="8.5" r="4" fill="#0066cc" opacity="0.85" />
            <path d="M4 20c0-4 3.6-6.4 8-6.4s8 2.4 8 6.4" fill="#0066cc" opacity="0.85" />
          </svg>
        </div>

        <!-- 主体信息 -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-caption font-semibold text-ink">{{ item.label }}</span>
            <span class="rounded-pill bg-parchment px-2 py-0.5 text-[11px] text-weak">
              {{ item.entity_type === "class" ? "班级" : "学生" }}
            </span>
          </div>
          <p class="mt-1 truncate text-fine text-weak">
            {{ item.summary }}
          </p>
          <p class="mt-0.5 text-fine text-faint">
            {{ item.entity_type === "class" ? classHint(item) : "恢复后学生档案与照片一并还原" }}
          </p>
          <p class="mt-0.5 text-fine text-faint">
            删除于 {{ formatShort(item.deleted_at) }} ·
            <span data-test="remaining-days">剩 {{ recycleRemainingDays(item) }} 天</span>
          </p>
        </div>

        <!-- 操作 -->
        <div class="flex shrink-0 items-center gap-3">
          <AppButton
            variant="secondary"
            data-test="restore-btn"
            :disabled="busyId === item.id"
            @click="onRestore(item)"
          >
            恢复
          </AppButton>
          <AppButton
            variant="danger"
            data-test="purge-btn"
            :disabled="busyId === item.id"
            @click="onPurge(item)"
          >
            彻底删除
          </AppButton>
        </div>
      </div>

      <EmptyState
        v-if="!loading && !items.length"
        title="回收站是空的"
        :description="`删除的班级与学生会在这里保留 ${RECYCLE_RETENTION_DAYS} 天，期间可随时恢复。`"
      />
      <p v-else-if="loading" class="py-6 text-center text-caption text-weak">加载中…</p>
    </div>
  </div>
</template>
