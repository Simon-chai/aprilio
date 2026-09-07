<script setup lang="ts">
/**
 * 分析中动效：智能导入解析/识别阶段的页面内叠加层（不是弹窗、不跳页面）。
 *
 * 目的：让用户明确「AI 正在分析、需要几秒钟」，而不是「应用卡住了」。
 * 视觉：设计系统的克制单色 —— Action Blue 旋转环 + 核心脉冲 + 数据条 + 扫描网格底纹，
 * 步骤文案轮播 + 实时已用时长，体感透明。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    show: boolean;
    /** 叠加层主标题 */
    title?: string;
    /** 阶段文案，按顺序轮播 */
    steps?: string[];
  }>(),
  { title: "AI 正在分析", steps: () => ["解析表格结构…", "识别列语义…", "AI 分析字段含义…"] }
);

const stepIndex = ref(0);
const elapsedMs = ref(0);
let stepTimer = 0;
let tickTimer = 0;

const elapsedText = computed(() => `${(elapsedMs.value / 1000).toFixed(1)} 秒`);

function start() {
  stop();
  stepIndex.value = 0;
  elapsedMs.value = 0;
  tickTimer = window.setInterval(() => {
    elapsedMs.value += 100;
  }, 100);
  stepTimer = window.setInterval(() => {
    stepIndex.value = (stepIndex.value + 1) % props.steps.length;
  }, 1200);
}

function stop() {
  window.clearInterval(stepTimer);
  window.clearInterval(tickTimer);
  stepTimer = 0;
  tickTimer = 0;
}

watch(
  () => props.show,
  (show) => (show ? start() : stop()),
  { immediate: true }
);

onBeforeUnmount(stop);
</script>

<template>
  <Transition name="ao-fade">
    <div
      v-if="show"
      role="status"
      aria-live="polite"
      data-test="analyzing-overlay"
      class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 overflow-hidden rounded-lg bg-canvas/85 backdrop-blur-[2px]"
    >
      <!-- 扫描网格底纹：一条横向光带自上而下循环扫过 -->
      <div class="ao-grid absolute inset-0" aria-hidden="true" />
      <div class="ao-scan absolute inset-x-0 h-16" aria-hidden="true" />

      <!-- 旋转环 + 核心脉冲 -->
      <div class="relative h-20 w-20 shrink-0" aria-hidden="true">
        <span class="absolute inset-0 rounded-full border border-hairline" />
        <span class="ao-ring absolute inset-0 rounded-full border-2 border-transparent border-t-primary" />
        <span class="ao-ring-rev absolute inset-2 rounded-full border-2 border-transparent border-b-primary/50" />
        <span class="ao-core absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" />
      </div>

      <!-- 数据条：AI 处理中的「呼吸」体感 -->
      <div class="flex h-5 items-end gap-1" aria-hidden="true">
        <span
          v-for="i in 7"
          :key="i"
          class="ao-bar w-1 rounded-full bg-primary/60"
          :style="{ animationDelay: `${i * 0.12}s` }"
        />
      </div>

      <div class="relative text-center">
        <p class="text-caption font-medium text-ink">{{ title }}</p>
        <p class="mt-1 h-5 text-caption text-muted">
          <Transition name="ao-step" mode="out-in">
            <span :key="stepIndex" class="inline-block">{{ steps[stepIndex] }}</span>
          </Transition>
        </p>
        <p class="mt-1.5 text-fine text-weak tnum">
          已用 {{ elapsedText }} · 模型分析通常需要几秒，不是卡住
        </p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 网格底纹：细密蓝点阵，弱化到只可感知 */
.ao-grid {
  background-image: radial-gradient(circle, rgb(0 102 204 / 0.1) 1px, transparent 1px);
  background-size: 18px 18px;
  mask-image: radial-gradient(ellipse at center, black 30%, transparent 75%);
}

/* 扫描光带：自上而下循环 */
.ao-scan {
  background: linear-gradient(
    to bottom,
    transparent,
    rgb(0 102 204 / 0.08) 45%,
    rgb(0 102 204 / 0.16) 50%,
    rgb(0 102 204 / 0.08) 55%,
    transparent
  );
  animation: ao-scan-move 2.4s ease-in-out infinite;
}

@keyframes ao-scan-move {
  0% {
    transform: translateY(-20%);
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  85% {
    opacity: 1;
  }
  100% {
    transform: translateY(1200%);
    opacity: 0;
  }
}

/* 外环：顺时针 */
.ao-ring {
  animation: ao-spin 1.6s linear infinite;
}

/* 内环：逆时针 */
.ao-ring-rev {
  animation: ao-spin 2.2s linear infinite reverse;
}

@keyframes ao-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 核心脉冲 */
.ao-core {
  animation: ao-pulse 1.4s ease-in-out infinite;
}

@keyframes ao-pulse {
  0%,
  100% {
    transform: translate(-50%, -50%) scale(0.75);
    opacity: 0.65;
  }
  50% {
    transform: translate(-50%, -50%) scale(1.1);
    opacity: 1;
  }
}

/* 数据条：错峰跳动 */
.ao-bar {
  height: 30%;
  animation: ao-bar-bounce 1.1s ease-in-out infinite;
}

@keyframes ao-bar-bounce {
  0%,
  100% {
    height: 25%;
  }
  50% {
    height: 100%;
  }
}

/* 步骤文案淡入淡出 */
.ao-step-enter-active,
.ao-step-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.ao-step-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.ao-step-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 叠加层整体淡入 */
.ao-fade-enter-active,
.ao-fade-leave-active {
  transition: opacity 0.2s ease;
}
.ao-fade-enter-from,
.ao-fade-leave-to {
  opacity: 0;
}
</style>
