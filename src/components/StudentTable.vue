<script setup lang="ts">
import { ref } from "vue";
import type { BehaviorPolarity, StudentRow } from "../types";
import { formatShort } from "../lib/format";
import QuickBehaviorPopover from "./QuickBehaviorPopover.vue";
import { useToast } from "../composables/useToast";

withDefaults(
  defineProps<{ rows: StudentRow[]; readonly?: boolean }>(),
  { readonly: false }
);
const emit = defineEmits<{
  open: [row: StudentRow];
  /** 表格内快捷记表现保存成功，供父组件局部刷新表现数据 */
  saved: [payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }];
}>();

const COLS = "180px 140px 160px 170px 120px 160px max-content 1fr";

/* ---------------- 快捷表现卡片 + 全局轻反馈 ---------------- */
const quickStudent = ref<StudentRow | null>(null);
const quickAnchor = ref<{ x: number; y: number } | null>(null);
/** 全局轻反馈（ToastHost 挂在 App.vue）：快捷记表现保存成功提示 */
const toast = useToast();

function openQuick(row: StudentRow, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  quickStudent.value = row;
  quickAnchor.value = { x: rect.right, y: rect.bottom + 6 };
}

function onQuickSaved(payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }) {
  toast(`已记录 ${payload.studentName} ${payload.dimensionName}`);
  // 上抛给父组件刷新表现计数/时间轴（不整页刷新）
  emit("saved", payload);
}

function closeQuick() {
  quickStudent.value = null;
}
</script>

<template>
  <div>
    <!-- 小屏不隐藏列：表格保持完整列宽，横向滚动查看全部字段与操作 -->
    <div class="scroll-thin overflow-x-auto rounded-lg border border-hairline bg-canvas">
      <div class="min-w-max">
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
            v-if="!readonly"
            data-test="quick-record-btn"
            class="whitespace-nowrap rounded-full bg-primary-soft px-3 py-1 text-fine font-medium text-primary transition-colors hover:bg-primary hover:text-white"
            @click="openQuick(row, $event)"
          >
            + 记表现
          </button>
          <span
            data-test="view-btn"
            class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap rounded-pill grad-border px-2.5 text-fine font-medium text-primary transition-[box-shadow] hover:shadow-[var(--shadow-halo)]"
            @click="emit('open', row)"
          >
            查看
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </div>
        <span />
      </div>
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
  </div>
</template>
