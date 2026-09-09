<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppInput from "./ui/AppInput.vue";
import AppLink from "./ui/AppLink.vue";
import { STATUS_LABEL } from "../types";
import {
  addGuardianTagPreset,
  ensureGuardianTagPolarities,
  loadGuardianTagPresets,
  loadTagPolarities,
  removeGuardianTagPreset,
  tagChipClass,
} from "../lib/guardian-tags";
import type { Gender, GuardianTagPolarity, StudentInput } from "../types";

const RELATIONS = ["父亲", "母亲", "爷爷", "奶奶", "外公", "外婆", "监护人", "其他"];

interface GuardianFormItem {
  id?: number;
  name: string;
  phone: string;
  relation: string;
  is_primary: boolean;
  occupation: string;
  tags: string[];
}

interface FormModel {
  name: string;
  gender: Gender;
  birth_date: string;
  student_no: string;
  grade_class: string;
  id_card: string;
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

const blankGuardian = (): GuardianFormItem => ({
  name: "",
  phone: "",
  relation: "父亲",
  is_primary: true,
  occupation: "",
  tags: [],
});

const blank = (): FormModel => ({
  name: "",
  gender: "男",
  birth_date: "",
  student_no: "",
  grade_class: "",
  id_card: "",
  address: "",
  status: "active",
  note: "",
  guardians: [blankGuardian()],
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
          occupation: g.occupation ?? "",
          tags: g.tags ? [...g.tags] : [],
        }))
      : [blankGuardian()];

  return {
    name: s.name ?? "",
    gender: s.gender === "女" ? "女" : "男",
    birth_date: s.birth_date ?? "",
    student_no: s.student_no ?? "",
    grade_class: s.grade_class ?? "",
    id_card: s.id_card ?? "",
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
  id_card: f.id_card.trim() || null,
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
      occupation: g.occupation.trim(),
      tags: [...g.tags],
    })),
});

const form = reactive<FormModel>(blank());
const error = ref("");
const tagDrafts = reactive<Record<number, string>>({});
/** 预设候选词（可动态增删，全局共享，随打开刷新） */
const presets = ref<string[]>([]);
/** 标签情感倾向缓存（AI 判定结果，键为标签词） */
const polarities = ref<Record<string, GuardianTagPolarity>>({});

watch(
  [() => props.open, () => props.initial],
  ([open]) => {
    if (!open) return;
    Object.assign(form, blank(), props.initial ? fromInput(props.initial) : {});
    Object.keys(tagDrafts).forEach((k) => delete tagDrafts[Number(k)]);
    error.value = "";
    presets.value = loadGuardianTagPresets();
    polarities.value = loadTagPolarities();
    // AI 已配置时后台补齐缺失标签的倾向配色；未配置则保持留白，配置后打开页面会自动补齐
    ensurePolarityColors();
  },
  { immediate: true }
);

/** 需要配色的标签全集 = 预设候选 + 各监护人已选标签 */
function ensurePolarityColors(extra?: string[]) {
  const all = new Set<string>(presets.value);
  form.guardians.forEach((g) => g.tags.forEach((t) => all.add(t)));
  extra?.forEach((t) => all.add(t));
  void ensureGuardianTagPolarities([...all]).then((map) => {
    if (Object.keys(map).length) polarities.value = loadTagPolarities();
  });
}

function addGuardian() {
  const nextRelation =
    form.guardians.length === 1 && form.guardians[0].relation === "父亲" ? "母亲" : "监护人";
  form.guardians.push({ ...blankGuardian(), relation: nextRelation, is_primary: false });
}

function removeGuardian(index: number) {
  if (form.guardians.length > 1) {
    const wasPrimary = form.guardians[index].is_primary;
    form.guardians.splice(index, 1);
    if (wasPrimary && form.guardians.length > 0) {
      form.guardians[0].is_primary = true;
    }
  } else {
    form.guardians[0] = blankGuardian();
  }
}

function setPrimaryGuardian(index: number) {
  form.guardians.forEach((g, i) => {
    g.is_primary = i === index;
  });
}

/** 添加风格标签：去重、限长限数 */
function addTag(index: number, raw: string) {
  const tag = raw.trim().slice(0, 10);
  tagDrafts[index] = "";
  if (!tag) return;
  const g = form.guardians[index];
  if (!g || g.tags.includes(tag) || g.tags.length >= 6) return;
  g.tags.push(tag);
  // 手输的自定义标签可能还没有倾向配色，后台补齐
  ensurePolarityColors([tag]);
}

/** 把输入框草稿保存为预设候选词（全局共享），失败（重复 / 超上限）保留草稿 */
function savePresetFromDraft(index: number) {
  const tag = (tagDrafts[index] ?? "").trim();
  if (!tag) return;
  if (!addGuardianTagPreset(tag)) return;
  tagDrafts[index] = "";
  presets.value = loadGuardianTagPresets();
  ensurePolarityColors([tag]);
}

/** 删除预设候选词（不影响已选中的标签） */
function deletePreset(tag: string) {
  removeGuardianTagPreset(tag);
  presets.value = loadGuardianTagPresets();
}

/** 已选标签胶囊配色：有倾向 → 填充色；无 → 留白中性底 */
function selectedChipClass(tag: string): string {
  return tagChipClass(polarities.value[tag]);
}

/** 预设候选胶囊配色：有倾向 → 填充色；无 → 留白描边 */
function presetChipClass(tag: string): string {
  return polarities.value[tag] ? tagChipClass(polarities.value[tag]) : "";
}

function removeTag(index: number, tagIdx: number) {
  form.guardians[index]?.tags.splice(tagIdx, 1);
}

function onTagKeydown(e: KeyboardEvent, index: number) {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addTag(index, tagDrafts[index] ?? "");
  }
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
  const idCard = form.id_card.trim();
  if (idCard && !/^\d{15}$|^\d{17}[\dXx]$/.test(idCard)) {
    error.value = "身份证号格式不正确（应为 15 或 18 位）";
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
          <span class="text-fine text-weak">身份证号</span>
          <AppInput
            v-model="form.id_card"
            variant="field"
            width="100%"
            placeholder="选填，15 或 18 位"
            data-test="id-card-input"
          />
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
            <AppLink
              data-test="add-guardian-btn"
              variant="action"
              class="text-fine font-medium"
              @click="addGuardian"
            >
              ＋ 添加监护人
            </AppLink>
          </div>

          <div class="space-y-3">
            <div
              v-for="(g, idx) in form.guardians"
              :key="idx"
              data-test="guardian-row"
              class="space-y-2.5 rounded-md border border-hairline bg-canvas p-3"
            >
              <!-- 第一行：关系 / 姓名 / 电话 / 职业 / 主联系 / 删除 -->
              <div class="flex flex-wrap items-end gap-3">
                <div class="w-20 shrink-0 space-y-1">
                  <span class="text-[11px] text-weak">关系</span>
                  <select
                    v-model="g.relation"
                    class="h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                  >
                    <option v-for="rel in RELATIONS" :key="rel" :value="rel">{{ rel }}</option>
                  </select>
                </div>

                <div class="min-w-[120px] flex-1 space-y-1">
                  <span class="text-[11px] text-weak">姓名</span>
                  <AppInput v-model="g.name" variant="field" width="100%" placeholder="监护人姓名" data-test="guardian-name" />
                </div>

                <div class="min-w-[130px] flex-1 space-y-1">
                  <span class="text-[11px] text-weak">联系电话</span>
                  <AppInput v-model="g.phone" variant="field" width="100%" placeholder="手机号" data-test="guardian-phone" />
                </div>

                <div class="w-28 shrink-0 space-y-1">
                  <span class="text-[11px] text-weak">职业</span>
                  <AppInput
                    v-model="g.occupation"
                    variant="field"
                    width="100%"
                    placeholder="选填"
                    data-test="guardian-occupation"
                  />
                </div>

                <label class="flex cursor-pointer items-center gap-1 pb-1.5 text-fine text-weak">
                  <input
                    type="radio"
                    name="primary_guardian"
                    :checked="g.is_primary"
                    class="text-primary focus:ring-0"
                    @change="setPrimaryGuardian(idx)"
                  />
                  <span>主联系</span>
                </label>

                <button
                  type="button"
                  data-test="remove-guardian-btn"
                  class="mb-0.5 inline-flex h-8 w-8 items-center justify-center rounded-sm text-weak hover:bg-parchment hover:text-danger"
                  title="删除此监护人"
                  @click="removeGuardian(idx)"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>

              <!-- 第二行：风格标签（预设候选可增删；填充色按 AI 判定的情感倾向，未配置时留白） -->
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-[11px] text-weak">风格标签</span>

                <!-- 已选标签胶囊 -->
                <span
                  v-for="(tag, ti) in g.tags"
                  :key="tag"
                  data-test="guardian-tag-chip"
                  class="inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px] transition-colors"
                  :class="selectedChipClass(tag)"
                >
                  {{ tag }}
                  <button
                    type="button"
                    class="opacity-60 hover:opacity-100"
                    :title="`移除标签 ${tag}`"
                    @click="removeTag(idx, ti)"
                  >
                    ×
                  </button>
                </span>

                <input
                  v-model="tagDrafts[idx]"
                  data-test="guardian-tag-input"
                  class="h-6 w-24 rounded-pill border border-hairline bg-canvas px-2 text-[11px] text-ink outline-none placeholder:text-faint focus:border-primary-focus"
                  placeholder="+ 回车添加"
                  @keydown="onTagKeydown($event, idx)"
                />
                <button
                  v-if="(tagDrafts[idx] ?? '').trim()"
                  type="button"
                  data-test="save-preset-btn"
                  class="text-[11px] text-weak underline-offset-2 hover:text-primary hover:underline"
                  title="保存为常用预设，方便下次直接点选"
                  @click="savePresetFromDraft(idx)"
                >
                  存为预设
                </button>

                <!-- 预设候选胶囊：点击添加，× 删除该预设 -->
                <span
                  v-for="preset in presets.filter((t) => !g.tags.includes(t))"
                  :key="preset"
                  data-test="guardian-tag-preset"
                  class="inline-flex items-center gap-0.5 rounded-pill px-2 py-0.5 text-[11px] transition-colors"
                  :class="presetChipClass(preset) || 'border border-hairline bg-canvas text-weak'"
                >
                  <button
                    type="button"
                    class="hover:underline"
                    :title="`添加标签 ${preset}`"
                    @click="addTag(idx, preset)"
                  >
                    + {{ preset }}
                  </button>
                  <button
                    type="button"
                    data-test="remove-preset-btn"
                    class="opacity-50 hover:opacity-100"
                    :title="`删除预设标签 ${preset}`"
                    @click="deletePreset(preset)"
                  >
                    ×
                  </button>
                </span>
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
