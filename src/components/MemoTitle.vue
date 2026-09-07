<script setup lang="ts">
/**
 * 备忘快速浏览标题：
 * - 有 AI 总结标题（event.title）显示标题，未配置 AI 退回全文前几个字（eventQuickTitle）
 * - 悬浮标题 → 原生 tooltip 查看全文；点击标题 → 弹出悬浮卡片展示全文
 * - 完成态（划线）与筛选置灰等颜色状态由父级行控制，本组件只负责标题与弹卡
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { CALENDAR_EVENT_META, eventQuickTitle } from "../lib/timetable";
import type { CalendarEvent } from "../types";

const props = withDefaults(defineProps<{ event: CalendarEvent; align?: "left" | "right" }>(), {
  align: "left",
});

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const titleText = computed(() => eventQuickTitle(props.event));
const typeLabel = computed(() => CALENDAR_EVENT_META[props.event.type]?.label ?? props.event.type);
const typeDot = computed(() => CALENDAR_EVENT_META[props.event.type]?.dot ?? "bg-stone-400");

function toggle() {
  open.value = !open.value;
}

function onDocMouseDown(e: MouseEvent) {
  if (!open.value) return;
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocMouseDown));
</script>

<template>
  <span ref="root" class="relative block min-w-0">
    <button
      type="button"
      data-test="memo-title"
      class="block w-full min-w-0 truncate text-left"
      :title="props.event.content"
      @click.stop="toggle"
    >
      {{ titleText }}
    </button>
    <!-- 悬浮卡片：展示全文（点标题切换，点外面收起） -->
    <span
      v-if="open"
      data-test="memo-pop"
      class="absolute top-full z-30 mt-1 block w-48 rounded-md border border-hairline bg-canvas p-2 text-left shadow-lg"
      :class="props.align === 'right' ? 'right-0' : 'left-0'"
      @click.stop
    >
      <span class="flex items-center gap-1 text-fine text-weak">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="typeDot" />
        <span>{{ typeLabel }} · {{ props.event.event_date.slice(5) }}</span>
        <span v-if="props.event.class_name" class="min-w-0 truncate">{{ props.event.class_name }}</span>
      </span>
      <span class="mt-1 block whitespace-pre-wrap break-words text-fine text-ink">
        {{ props.event.content }}
      </span>
    </span>
  </span>
</template>
