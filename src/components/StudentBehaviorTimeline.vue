<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BehaviorPolarity, StudentBehaviorRecord } from "../types";
import { confirmAction } from "../composables/useConfirm";

const props = defineProps<{
  records: StudentBehaviorRecord[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  add: [];
  remove: [recordId: number];
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

const selectedPolarity = ref<"all" | BehaviorPolarity>("all");
const selectedDimension = ref<string>("all");

// 提取所有已存在的维度供下拉选择
const availableDimensions = computed(() => {
  const set = new Set<string>();
  for (const r of props.records) {
    if (r.dimension_name_snap) set.add(r.dimension_name_snap);
  }
  return Array.from(set);
});

watch(availableDimensions, (dims) => {
  if (selectedDimension.value !== "all" && !dims.includes(selectedDimension.value)) {
    selectedDimension.value = "all";
  }
});

// 统计各倾向数量
const stats = computed(() => {
  let praise = 0;
  let improve = 0;
  let neutral = 0;
  for (const r of props.records) {
    if (r.type === "praise") praise++;
    else if (r.type === "improve") improve++;
    else if (r.type === "neutral") neutral++;
  }
  return { all: props.records.length, praise, improve, neutral };
});

// 过滤后的列表
const filteredRecords = computed(() => {
  return props.records.filter((r) => {
    if (selectedPolarity.value !== "all" && r.type !== selectedPolarity.value) {
      return false;
    }
    if (selectedDimension.value !== "all" && r.dimension_name_snap !== selectedDimension.value) {
      return false;
    }
    return true;
  });
});

// 按 recorded_date 倒序分组
interface DateGroup {
  date: string;
  items: StudentBehaviorRecord[];
}

const groupedRecords = computed<DateGroup[]>(() => {
  const map = new Map<string, StudentBehaviorRecord[]>();
  for (const r of filteredRecords.value) {
    const date = r.recorded_date || r.created_at.slice(0, 10);
    const list = map.get(date) ?? [];
    list.push(r);
    map.set(date, list);
  }
  return Array.from(map.entries())
    .sort(([dateA], [dateB]) => (dateA < dateB ? 1 : -1))
    .map(([date, items]) => ({
      date,
      items: items.sort((a, b) => b.id - a.id),
    }));
});
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
  </div>
</template>
