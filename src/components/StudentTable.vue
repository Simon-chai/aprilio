<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { BehaviorPolarity, StudentRow } from "../types";
import { formatShort } from "../lib/format";
import QuickBehaviorPopover from "./QuickBehaviorPopover.vue";

defineProps<{ rows: StudentRow[] }>();
const emit = defineEmits<{
  open: [row: StudentRow];
  /** 表格内快捷记表现保存成功，供父组件局部刷新表现数据 */
  saved: [payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }];
}>();

const COLS = "180px 140px 160px 170px 120px 160px 120px 1fr";

/* ---------------- 快捷表现卡片 + 轻量 Toast ---------------- */
const quickStudent = ref<StudentRow | null>(null);
const quickAnchor = ref<{ x: number; y: number } | null>(null);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function openQuick(row: StudentRow, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  quickStudent.value = row;
  quickAnchor.value = { x: rect.right, y: rect.bottom + 6 };
}

function onQuickSaved(payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }) {
  toast.value = `已记录 ${payload.studentName} ${payload.dimensionName}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2400);
  // 上抛给父组件刷新表现计数/时间轴（不整页刷新）
  emit("saved", payload);
}

function closeQuick() {
  quickStudent.value = null;
}

onBeforeUnmount(() => clearTimeout(toastTimer));
</script>

<template>
  <div>
    <div class="overflow-hidden rounded-lg border border-hairline bg-canvas">
      <!-- 表头 -->
      <div
        class="grid h-11 items-center border-b border-hairline bg-pearl px-5 text-fine text-weak"
        :style="{ gridTemplateColumns: COLS }"
      >
        <span>姓名</span>
        <span>学号</span>
        <span>年级班级</span>
        <span>联系电话</span>
        <span>图片记录</span>
        <span>更新时间</span>
        <span>操作</span>
        <span />
      </div>

      <!-- 数据行 -->
      <div
        v-for="row in rows"
        :key="row.id"
        class="grid h-[52px] cursor-pointer items-center border-b border-divider px-5 text-caption transition-colors last:border-b-0 hover:bg-parchment"
        :style="{ gridTemplateColumns: COLS }"
        @click="emit('open', row)"
      >
        <span class="font-semibold text-ink">{{ row.name }}</span>
        <span class="text-muted">{{ row.student_no }}</span>
        <span class="text-muted">{{ row.grade_class }}</span>
        <span class="text-muted truncate">
          {{ row.primary_phone ?? "—" }}
          <span v-if="row.primary_relation" class="text-fine text-weak ml-1">
            ({{ row.primary_relation }})
          </span>
        </span>
        <span class="text-muted">{{ row.photo_count }} 张</span>
        <span class="text-weak">{{ formatShort(row.updated_at) }}</span>
        <!-- 双操作单元：阻断冒泡，避免触发整行跳详情 -->
        <div class="flex items-center gap-3" @click.stop>
          <button
            data-test="quick-record-btn"
            class="rounded-full bg-primary-soft px-3 py-1 text-fine font-medium text-primary transition-colors hover:bg-primary hover:text-white"
            @click="openQuick(row, $event)"
          >
            + 记表现
          </button>
          <span data-test="view-btn" class="cursor-pointer text-weak hover:text-ink" @click="emit('open', row)">查看</span>
        </div>
        <span />
      </div>
    </div>

    <!-- 快捷表现卡片（Teleport 到 body） -->
    <QuickBehaviorPopover
      :open="quickStudent !== null"
      :student="quickStudent"
      :anchor="quickAnchor"
      @close="closeQuick"
      @saved="onQuickSaved"
    />

    <!-- 列表顶部微型 Toast -->
    <Transition name="qb-toast">
      <div
        v-if="toast"
        data-test="quick-toast"
        class="fixed inset-x-0 top-4 z-[60] mx-auto w-fit rounded-full bg-tile px-4 py-1.5 text-fine text-white shadow-lg"
      >
        {{ toast }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.qb-toast-enter-active,
.qb-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.qb-toast-enter-from,
.qb-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
