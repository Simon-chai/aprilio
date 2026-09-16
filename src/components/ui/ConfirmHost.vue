<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { useConfirm } from "../../composables/useConfirm";

/**
 * confirmAction 的唯一宿主（挂载在 App.vue）：
 * 读 useConfirm 单例状态渲染 ConfirmDialog，把交互结果结算回进行中的 Promise。
 */

const { state, confirm, cancel } = useConfirm();

// 回车 = 确认（对齐原生 confirm 的键盘习惯）；焦点在按钮上时交给按钮自身的键盘行为，
// 避免焦点停在「取消」上回车却被解析成确认。事件 target 可能是 document 本身，需判 Element
function onDocumentKeydown(e: KeyboardEvent) {
  if (e.key !== "Enter") return;
  const target = e.target;
  if (target instanceof Element && target.closest("button")) return;
  confirm();
}

watch(
  () => state.open,
  (open) => {
    if (open) document.addEventListener("keydown", onDocumentKeydown);
    else document.removeEventListener("keydown", onDocumentKeydown);
  },
  { immediate: true }
);

onBeforeUnmount(() => document.removeEventListener("keydown", onDocumentKeydown));
</script>

<template>
  <ConfirmDialog
    :open="state.open"
    :title="state.title"
    :message="state.message"
    :tone="state.tone"
    :confirm-text="state.confirmText"
    :cancel-text="state.cancelText"
    @confirm="confirm"
    @cancel="cancel"
  />
</template>
