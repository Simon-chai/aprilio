<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppInput from "./ui/AppInput.vue";
import type { ClassSummary } from "../types";
import { currentSemester, semesterLabel } from "../lib/timetable";
import { gradeLabel, inferGradeFromName, recentSemesters } from "../lib/semester";

export interface ClassFormValue {
  name: string;
  entry_grade: number | null;
  entry_semester: string | null;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    mode?: "create" | "rename";
    initialName?: string | null;
    initialGrade?: number | null;
    initialSemester?: string | null;
    existingClasses?: (string | ClassSummary)[];
  }>(),
  {
    mode: "create",
    initialName: "",
    initialGrade: null,
    initialSemester: null,
    existingClasses: () => [],
  }
);

const emit = defineEmits<{
  close: [];
  submit: [value: ClassFormValue];
}>();

const GRADE_OPTIONS = [1, 2, 3, 4, 5, 6];

const className = ref("");
const entryGrade = ref<number | null>(null);
const entrySemester = ref<string>("");
const error = ref("");
const inputRef = ref<InstanceType<typeof AppInput> | null>(null);

const title = computed(() => (props.mode === "rename" ? "修改班级" : "新建班级"));

const semesterOptions = computed(() => {
  const list = recentSemesters(10);
  // 已有起始学期可能早于最近 10 个学期：补进候选，避免下拉选不中旧值
  if (props.initialSemester && !list.includes(props.initialSemester)) {
    list.push(props.initialSemester);
  }
  return list;
});

const existingNames = computed(() => {
  return props.existingClasses.map((item) => (typeof item === "string" ? item : item.name));
});

/** 默认起始学期 = 当前学期 */
const defaultSemester = () => currentSemester();

/** 班级名里能识别出年级时自动预选（规则优先，不依赖 AI） */
watch(className, (value) => {
  if (props.mode !== "create" || entryGrade.value != null) return;
  const guess = inferGradeFromName(value);
  if (guess != null) entryGrade.value = guess;
});

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      className.value = props.initialName ?? "";
      entryGrade.value = props.initialGrade ?? null;
      entrySemester.value = props.initialSemester ?? (props.mode === "create" ? defaultSemester() : "");
      error.value = "";
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
  emit("submit", {
    name: trimmed,
    entry_grade: entryGrade.value,
    entry_semester: entrySemester.value.trim() || null,
  });
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @mousedown.self="emit('close')"
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
            data-test="class-name-input"
          />
        </label>

        <!-- 初始年级 / 起始学期：用于随时间实时推导「现在几年级、上还是下」 -->
        <div class="grid grid-cols-2 gap-4">
          <label class="space-y-1.5">
            <span class="text-fine text-weak">初始年级</span>
            <select
              v-model="entryGrade"
              data-test="class-grade-select"
              class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
            >
              <option :value="null">暂不登记</option>
              <option v-for="g in GRADE_OPTIONS" :key="g" :value="g">{{ gradeLabel(g) }}</option>
            </select>
          </label>
          <label class="space-y-1.5">
            <span class="text-fine text-weak">起始学期</span>
            <select
              v-model="entrySemester"
              data-test="class-semester-select"
              class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
            >
              <option value="">暂不登记</option>
              <option v-for="sem in semesterOptions" :key="sem" :value="sem">
                {{ semesterLabel(sem) }}
              </option>
            </select>
          </label>
        </div>
        <p class="text-fine text-weak">
          登记后，班级会随当前时间自动升学期、升年级（如三年级 → 四年级），数据始终留在同一个班。
        </p>

        <p v-if="error" class="text-caption text-danger">{{ error }}</p>

        <div class="mt-6 flex justify-end gap-3 pt-2">
          <AppButton type="button" variant="pearl" @click="emit('close')">取消</AppButton>
          <AppButton type="submit" variant="primary">确定</AppButton>
        </div>
      </form>
    </div>
  </div>
</template>
