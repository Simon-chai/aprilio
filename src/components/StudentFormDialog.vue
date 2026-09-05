<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppInput from "./ui/AppInput.vue";
import { STATUS_LABEL } from "../types";
import type { Gender, StudentInput } from "../types";

const RELATIONS = ["父亲", "母亲", "爷爷", "奶奶", "外公", "外婆", "监护人", "其他"];

interface GuardianFormItem {
  id?: number;
  name: string;
  phone: string;
  relation: string;
  is_primary: boolean;
}

interface FormModel {
  name: string;
  gender: Gender;
  birth_date: string;
  student_no: string;
  grade_class: string;
  enroll_date: string;
  address: string;
  status: string;
  note: string;
  guardians: GuardianFormItem[];
}

const props = withDefaults(
  defineProps<{ open: boolean; initial?: Partial<StudentInput> | null; title?: string }>(),
  { initial: null, title: "新建学生" }
);

const emit = defineEmits<{ close: []; submit: [input: StudentInput] }>();

const blank = (): FormModel => ({
  name: "",
  gender: "男",
  birth_date: "",
  student_no: "",
  grade_class: "",
  enroll_date: "",
  address: "",
  status: "active",
  note: "",
  guardians: [{ name: "", phone: "", relation: "父亲", is_primary: true }],
});

const fromInput = (s: Partial<StudentInput>): FormModel => {
  const gList: GuardianFormItem[] =
    s.guardians && s.guardians.length > 0
      ? s.guardians.map((g, idx) => ({
          id: g.id,
          name: g.name ?? "",
          phone: g.phone ?? "",
          relation: g.relation || "监护人",
          is_primary: g.is_primary !== undefined ? Boolean(g.is_primary) : idx === 0,
        }))
      : [{ name: "", phone: "", relation: "父亲", is_primary: true }];

  return {
    name: s.name ?? "",
    gender: s.gender === "女" ? "女" : "男",
    birth_date: s.birth_date ?? "",
    student_no: s.student_no ?? "",
    grade_class: s.grade_class ?? "",
    enroll_date: s.enroll_date ?? "",
    address: s.address ?? "",
    status: s.status ?? "active",
    note: s.note ?? "",
    guardians: gList,
  };
};

const toInput = (f: FormModel): StudentInput => ({
  name: f.name.trim(),
  gender: f.gender,
  birth_date: f.birth_date || null,
  student_no: f.student_no.trim(),
  grade_class: f.grade_class.trim(),
  enroll_date: f.enroll_date || null,
  address: f.address.trim() || null,
  status: f.status,
  note: f.note.trim() || null,
  guardians: f.guardians
    .filter((g) => g.name.trim() || g.phone.trim())
    .map((g, idx) => ({
      id: g.id,
      name: g.name.trim(),
      phone: g.phone.trim(),
      relation: g.relation.trim() || "监护人",
      is_primary: g.is_primary ?? idx === 0,
    })),
});

const form = reactive<FormModel>(blank());
const error = ref("");

watch(
  [() => props.open, () => props.initial],
  ([open]) => {
    if (!open) return;
    Object.assign(form, blank(), props.initial ? fromInput(props.initial) : {});
    error.value = "";
  }
);

function addGuardian() {
  const nextRelation =
    form.guardians.length === 1 && form.guardians[0].relation === "父亲" ? "母亲" : "监护人";
  form.guardians.push({
    name: "",
    phone: "",
    relation: nextRelation,
    is_primary: form.guardians.length === 0,
  });
}

function removeGuardian(index: number) {
  if (form.guardians.length > 1) {
    const wasPrimary = form.guardians[index].is_primary;
    form.guardians.splice(index, 1);
    if (wasPrimary && form.guardians.length > 0) {
      form.guardians[0].is_primary = true;
    }
  } else {
    form.guardians[0].name = "";
    form.guardians[0].phone = "";
    form.guardians[0].relation = "监护人";
  }
}

function setPrimaryGuardian(index: number) {
  form.guardians.forEach((g, i) => {
    g.is_primary = i === index;
  });
}

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
    <div class="scroll-thin flex max-h-[92vh] w-[720px] max-w-full flex-col rounded-lg bg-canvas p-6 shadow-window overflow-y-auto">
      <div class="mb-5 flex shrink-0 items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">{{ props.title }}</h2>
        <button type="button" class="inline-flex items-center text-caption text-weak hover:text-ink" @click="emit('close')">
          关闭
        </button>
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

        <!-- 性别二选一单选 -->
        <div class="space-y-1.5">
          <span class="text-fine text-weak">性别</span>
          <div class="flex h-9 rounded-sm border border-hairline bg-parchment p-0.5">
            <button
              type="button"
              data-test="gender-option"
              class="inline-flex flex-1 items-center justify-center rounded-sm text-caption font-medium transition-colors"
              :class="form.gender === '男' ? 'bg-ink text-canvas shadow-sm' : 'text-weak hover:text-ink'"
              @click="form.gender = '男'"
            >
              男
            </button>
            <button
              type="button"
              data-test="gender-option"
              class="inline-flex flex-1 items-center justify-center rounded-sm text-caption font-medium transition-colors"
              :class="form.gender === '女' ? 'bg-ink text-canvas shadow-sm' : 'text-weak hover:text-ink'"
              @click="form.gender = '女'"
            >
              女
            </button>
          </div>
        </div>

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

        <label class="col-span-2 space-y-1.5">
          <span class="text-fine text-weak">家庭住址</span>
          <AppInput v-model="form.address" variant="field" width="100%" />
        </label>

        <!-- 监护人列表卡片（支持多位监护人） -->
        <div class="col-span-2 space-y-3 rounded-lg border border-hairline bg-pearl/40 p-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-caption font-semibold text-ink">监护人信息</span>
              <span class="text-fine text-weak">（支持添加多位监护人）</span>
            </div>
            <button
              type="button"
              data-test="add-guardian-btn"
              class="inline-flex items-center gap-1 text-fine font-medium text-primary hover:underline"
              @click="addGuardian"
            >
              + 添加监护人
            </button>
          </div>

          <div class="space-y-3">
            <div
              v-for="(g, idx) in form.guardians"
              :key="idx"
              data-test="guardian-row"
              class="flex items-center gap-3 rounded-md border border-hairline bg-canvas p-3"
            >
              <!-- 关系 -->
              <div class="w-24 shrink-0 space-y-1">
                <span class="text-[11px] text-weak">关系</span>
                <select
                  v-model="g.relation"
                  class="h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                >
                  <option v-for="rel in RELATIONS" :key="rel" :value="rel">{{ rel }}</option>
                </select>
              </div>

              <!-- 姓名 -->
              <div class="flex-1 space-y-1">
                <span class="text-[11px] text-weak">姓名</span>
                <AppInput v-model="g.name" variant="field" width="100%" placeholder="监护人姓名" />
              </div>

              <!-- 联系电话 -->
              <div class="flex-1 space-y-1">
                <span class="text-[11px] text-weak">联系电话</span>
                <AppInput v-model="g.phone" variant="field" width="100%" placeholder="手机号" />
              </div>

              <!-- 主要联系人 -->
              <div class="flex shrink-0 items-center gap-1.5 pt-4">
                <label class="flex cursor-pointer items-center gap-1 text-fine text-weak">
                  <input
                    type="radio"
                    name="primary_guardian"
                    :checked="g.is_primary"
                    class="text-primary focus:ring-0"
                    @change="setPrimaryGuardian(idx)"
                  />
                  <span>主联系</span>
                </label>
              </div>

              <!-- 删除按钮 -->
              <div class="shrink-0 pt-4">
                <button
                  type="button"
                  data-test="remove-guardian-btn"
                  class="inline-flex h-8 w-8 items-center justify-center rounded-sm text-weak hover:bg-parchment hover:text-danger"
                  title="删除此监护人"
                  @click="removeGuardian(idx)"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

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

      <div class="mt-6 flex shrink-0 justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">取消</AppButton>
        <AppButton @click="submit">保存</AppButton>
      </div>
    </div>
  </div>
</template>
