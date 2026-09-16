<script setup lang="ts">
import { computed } from "vue";
import AppButton from "./AppButton.vue";
import AppDialog from "./AppDialog.vue";
import AppIcon from "./AppIcon.vue";

/**
 * 破坏性确认弹层（组件形态）：需要自定义操作区的复杂确认用本组件 + footer 插槽
 * （如 ClassesView「删除并重建」三按钮）；日常 90% 场景直接走 useConfirm 的 confirmAction。
 * Esc / 遮罩点击统一映射为 cancel。
 */

type Tone = "default" | "danger";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 正文说明；需要更复杂的消息区可用 default 插槽整体覆盖 */
    message?: string;
    /** danger = 确认按钮 danger variant（默认文案「删除」） */
    tone?: Tone;
    /** 确认按钮文案，默认：danger「删除」/ 其他「确认」 */
    confirmText?: string;
    /** 取消按钮文案，默认「取消」 */
    cancelText?: string;
  }>(),
  { tone: "default" }
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const confirmLabel = computed(
  () => props.confirmText ?? (props.tone === "danger" ? "删除" : "确认")
);
const cancelLabel = computed(() => props.cancelText ?? "取消");
</script>

<template>
  <!-- 宽度 sm 与既有确认弹窗（440px）对齐；close（Esc/遮罩）一律视为取消 -->
  <AppDialog :open="open" :title="title" width="sm" @close="emit('cancel')">
    <slot>
      <p v-if="message" class="mt-3 text-caption leading-relaxed text-muted">{{ message }}</p>
    </slot>
    <template #footer>
      <slot name="footer">
        <div class="mt-6 flex justify-end gap-3">
          <AppButton variant="pearl" data-test="confirm-cancel-btn" @click="emit('cancel')">
            {{ cancelLabel }}
          </AppButton>
          <AppButton
            :variant="tone === 'danger' ? 'danger' : 'primary'"
            data-test="confirm-submit-btn"
            @click="emit('confirm')"
          >
            <!-- danger 图标强调（规格 §3.2）：颜色继承按钮文字色，danger variant 本身 text-danger -->
            <AppIcon v-if="tone === 'danger'" name="warn" :size="14" />
            {{ confirmLabel }}
          </AppButton>
        </div>
      </slot>
    </template>
  </AppDialog>
</template>
