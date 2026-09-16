<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppDialog from "./ui/AppDialog.vue";
import AppIcon from "./ui/AppIcon.vue";
import AppInput from "./ui/AppInput.vue";
import type { ClassSummary } from "../types";

export interface ClassFormValue {
  name: string;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode?: "create" | "rename";
    initialName?: string | null;
    existingClasses?: (string | ClassSummary)[];
  }>(),
  {
    mode: "create",
    initialName: "",
    existingClasses: () => [],
  }
);

const emit = defineEmits<{
  close: [];
  submit: [value: ClassFormValue];
}>();

const className = ref("");
const error = ref("");
const inputRef = ref<InstanceType<typeof AppInput> | null>(null);

const title = computed(() => (props.mode === "rename" ? "修改班级" : "新建班级"));

const existingNames = computed(() => {
  return props.existingClasses.map((item) => (typeof item === "string" ? item : item.name));
});

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      className.value = props.initialName ?? "";
      error.value = "";
      // 双跳 nextTick：AppDialog 打开时会先把焦点落到面板，之后再把焦点夺回名称输入框
      await nextTick();
      await nextTick();
      const el = inputRef.value?.$el?.querySelector("input") || (inputRef.value?.$el as HTMLInputElement);
      el?.focus?.();
    }
  },
  { immediate: true }
);

function handleSubmit() {
  const trimmed = className.value.trim();
  if (!trimmed) {
    error.value = "请输入班级名称";
    return;
  }

  if (props.mode === "rename" && trimmed === props.initialName?.trim()) {
    emit("close");
    return;
  }

  if (existingNames.value.includes(trimmed)) {
    error.value = `班级「${trimmed}」已存在`;
    return;
  }

  error.value = "";
  emit("submit", { name: trimmed });
}
</script>

<template>
  <!-- AppDialog 壳：遮罩 / Esc / 焦点圈定 / 过渡由壳承担；宽度就近归档 sm（原 460px） -->
  <AppDialog :open="open" :title="title" width="sm" @close="emit('close')">
    <!-- 关闭 ✕：对齐原标题行的关闭按钮位置（面板右上角） -->
    <button
      type="button"
      class="absolute right-6 top-6 flex h-6 w-6 items-center justify-center rounded-sm text-weak transition-colors hover:bg-parchment hover:text-ink"
      aria-label="关闭"
      @click="emit('close')"
    >
      <AppIcon name="close" :size="16" />
    </button>

    <form @submit.prevent="handleSubmit" class="mt-5 space-y-4">
        <div v-if="mode === 'rename' && initialName" class="text-caption text-weak">
          当前名称：<span class="font-medium text-ink">{{ initialName }}</span>
        </div>

        <label class="block space-y-1.5">
          <span class="text-fine text-weak">
            {{ mode === "rename" ? "新班级名称" : "班级名称" }}
          </span>
          <AppInput
            ref="inputRef"
            v-model="className"
            variant="field"
            width="100%"
            :placeholder="mode === 'rename' ? '请输入新的班级名称' : '如：三年级二班'"
            data-test="class-name-input"
          />
        </label>

        <p v-if="error" class="text-caption text-danger">{{ error }}</p>

        <div class="mt-6 flex justify-end gap-3 pt-2">
          <AppButton type="button" variant="pearl" @click="emit('close')">取消</AppButton>
          <AppButton type="submit" variant="primary">确定</AppButton>
        </div>
      </form>
  </AppDialog>
</template>
