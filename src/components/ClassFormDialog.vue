<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppInput from "./ui/AppInput.vue";
import type { ClassSummary } from "../types";

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
  submit: [name: string];
}>();

const className = ref("");
const error = ref("");
const inputRef = ref<InstanceType<typeof AppInput> | null>(null);

const title = computed(() => (props.mode === "rename" ? "修改班级名称" : "新建班级"));

const existingNames = computed(() => {
  return props.existingClasses.map((item) => (typeof item === "string" ? item : item.name));
});

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      className.value = props.initialName ?? "";
      error.value = "";
      await nextTick();
      // focus input if available
      const el = inputRef.value?.$el?.querySelector("input") || (inputRef.value?.$el as HTMLInputElement);
      el?.focus?.();
    }
  }
);

function handleSubmit() {
  const trimmed = className.value.trim();
  if (!trimmed) {
    error.value = "请输入班级名称";
    return;
  }

  // 如果是重命名且未发生变化，直接关闭
  if (props.mode === "rename" && trimmed === props.initialName?.trim()) {
    emit("close");
    return;
  }

  // 检查名称重复
  if (existingNames.value.includes(trimmed)) {
    error.value = `班级「${trimmed}」已存在`;
    return;
  }

  error.value = "";
  emit("submit", trimmed);
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @click.self="emit('close')"
  >
    <div class="w-[460px] max-w-full rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">{{ title }}</h2>
        <button
          type="button"
          class="inline-flex items-center text-caption text-weak hover:text-ink"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <form @submit.prevent="handleSubmit" class="space-y-4">
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
          />
        </label>

        <p v-if="error" class="text-caption text-danger">{{ error }}</p>

        <div class="mt-6 flex justify-end gap-3 pt-2">
          <AppButton type="button" variant="pearl" @click="emit('close')">取消</AppButton>
          <AppButton type="submit" variant="primary">确定</AppButton>
        </div>
      </form>
    </div>
  </div>
</template>
