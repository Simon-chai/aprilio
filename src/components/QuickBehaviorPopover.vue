<script setup lang="ts">
/**
 * 快捷表现卡片（spec §5.2）：
 * 460px 轻量浮层，老师 2~3 秒完成一次日常表现记录。
 * 维度胶囊 → 倾向切换 → 气泡点选/手输评语 → Enter 保存，全程原地闭环。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { createBehaviorDimension, listBehaviorDimensions, listCommentPresets, addBehaviorRecord } from "../lib/db";
import { recommendComments } from "../lib/behavior-ai";
import { localDateStr } from "../lib/format";
import type { BehaviorDimension, BehaviorPolarity, CommentPreset, Student, StudentRow } from "../types";

const props = defineProps<{
  open: boolean;
  student: Student | StudentRow | null;
  students?: (Student | StudentRow)[];
  /** 触发按钮的视口坐标（getBoundingClientRect），卡片据此就近锚定 */
  anchor: { x: number; y: number } | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }];
}>();

const activeStudentId = ref<number | null>(null);

watch(
  () => [props.student, props.students],
  () => {
    if (props.student) {
      activeStudentId.value = props.student.id;
    } else if (props.students?.length) {
      if (!activeStudentId.value || !props.students.some((s) => s.id === activeStudentId.value)) {
        activeStudentId.value = props.students[0].id;
      }
    } else {
      activeStudentId.value = null;
    }
  },
  { immediate: true }
);

const effectiveStudent = computed<Student | StudentRow | null>(() => {
  if (props.students?.length) {
    return props.students.find((s) => s.id === activeStudentId.value) ?? props.students[0];
  }
  return props.student;
});

const CARD_WIDTH = 460;
const CARD_EST_HEIGHT = 560;

const dimensions = ref<BehaviorDimension[]>([]);
const dimensionId = ref<number | null>(null);
const polarity = ref<BehaviorPolarity>("praise");
const comment = ref("");
const recordDate = ref(localDateStr());
const presets = ref<CommentPreset[]>([]);
const aiItems = ref<string[]>([]);
const aiLoading = ref(false);
const saving = ref(false);
const hint = ref(false);
const saveError = ref("");
const shaking = ref(false);
const customAdding = ref(false);
const customName = ref("");
const customError = ref("");

const textareaRef = ref<HTMLTextAreaElement | null>(null);

const dateMin = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() - 14);
  return localDateStr(d);
});
const dateMax = computed(() => localDateStr());

const currentDimension = computed(() => dimensions.value.find((d) => d.id === dimensionId.value) ?? null);

const CATEGORY_LABEL: Record<string, string> = {
  study: "学习类",
  behavior: "行为类",
  other: "扩展",
};
const groupedDimensions = computed(() => {
  const groups: { key: string; label: string; items: BehaviorDimension[] }[] = [];
  for (const key of ["study", "behavior", "other"]) {
    const items = dimensions.value.filter((d) => d.category === key);
    if (items.length) groups.push({ key, label: CATEGORY_LABEL[key], items });
  }
  return groups;
});

/* ---------------- 浮层定位：按钮下方就近弹出，越界自动收拢 ---------------- */
const pos = computed(() => {
  const margin = 12;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const a = props.anchor ?? { x: vw / 2, y: vh / 2 };
  let left = a.x - CARD_WIDTH + 24;
  if (left + CARD_WIDTH > vw - margin) left = vw - CARD_WIDTH - margin;
  if (left < margin) left = margin;
  let top = a.y + 10;
  if (top + CARD_EST_HEIGHT > vh - margin) top = Math.max(margin, a.y - CARD_EST_HEIGHT - 10);
  return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
});

/* ---------------- 打开初始化 / 推荐刷新 ---------------- */

let suggestToken = 0;

async function refreshSuggestions() {
  const dimId = dimensionId.value;
  if (dimId == null) {
    presets.value = [];
    aiItems.value = [];
    return;
  }
  const token = ++suggestToken;
  // 维度/倾向一变化就先清空旧推荐：否则新请求返回前，紫色气泡会一直显示上一次倾向的评语，看起来「换了倾向推荐却没变」
  aiItems.value = [];
  aiLoading.value = true;
  const list = await listCommentPresets(dimId, polarity.value);
  if (token !== suggestToken) return;
  presets.value = list;
  const res = await recommendComments({
    studentName: effectiveStudent.value?.name ?? "",
    dimensionName: currentDimension.value?.name ?? "",
    dimensionId: dimId,
    polarity: polarity.value,
    frequent: list.map((p) => p.content),
  });
  if (token !== suggestToken) return;
  // 只有真 AI 生成才走紫色气泡；回落预设时避免冒充 AI 推荐
  aiItems.value = res.source === "ai" ? res.items : [];
  aiLoading.value = false;
}

async function init() {
  if (!props.open || !effectiveStudent.value) return;
  comment.value = "";
  polarity.value = "praise";
  saving.value = false;
  hint.value = false;
  saveError.value = "";
  customAdding.value = false;
  customName.value = "";
  customError.value = "";
  recordDate.value = localDateStr();
  dimensions.value = await listBehaviorDimensions();
  dimensionId.value = dimensions.value[0]?.id ?? null;
  await refreshSuggestions();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void init();
      document.addEventListener("keydown", onEscKey);
    } else {
      document.removeEventListener("keydown", onEscKey);
    }
  },
  { immediate: true }
);
onBeforeUnmount(() => document.removeEventListener("keydown", onEscKey));

function onEscKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

watch([dimensionId, polarity, activeStudentId], () => {
  void refreshSuggestions();
});

/* ---------------- 气泡注入 / 保存 ---------------- */

async function applyComment(text: string) {
  comment.value = text;
  hint.value = false;
  saveError.value = "";
  await nextTick();
  const el = textareaRef.value;
  if (el) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

async function save(keepOpen: boolean) {
  if (saving.value || !effectiveStudent.value) return;
  const text = comment.value.trim();
  if (!text) {
    hint.value = true;
    saveError.value = "";
    // 重触发抖动动画
    shaking.value = false;
    await nextTick();
    shaking.value = true;
    setTimeout(() => (shaking.value = false), 400);
    return;
  }
  const dim = currentDimension.value;
  if (!dim) {
    saveError.value = "请先选择评价维度";
    return;
  }
  if (recordDate.value > dateMax.value) {
    saveError.value = "不能录入未来日期";
    return;
  }
  if (recordDate.value < dateMin.value) {
    saveError.value = "仅支持补录最近两周以内的表现";
    return;
  }

  saving.value = true;
  saveError.value = "";
  try {
    await addBehaviorRecord({
      student_id: effectiveStudent.value.id,
      dimension_id: dim.id,
      dimension_name_snap: dim.name,
      category_snap: dim.category,
      type: polarity.value,
      comment: text,
      recorded_date: recordDate.value,
    });
    emit("saved", {
      studentName: effectiveStudent.value.name,
      dimensionName: dim.name,
      polarity: polarity.value,
    });
    if (keepOpen) {
      // 连贯记录：清空输入、维度保持，卡片不关
      comment.value = "";
      hint.value = false;
      await refreshSuggestions();
      await nextTick();
      textareaRef.value?.focus();
    } else {
      emit("close");
    }
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/* ---------------- 自定义维度 ---------------- */

async function confirmCustom() {
  customError.value = "";
  try {
    const dim = await createBehaviorDimension(customName.value);
    dimensions.value = await listBehaviorDimensions();
    dimensionId.value = dim.id;
    customAdding.value = false;
    customName.value = "";
  } catch (e) {
    customError.value = e instanceof Error ? e.message : String(e);
  }
}

function cancelCustom() {
  customAdding.value = false;
  customName.value = "";
  customError.value = "";
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：点击空白处关闭 -->
    <Transition name="qb-fade">
      <div v-if="open && effectiveStudent" class="fixed inset-0 z-40" @click="emit('close')" />
    </Transition>

    <Transition name="qb-pop">
      <div
        v-if="open && effectiveStudent"
        data-test="quick-card"
        class="fixed z-50 w-[460px] rounded-lg border border-hairline bg-canvas p-5 shadow-[var(--shadow-window)]"
        :style="pos"
      >
        <!-- 头部：学生名 + 日期 + 关闭 -->
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-body font-semibold tracking-tight text-ink shrink-0">为</span>
            <select
              v-if="students && students.length > 1"
              v-model="activeStudentId"
              class="h-7 rounded-md border border-hairline bg-pearl px-2 text-fine font-semibold text-primary outline-none focus:border-primary max-w-[130px] truncate"
            >
              <option v-for="s in students" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <span v-else class="text-body font-semibold tracking-tight text-ink truncate">「{{ effectiveStudent.name }}」</span>
            <span class="text-body font-semibold tracking-tight text-ink shrink-0">记录日常表现</span>
          </div>
          <div class="flex items-center gap-2">
            <input
              v-model="recordDate"
              data-test="record-date"
              type="date"
              :min="dateMin"
              :max="dateMax"
              class="rounded-md border border-hairline bg-pearl px-2 py-1 text-fine text-muted outline-none focus:border-primary"
            />
            <button
              data-test="close-btn"
              class="flex h-6 w-6 items-center justify-center rounded-full text-weak transition-colors hover:bg-parchment hover:text-ink"
              aria-label="关闭"
              @click="emit('close')"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- 事项维度 -->
        <div class="mt-4 space-y-2">
          <p class="text-fine text-weak">事项维度</p>
          <div v-for="group in groupedDimensions" :key="group.key" class="flex items-center gap-2">
            <span class="w-11 shrink-0 text-fine text-faint">{{ group.label }}</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="d in group.items"
                :key="d.id"
                data-test="dimension-chip"
                class="rounded-full px-3 py-1 text-fine transition-colors"
                :class="
                  dimensionId === d.id
                    ? 'bg-tile font-medium text-white'
                    : 'bg-parchment text-muted hover:bg-hairline'
                "
                @click="dimensionId = d.id"
              >
                {{ d.name }}
              </button>
              <!-- 自定义入口挂在最后一个分组行尾 -->
              <template v-if="group.key === groupedDimensions[groupedDimensions.length - 1]?.key">
                <button
                  v-if="!customAdding"
                  data-test="add-dimension-btn"
                  class="rounded-full border border-dashed border-hairline px-3 py-1 text-fine text-weak transition-colors hover:border-primary hover:text-primary"
                  @click="customAdding = true"
                >
                  + 自定义
                </button>
                <span v-else class="flex items-center gap-1.5">
                  <input
                    v-model="customName"
                    data-test="custom-dimension-input"
                    placeholder="如：体育健康"
                    maxlength="12"
                    class="w-28 rounded-md border border-hairline bg-pearl px-2 py-1 text-fine outline-none focus:border-primary"
                    @keydown.enter.prevent="confirmCustom"
                  />
                  <button
                    data-test="custom-dimension-confirm"
                    class="rounded-full bg-tile px-2.5 py-1 text-fine text-white"
                    @click="confirmCustom"
                  >
                    确定
                  </button>
                  <button data-test="custom-dimension-cancel" class="text-fine text-weak hover:text-ink" @click="cancelCustom">
                    取消
                  </button>
                  <span v-if="customError" data-test="custom-dimension-error" class="text-fine text-danger">
                    {{ customError }}
                  </span>
                </span>
              </template>
            </div>
          </div>
        </div>

        <!-- 评价倾向 -->
        <div class="mt-4">
          <p class="text-fine text-weak">评价倾向</p>
          <div class="mt-1.5 flex gap-2">
            <button
              data-test="polarity-praise"
              class="flex-1 rounded-md px-3 py-1.5 text-caption font-medium transition-colors"
              :class="polarity === 'praise' ? 'bg-[#e8f5e9] text-[#248a3d]' : 'bg-parchment text-muted hover:bg-hairline'"
              @click="polarity = 'praise'"
            >
              👍 表扬
            </button>
            <button
              data-test="polarity-neutral"
              class="flex-1 rounded-md px-3 py-1.5 text-caption font-medium transition-colors"
              :class="polarity === 'neutral' ? 'bg-[#e8e8ed] text-ink' : 'bg-parchment text-muted hover:bg-hairline'"
              @click="polarity = 'neutral'"
            >
              ➖ 中立
            </button>
            <button
              data-test="polarity-improve"
              class="flex-1 rounded-md px-3 py-1.5 text-caption font-medium transition-colors"
              :class="polarity === 'improve' ? 'bg-[#fdeef0] text-[#d70015]' : 'bg-parchment text-muted hover:bg-hairline'"
              @click="polarity = 'improve'"
            >
              ⚠️ 待改进
            </button>
          </div>
        </div>

        <!-- 推荐评语 -->
        <div class="mt-4">
          <p class="text-fine text-weak">推荐评语（点击填入）</p>
          <div class="mt-1.5 flex flex-wrap gap-1.5">
            <template v-if="aiItems.length">
              <button
                v-for="(t, i) in aiItems"
                :key="`ai-${i}`"
                data-test="ai-bubble"
                class="rounded-full border border-[#e3d9ff] bg-[#f5f1ff] px-3 py-1 text-fine text-[#6d28d9] transition-colors hover:bg-[#ede4ff]"
                @click="applyComment(t)"
              >
                ✨ AI：{{ t }}
              </button>
            </template>
            <span v-else-if="aiLoading" class="text-fine text-weak typing-dots">AI 正在构思推荐</span>
            <button
              v-for="p in presets"
              :key="p.id"
              data-test="preset-bubble"
              class="max-w-full truncate rounded-full border border-hairline bg-pearl px-3 py-1 text-fine text-muted transition-colors hover:bg-parchment hover:text-ink"
              @click="applyComment(p.content)"
            >
              🕒 {{ p.content }}
            </button>
          </div>
        </div>

        <!-- 评语正文 -->
        <div class="mt-4">
          <p class="text-fine text-weak">评语正文</p>
          <div class="mt-1.5" :class="{ 'qb-shake': shaking }">
            <textarea
              ref="textareaRef"
              v-model="comment"
              data-test="comment-input"
              rows="3"
              placeholder="输入评语，Enter 快速保存；Shift+Enter 换行"
              class="w-full resize-none rounded-md border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none transition-colors focus:border-primary"
              @keydown.enter.exact.prevent="save(false)"
              @input="hint = false; saveError = ''"
            />
          </div>
          <p v-if="hint" data-test="empty-hint" class="mt-1 text-fine text-danger">请输入或选择评语</p>
          <p v-else-if="saveError" data-test="save-error" class="mt-1 text-fine text-danger">{{ saveError }}</p>
        </div>

        <!-- 底部操作 -->
        <div class="mt-4 flex items-center justify-between">
          <span class="text-fine text-faint">按 Enter 快速保存</span>
          <div class="flex items-center gap-2">
            <button
              data-test="save-next-btn"
              class="rounded-full bg-parchment px-3.5 py-1.5 text-caption text-muted transition-colors hover:bg-hairline hover:text-ink"
              @click="save(true)"
            >
              保存并记下一条
            </button>
            <button
              data-test="save-btn"
              class="rounded-full bg-primary px-4 py-1.5 text-caption font-medium text-white transition-colors hover:bg-primary-focus"
              @click="save(false)"
            >
              {{ saving ? "保存中…" : "保存" }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.qb-pop-enter-active,
.qb-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.qb-pop-enter-from,
.qb-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(4px);
}
.qb-fade-enter-active,
.qb-fade-leave-active {
  transition: opacity 0.15s ease;
}
.qb-fade-enter-from,
.qb-fade-leave-to {
  opacity: 0;
}
.qb-shake {
  animation: qb-shake 0.36s ease;
}
@keyframes qb-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-5px);
  }
  50% {
    transform: translateX(5px);
  }
  75% {
    transform: translateX(-3px);
  }
}
</style>
