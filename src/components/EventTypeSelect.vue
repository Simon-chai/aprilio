<script setup lang="ts">
/**
 * 备忘类型下拉选择：文本输入栏前的类型绑定入口。
 *
 * - 触发钮与菜单项都只放颜色小圆，宽度刚好容纳指示器、不放文字
 * - 类型文案用悬浮小卡片展示（teleport 到 body 的 fixed 深色 tooltip）：
 *   悬浮触发钮显示当前类型、悬浮菜单项显示对应类型
 * - 选中即绑定：写回 v-model，编辑器 placeholder 等文案随之联动
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { CALENDAR_EVENT_META, CALENDAR_EVENT_TYPES } from "../lib/timetable";
import type { CalendarEventType } from "../types";

const props = defineProps<{ modelValue: CalendarEventType }>();
const emit = defineEmits<{ "update:modelValue": [value: CalendarEventType] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

/** 下拉菜单 fixed 坐标（teleport 到 body，避免被格子编辑器溢出裁剪） */
const menuPos = ref({ left: 0, top: 0 });
/** 悬浮小卡片：单例状态；flip = 指示器贴近视口右缘时改显示在左侧 */
const tip = ref<{ text: string; left: number; top: number; flip: boolean } | null>(null);

const meta = (type: CalendarEventType) => CALENDAR_EVENT_META[type];

const MENU_W = 32; // 菜单宽 w-8（32px）
const MENU_H = 116; // 菜单估算高：4 × (24px 项 + 2px 间距) + 8px 上下内边距
const TIP_GAP = 8;

function showTip(text: string, e: MouseEvent) {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const flip = r.right + TIP_GAP + 80 > window.innerWidth;
  tip.value = {
    text,
    left: flip ? r.left - TIP_GAP : r.right + TIP_GAP,
    top: r.top + r.height / 2,
    flip,
  };
}

function hideTip() {
  tip.value = null;
}

async function toggleMenu() {
  open.value = !open.value;
  if (!open.value) return;
  hideTip();
  await nextTick();
  const r = triggerEl.value?.getBoundingClientRect();
  if (!r) return;
  // 默认贴着触发钮左对齐往下弹；右缘/下缘空间不足时向左/向上收
  menuPos.value = {
    left: r.left + MENU_W > window.innerWidth ? r.right - MENU_W : r.left,
    top: r.bottom + MENU_H + 4 > window.innerHeight ? r.top - MENU_H - 4 : r.bottom + 4,
  };
}

function choose(type: CalendarEventType) {
  emit("update:modelValue", type);
  open.value = false;
  hideTip();
}

function onDocMouseDown(e: MouseEvent) {
  const target = e.target as Node;
  if (menuEl.value?.contains(target)) return; // 点菜单项交给 click 收尾
  if (!root.value?.contains(target)) {
    open.value = false;
    hideTip();
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    open.value = false;
    hideTip();
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMouseDown);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <span ref="root" class="relative shrink-0">
    <button
      ref="triggerEl"
      type="button"
      data-test="event-type-select"
      class="flex h-7 w-5 items-center justify-center rounded-sm border border-hairline bg-canvas transition-colors hover:border-primary"
      :aria-label="`备忘类型：${meta(props.modelValue).label}`"
      :aria-expanded="open"
      @click="toggleMenu"
      @mouseenter="showTip(meta(props.modelValue).label, $event)"
      @mouseleave="hideTip"
    >
      <span class="h-2 w-2 rounded-full" :class="meta(props.modelValue).dot" />
    </button>
  </span>

  <!-- 菜单与悬浮卡片 teleport 到 body：格子编辑器空间小，固定定位避免被裁剪 -->
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      data-test="event-type-menu"
      class="fixed z-50 flex w-8 flex-col items-center gap-0.5 rounded-md border border-hairline bg-canvas p-1 shadow-lg"
      :style="{ left: `${menuPos.left}px`, top: `${menuPos.top}px` }"
    >
      <button
        v-for="t in CALENDAR_EVENT_TYPES"
        :key="t"
        type="button"
        data-test="event-type-option"
        class="flex h-6 w-6 items-center justify-center rounded-sm transition-colors hover:bg-pearl"
        :class="t === props.modelValue ? 'bg-pearl' : ''"
        :aria-label="meta(t).label"
        @click="choose(t)"
        @mouseenter="showTip(meta(t).label, $event)"
        @mouseleave="hideTip"
      >
        <span class="h-2 w-2 rounded-full" :class="meta(t).dot" />
      </button>
    </div>

    <!-- 悬浮小卡片：类型文案 -->
    <div
      v-if="tip"
      data-test="event-type-tip"
      class="pointer-events-none fixed z-50 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-center text-fine text-canvas shadow-md"
      :style="{
        left: `${tip.left}px`,
        top: `${tip.top}px`,
        transform: tip.flip ? 'translate(-100%, -50%)' : 'translateY(-50%)',
      }"
    >
      {{ tip.text }}
    </div>
  </Teleport>
</template>
