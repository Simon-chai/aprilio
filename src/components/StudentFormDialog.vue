<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppInput from "./ui/AppInput.vue";
import { STATUS_LABEL } from "../types";
import type { StudentInput } from "../types";

/** 表单里所有可空字段都用空串表示，提交时再转成 null */
interface FormModel {
  name: string;
  gender: string;
  birth_date: string;
  student_no: string;
  grade_class: string;
  enroll_date: string;
  guardian_name: string;
  guardian_phone: string;
  address: string;
  status: string;
  note: string;
}

const props = withDefaults(
  defineProps<{ open: boolean; initial?: StudentInput | null; title?: string }>(),
  { initial: null, title: "新建学生" }
);

const emit = defineEmits<{ close: []; submit: [input: StudentInput] }>();

const blank = (): FormModel => ({
  name: "",
  gender: "",
  birth_date: "",
  student_no: "",
  grade_class: "",
  enroll_date: "",
  guardian_name: "",
  guardian_phone: "",
  address: "",
  status: "active",
  note: "",
});

const fromInput = (s: StudentInput): FormModel => ({
  name: s.name,
  gender: s.gender,
  birth_date: s.birth_date ?? "",
  student_no: s.student_no,
  grade_class: s.grade_class,
  enroll_date: s.enroll_date ?? "",
  guardian_name: s.guardian_name ?? "",
  guardian_phone: s.guardian_phone ?? "",
  address: s.address ?? "",
  status: s.status,
  note: s.note ?? "",
});

const toInput = (f: FormModel): StudentInput => ({
  name: f.name.trim(),
  gender: f.gender.trim(),
  birth_date: f.birth_date || null,
  student_no: f.student_no.trim(),
  grade_class: f.grade_class.trim(),
  enroll_date: f.enroll_date || null,
  guardian_name: f.guardian_name.trim() || null,
  guardian_phone: f.guardian_phone.trim() || null,
  address: f.address.trim() || null,
  status: f.status,
  note: f.note.trim() || null,
});

const form = reactive<FormModel>(blank());
const error = ref("");

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    Object.assign(form, blank(), props.initial ? fromInput(props.initial) : {});
    error.value = "";
  }
);

function submit() {
  if (!form.name.trim()) {
    error.value = "请填写姓名";
    return;
  }
  if (!form.student_no.trim()) {
    error.value = "请填写学号";
    return;
  }
  error.value = "";
  emit("submit", toInput(form));
}
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @click.self="emit('close')"
  >
    <div class="w-[680px] max-w-full rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">{{ props.title }}</h2>
        <button class="text-caption text-weak hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1.5">
          <span class="text-fine text-weak">姓名</span>
          <AppInput v-model="form.name" variant="field" width="100%" placeholder="必填" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">学号</span>
          <AppInput v-model="form.student_no" variant="field" width="100%" placeholder="必填" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">性别</span>
          <AppInput v-model="form.gender" variant="field" width="100%" placeholder="男 / 女" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">出生日期</span>
          <AppInput v-model="form.birth_date" type="date" variant="field" width="100%" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">年级班级</span>
          <AppInput
            v-model="form.grade_class"
            variant="field"
            width="100%"
            placeholder="三年级二班"
          />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">入学日期</span>
          <AppInput v-model="form.enroll_date" type="date" variant="field" width="100%" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">监护人</span>
          <AppInput v-model="form.guardian_name" variant="field" width="100%" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">联系电话</span>
          <AppInput v-model="form.guardian_phone" variant="field" width="100%" />
        </label>
        <label class="col-span-2 space-y-1.5">
          <span class="text-fine text-weak">家庭住址</span>
          <AppInput v-model="form.address" variant="field" width="100%" />
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">状态</span>
          <select
            v-model="form.status"
            class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
          >
            <option v-for="(label, key) in STATUS_LABEL" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-fine text-weak">备注</span>
          <AppInput v-model="form.note" variant="field" width="100%" />
        </label>
      </div>

      <p v-if="error" class="mt-4 text-caption text-danger">{{ error }}</p>

      <div class="mt-6 flex justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">取消</AppButton>
        <AppButton @click="submit">保存</AppButton>
      </div>
    </div>
  </div>
</template>
