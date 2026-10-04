<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import AppIcon from "./ui/AppIcon.vue";
import type { StudentBehaviorRecord } from "../types";
import { confirmAction } from "../composables/useConfirm";
import { useBehaviorFilters } from "../composables/useBehaviorFilters";

const props = defineProps<{
  records: StudentBehaviorRecord[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  add: [];
  remove: [recordId: number];
  /** 右键菜单「编辑」：上抛整条记录与菜单弹出坐标（用作编辑卡片锚点） */
  edit: [record: StudentBehaviorRecord, anchor: { x: number; y: number } | null];
}>();

/** 删除评语所在的表现记录：全局确认弹层（armed 两步模式已退役） */
async function onRemoveClick(recordId: number) {
  const ok = await confirmAction({
    title: "删除这条表现记录？",
    message: "删除后不可恢复。",
    tone: "danger",
    confirmText: "删除",
  });
  if (ok) emit("remove", recordId);
}

/* ---------------- 条目右键菜单：编辑 / 删除 ----------------
 * 收起口径与课表格子备忘浮层一致：Esc、点空白、右键其他位置、滚动。
 * 菜单挂在条目上弹出（Teleport 到 body 定宽小卡），右键其他条目时切换归属。 */
const menu = ref<{ x: number; y: number; record: StudentBehaviorRecord } | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const MENU_SIZE = { w: 128, h: 92, margin: 8 };

function openContextMenu(e: MouseEvent, record: StudentBehaviorRecord) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.value = {
    x: Math.max(MENU_SIZE.margin, Math.min(e.clientX, vw - MENU_SIZE.w - MENU_SIZE.margin)),
    y: Math.max(MENU_SIZE.margin, Math.min(e.clientY, vh - MENU_SIZE.h - MENU_SIZE.margin)),
    record,
  };
  document.addEventListener("mousedown", onMenuOutsideMousedown);
  document.addEventListener("keydown", onMenuEscKey);
  document.addEventListener("contextmenu", onDocContextmenu);
  document.addEventListener("scroll", onDocScroll, true);
}

function closeMenu() {
  if (!menu.value) return;
  menu.value = null;
  document.removeEventListener("mousedown", onMenuOutsideMousedown);
  document.removeEventListener("keydown", onMenuEscKey);
  document.removeEventListener("contextmenu", onDocContextmenu);
  document.removeEventListener("scroll", onDocScroll, true);
}

function onMenuOutsideMousedown(e: MouseEvent) {
  if (menuEl.value && e.target instanceof Node && menuEl.value.contains(e.target)) return;
  closeMenu();
}

function onMenuEscKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeMenu();
}

/** 右键其他位置：收起本菜单（落在条目上时由条目自身接管切换，不会走到这里） */
function onDocContextmenu() {
  closeMenu();
}

function onDocScroll() {
  closeMenu();
}

onBeforeUnmount(closeMenu);

function onMenuEdit() {
  const record = menu.value?.record;
  const anchor = menu.value ? { x: menu.value.x, y: menu.value.y } : null;
  closeMenu();
  if (record) emit("edit", record, anchor);
}

async function onMenuDelete() {
  const record = menu.value?.record;
  closeMenu();
  if (record) await onRemoveClick(record.id);
}

/** 筛选与分组：倾向 + 维度（共享逻辑，见 useBehaviorFilters） */
const {
  selectedPolarity,
  selectedDimension,
  availableDimensions,
  polarityCounts: stats,
  filteredRecords,
  groupedRecords,
} =
  useBehaviorFilters<StudentBehaviorRecord>(() => props.records);
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 筛选控制栏：窄容器保持单行，横向滚动查看 -->
    <div v-if="records.length > 0" class="scrollbar-none flex items-center justify-between gap-3 overflow-x-auto border-b border-divider pb-3">
      <!-- 倾向过滤胶囊 -->
      <div class="flex shrink-0 items-center gap-1.5 text-fine">
        <button
          data-test="filter-all"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'all' ? 'bg-primary text-white' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'all'"
        >
          全部 ({{ stats.all }})
        </button>
        <button
          data-test="filter-praise"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'praise' ? 'bg-praise-soft text-praise border border-praise-line' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'praise'"
        >
          👍 表扬 ({{ stats.praise }})
        </button>
        <button
          data-test="filter-improve"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'improve' ? 'bg-improve-soft text-improve border border-improve-line' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'improve'"
        >
          ⚠️ 待改进 ({{ stats.improve }})
        </button>
        <button
          v-if="stats.neutral > 0"
          data-test="filter-neutral"
          type="button"
          class="rounded-full px-3 py-1 transition-colors font-medium"
          :class="selectedPolarity === 'neutral' ? 'bg-neutral-soft text-neutral border border-neutral-line' : 'bg-parchment text-weak hover:text-ink'"
          @click="selectedPolarity = 'neutral'"
        >
          ➖ 中立 ({{ stats.neutral }})
        </button>
      </div>

      <!-- 维度过滤下拉 -->
      <div v-if="availableDimensions.length > 1" class="flex shrink-0 items-center gap-2">
        <span class="text-fine text-weak">维度：</span>
        <select
          data-test="dimension-select"
          v-model="selectedDimension"
          class="h-7 rounded-md border border-hairline bg-canvas px-2 text-fine text-ink focus:border-primary focus:outline-none"
        >
          <option value="all">全部事项</option>
          <option v-for="dim in availableDimensions" :key="dim" :value="dim">
            {{ dim }}
          </option>
        </select>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="py-12 text-center text-caption text-weak">
      加载日常表现…
    </div>

    <!-- 空状态：一条记录都没有 -->
    <div
      v-else-if="records.length === 0"
      class="flex flex-col items-center justify-center py-12 text-center"
    >
      <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-parchment text-weak">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </div>
      <p class="text-body font-medium text-ink">暂无日常表现记录</p>
      <p class="mt-1 text-fine text-weak">
        可点击右上角或下方按钮，为该学生快速记录课堂表现、作业情况等。
      </p>
      <button
        data-test="empty-add-btn"
        type="button"
        class="mt-4 rounded-full bg-primary px-4 py-1.5 text-caption font-medium text-white transition-opacity hover:opacity-90"
        @click="emit('add')"
      >
        + 记表现
      </button>
    </div>

    <!-- 筛选后无结果 -->
    <div
      v-else-if="filteredRecords.length === 0"
      class="py-10 text-center text-caption text-weak"
    >
      没有符合筛选条件的表现记录
    </div>

    <!-- 时间线列表 -->
    <div v-else class="space-y-6">
      <div
        v-for="group in groupedRecords"
        :key="group.date"
        class="relative pl-6"
      >
        <!-- 时间轴纵向发丝基线 -->
        <div class="absolute bottom-0 left-2 top-2 w-[1.5px] bg-hairline" />

        <!-- 日期标记 -->
        <div class="mb-3 flex items-center gap-2">
          <span
            data-test="timeline-date"
            class="rounded-full bg-parchment px-2.5 py-0.5 text-[11px] font-semibold text-muted"
          >
            {{ group.date }}
          </span>
          <span class="text-[11px] text-faint">
            {{ group.items.length }} 项表现
          </span>
        </div>

        <!-- 当天流水事项 -->
        <div class="space-y-2.5">
          <div
            v-for="item in group.items"
            :key="item.id"
            data-test="timeline-item"
            class="group relative flex items-start gap-3 rounded-lg border border-divider bg-canvas p-3.5 transition-colors hover:border-hairline hover:bg-parchment/40"
            title="右键可编辑 / 删除"
            @contextmenu.prevent.stop="openContextMenu($event, item)"
          >
            <!-- 节点圆点锚定在时间线上 -->
            <div
              class="absolute -left-[19px] top-5 flex h-2.5 w-2.5 items-center justify-center rounded-full ring-4 ring-canvas"
              :class="item.type === 'praise' ? 'bg-praise' : item.type === 'improve' ? 'bg-improve' : 'bg-neutral'"
            />

            <!-- 内容区：单行布局（徽标/徽章/时间戳不换行不竖排），具体评语收进语义图标的悬浮说明 -->
            <div class="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
              <!-- 维度微胶囊 -->
              <span class="rounded bg-parchment px-2 py-0.5 text-fine font-medium text-ink">
                {{ item.dimension_name_snap }}
              </span>
              <!-- 倾向徽章 -->
              <span
                class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                :class="item.type === 'praise' ? 'bg-praise-soft text-praise' : item.type === 'improve' ? 'bg-improve-soft text-improve' : 'bg-neutral-soft text-neutral'"
              >
                {{ item.type === "praise" ? "👍 表扬" : item.type === "improve" ? "⚠️ 待改进" : "➖ 中立" }}
              </span>

              <!-- 评语语义图标：悬浮显示具体评语，删除走全局确认弹层 -->
              <span
                v-if="item.comment"
                class="group/comment relative inline-flex"
              >
                <button
                  type="button"
                  class="inline-flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:text-primary"
                  aria-label="查看评语"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
                <!-- 外层负责定位与悬浮桥接（padding 消除移动鼠标时的空隙），内层负责视觉 -->
                <span
                  role="tooltip"
                  class="pointer-events-none absolute bottom-full left-1/2 z-10 -translate-x-1/2 pb-1.5 opacity-0 transition-opacity duration-150 group-hover/comment:pointer-events-auto group-hover/comment:opacity-100 group-focus-within/comment:pointer-events-auto group-focus-within/comment:opacity-100"
                >
                  <span class="block w-max max-w-[280px] rounded-sm bg-tile px-2.5 py-1.5 text-left text-fine leading-relaxed text-white shadow-md">
                    <span class="block whitespace-pre-wrap">{{ item.comment }}</span>
                    <span class="mt-1 flex items-center justify-end border-t border-white/15 pt-1">
                      <button
                        type="button"
                        data-test="comment-delete-btn"
                        class="rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors text-white/70 hover:bg-white/10 hover:text-white"
                        @click.stop="onRemoveClick(item.id)"
                      >
                        删除
                      </button>
                    </span>
                  </span>
                </span>
              </span>

              <!-- 时间戳 -->
              <span class="ml-auto shrink-0 text-[11px] text-weak">
                {{ item.created_at.slice(11, 16) || "" }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 条目右键菜单：编辑 / 删除（Teleport 到 body，固定定位跟随右键坐标） -->
    <Teleport to="body">
      <div
        v-if="menu"
        ref="menuEl"
        data-test="item-context-menu"
        class="fixed z-[60] min-w-[128px] rounded-md border border-hairline bg-canvas py-1 shadow-[var(--shadow-window)]"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @contextmenu.prevent
      >
        <button
          type="button"
          data-test="menu-edit"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-caption text-ink transition-colors hover:bg-parchment"
          @click="onMenuEdit"
        >
          <AppIcon name="edit" :size="13" class="shrink-0 text-weak" />
          编辑
        </button>
        <button
          type="button"
          data-test="menu-delete"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-caption text-danger transition-colors hover:bg-danger-soft"
          @click="onMenuDelete"
        >
          <AppIcon name="trash" :size="13" class="shrink-0" />
          删除
        </button>
      </div>
    </Teleport>
  </div>
</template>
