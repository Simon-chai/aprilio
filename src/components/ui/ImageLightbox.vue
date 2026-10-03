<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AppDialog from "./AppDialog.vue";
import AppIcon from "./AppIcon.vue";

/**
 * 查看原图唯一模式：照片缩略图点击后进入的沉浸式灯箱。
 * - 壳走 AppDialog 的 photo 变体：深色遮罩、Esc / 遮罩点击关闭、焦点圈定都复用弹层基建
 * - items 是当前列表里全部可看的照片，打开时定位到 index；内部 ← → 键与按钮翻页，不回写业务
 * - 点击图片在「适应窗口 ↔ 原始尺寸（100%）」间切换，原始尺寸时舞台滚动平移；翻页后回到适应窗口
 */
const props = defineProps<{
  open: boolean;
  items: { src: string; caption?: string }[];
  /** 打开时定位到的下标 */
  index: number;
}>();

const emit = defineEmits<{ close: [] }>();

const current = ref(props.index);
const actualSize = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open) {
      current.value = Math.min(Math.max(props.index, 0), Math.max(props.items.length - 1, 0));
      actualSize.value = false;
      document.addEventListener("keydown", onKeydown);
    } else {
      document.removeEventListener("keydown", onKeydown);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

// 列表在打开期间变短（如别处删除照片）时兜底，避免取到 undefined
const currentItem = computed(() => props.items[Math.min(current.value, props.items.length - 1)]);

const hasPrev = computed(() => current.value > 0);
const hasNext = computed(() => current.value < props.items.length - 1);

function prev() {
  if (!hasPrev.value) return;
  current.value -= 1;
  actualSize.value = false;
}

function next() {
  if (!hasNext.value) return;
  current.value += 1;
  actualSize.value = false;
}

/** ← / → 翻页（Esc / Tab 由 AppDialog 统一处理，这里只补翻页键） */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") prev();
  else if (e.key === "ArrowRight") next();
}
</script>

<template>
  <AppDialog
    :open="open"
    :title="currentItem?.caption || '查看图片'"
    variant="photo"
    data-test="image-lightbox"
    @close="emit('close')"
  >
    <div class="flex justify-end">
      <button
        data-test="lightbox-close"
        type="button"
        aria-label="关闭"
        class="flex h-9 w-9 items-center justify-center rounded-full bg-canvas/10 text-canvas transition-colors duration-150 hover:bg-canvas/20"
        @click="emit('close')"
      >
        <AppIcon name="close" :size="18" />
      </button>
    </div>

    <!-- 舞台：适应窗口时图片等比缩到窗口内，100% 时超出部分滚动平移（m-auto 兼顾居中与滚动可达）；
         翻页按钮挂在舞台的 relative 包裹层上，不随 100% 滚动 -->
    <div class="relative">
      <div data-test="lightbox-stage" class="scroll-thin flex max-h-[calc(100vh-12rem)] overflow-auto">
        <img
          v-if="currentItem"
          data-test="lightbox-image"
          :src="currentItem.src"
          :alt="currentItem.caption ?? ''"
          :title="actualSize ? '点击适应窗口' : '点击按原始尺寸查看'"
          class="m-auto select-none rounded-sm"
          :class="
            actualSize
              ? 'max-w-none cursor-zoom-out'
              : 'max-h-[calc(100vh-12rem)] max-w-full cursor-zoom-in object-contain'
          "
          draggable="false"
          @click="actualSize = !actualSize"
        />
        <div v-else class="flex h-40 w-full items-center justify-center text-caption text-canvas/60">
          图片不可用
        </div>
      </div>

      <button
        v-if="items.length > 1"
        data-test="lightbox-prev"
        type="button"
        aria-label="上一张"
        class="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-canvas/10 text-canvas transition-colors duration-150 hover:bg-canvas/20 disabled:pointer-events-none disabled:opacity-30"
        :disabled="!hasPrev"
        @click="prev"
      >
        <AppIcon name="chevron-left" :size="20" />
      </button>
      <button
        v-if="items.length > 1"
        data-test="lightbox-next"
        type="button"
        aria-label="下一张"
        class="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-canvas/10 text-canvas transition-colors duration-150 hover:bg-canvas/20 disabled:pointer-events-none disabled:opacity-30"
        :disabled="!hasNext"
        @click="next"
      >
        <AppIcon name="chevron-right" :size="20" />
      </button>
    </div>

    <div v-if="currentItem" class="mt-3 flex items-baseline justify-center gap-3 text-caption">
      <span data-test="lightbox-caption" class="max-w-[60%] truncate text-canvas/90">
        {{ currentItem.caption || "未命名" }}
      </span>
      <span
        v-if="items.length > 1"
        data-test="lightbox-count"
        class="shrink-0 text-canvas/50"
      >
        {{ current + 1 }} / {{ items.length }}
      </span>
    </div>
  </AppDialog>
</template>
