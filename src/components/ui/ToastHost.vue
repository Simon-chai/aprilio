<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useToastState } from "../../composables/useToast";

/**
 * 全局 Toast 宿主（挂载在 App.vue）：读 useToast 单例队列渲染顶部居中轻反馈。
 * 视觉逐字沿用原 qb-toast（bg-tile 白字 pill、淡入下移过渡），零视觉变化；
 * z-[70] 高于一切弹层，弹层内操作成功也可见。
 */

const { items, clearAll } = useToastState();

// 宿主销毁即清空全部条目与计时器（测试隔离用；生产常驻 App 不会销毁）
onBeforeUnmount(clearAll);
</script>

<template>
  <!-- 容器不拦截鼠标（pointer-events-none），仅条目本身占交互位 -->
  <div
    class="pointer-events-none fixed inset-x-0 top-4 z-[70] mx-auto flex w-fit flex-col items-center"
  >
    <TransitionGroup name="qb-toast">
      <div
        v-for="item in items"
        :key="item.id"
        data-test="quick-toast"
        class="pointer-events-auto rounded-full bg-tile px-4 py-1.5 text-fine text-white shadow-lg"
        :class="`toast-${item.tone}`"
      >
        {{ item.text }}
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* 与原 qb-toast 三份拷贝逐字对齐：淡入下移 0.2s；堆叠时旧条目离场后其余平滑上移 */
.qb-toast-enter-active,
.qb-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.qb-toast-enter-from,
.qb-toast-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.qb-toast-leave-active {
  position: absolute;
}
.qb-toast-move {
  transition: transform 0.2s ease;
}
</style>
