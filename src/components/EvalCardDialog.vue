<script setup lang="ts">
/**
 * 学生评价卡片对话框（spec：docs/EVAL_CARD.md）：
 * 选周期 → 聚合该生数据 → 实时预览 A 版卡片 HTML →（可选）改寄语/开水印 → 导出 PNG。
 * 数据聚合在 lib/eval-card.ts，模板在 lib/eval-card-template.ts，导出在 lib/eval-card-export.ts。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppDialog from "./ui/AppDialog.vue";
import AiPolishButton from "./ui/AiPolishButton.vue";
import { useToast } from "../composables/useToast";
import { localDateStr } from "../lib/format";
import {
  aggregateEvalCard,
  evalCardFileName,
  evalCardRange,
  isValidEvalCardRange,
  type EvalCardPeriodPreset,
  type EvalCardView,
} from "../lib/eval-card";
import { buildEvalCardHtml } from "../lib/eval-card-template";
import { exportEvalCardHtml } from "../lib/eval-card-export";

const props = defineProps<{ open: boolean; studentId: number }>();
const emit = defineEmits<{ close: [] }>();

const toast = useToast();

const PRESETS: { key: EvalCardPeriodPreset; label: string }[] = [
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "thisSemester", label: "本学期" },
  { key: "custom", label: "自定义" },
];

const preset = ref<EvalCardPeriodPreset>("thisMonth");
const now0 = new Date();
const customStart = ref(localDateStr(new Date(now0.getFullYear(), now0.getMonth(), 1)));
const customEnd = ref(localDateStr(now0));
const watermark = ref(true);
const comment = ref("");
const commentTouched = ref(false);
const view = ref<EvalCardView | null>(null);
const loading = ref(false);
const loadError = ref("");
const exporting = ref(false);

const customInvalid = computed(
  () =>
    preset.value === "custom" &&
    !isValidEvalCardRange(customStart.value, customEnd.value)
);

// 聚合请求带序号：连续切换周期时只采纳最后一次结果
let aggSeq = 0;
async function refresh() {
  if (!props.open || !props.studentId || customInvalid.value) {
    view.value = null;
    return;
  }
  const seq = ++aggSeq;
  loading.value = true;
  loadError.value = "";
  try {
    const range = evalCardRange(preset.value, { start: customStart.value, end: customEnd.value });
    const next = await aggregateEvalCard(props.studentId, range);
    if (seq !== aggSeq) return;
    view.value = next;
    // 老师没动过寄语时跟随学期评语；动过则保留手输内容
    if (!commentTouched.value) comment.value = next.comment;
  } catch (e) {
    if (seq !== aggSeq) return;
    view.value = null;
    loadError.value = e instanceof Error ? e.message : "数据加载失败";
  } finally {
    if (seq === aggSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.studentId, preset.value, customStart.value, customEnd.value] as const,
  ([open]) => {
    if (open) void refresh();
    else {
      aggSeq += 1;
      view.value = null;
      loading.value = false;
    }
  }
);

// 弹窗打开（含换学生后再次打开）时重置寄语编辑状态；开着改周期不重置
watch(
  () => (props.open ? props.studentId : 0),
  () => {
    if (props.open) commentTouched.value = false;
  }
);

const cardHtml = computed(() =>
  view.value
    ? buildEvalCardHtml(view.value, { watermark: watermark.value, comment: comment.value })
    : ""
);

// 预览 iframe 高度跟随卡片实际高度（卡片 min-height 1240，内容多时可再长）
const previewHeight = ref("1264px");
function onPreviewLoad(e: Event) {
  try {
    const card = (e.target as HTMLIFrameElement).contentDocument?.querySelector(".card");
    if (card) previewHeight.value = `${Math.ceil(card.getBoundingClientRect().height)}px`;
  } catch {
    /* 预览高度只是体验优化，失败保持默认 */
  }
}

const polishContext = computed(() => {
  if (!view.value) return "";
  const highlights = view.value.tags.length ? `，本阶段亮点：${view.value.tags.join("、")}` : "";
  return `${view.value.name}（${view.value.className} · ${view.value.periodLabel}）${highlights}`;
});

async function onExport() {
  if (!cardHtml.value || exporting.value || !view.value) return;
  exporting.value = true;
  try {
    const saved = await exportEvalCardHtml(cardHtml.value, evalCardFileName(view.value));
    if (saved) toast(`已保存：${saved}`, { tone: "success" });
  } catch (e) {
    toast(e instanceof Error ? e.message : "导出失败，请重试", { tone: "error" });
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <AppDialog
    :open="props.open"
    title="学生评价卡片"
    description="按周期汇总该生的成绩、表现与作业，生成可发给家长的图文卡片"
    width="lg"
    @close="emit('close')"
  >
    <div class="flex gap-5" data-test="eval-card-dialog">
      <!-- 左：控制列 -->
      <div class="w-[232px] shrink-0 space-y-4">
        <div>
          <p class="mb-2 text-caption font-semibold text-ink">统计周期</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="p in PRESETS"
              :key="p.key"
              type="button"
              class="rounded-pill border px-3 py-1 text-fine transition-colors"
              :class="
                preset === p.key
                  ? 'border-primary bg-primary-soft font-semibold text-primary'
                  : 'border-hairline text-muted hover:border-primary'
              "
              :data-test="`eval-card-preset-${p.key}`"
              @click="preset = p.key"
            >
              {{ p.label }}
            </button>
          </div>
          <div v-if="preset === 'custom'" class="mt-2 space-y-1.5">
            <input
              v-model="customStart"
              type="date"
              data-test="eval-card-start"
              class="w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-caption text-ink outline-none focus:border-primary"
            />
            <input
              v-model="customEnd"
              type="date"
              data-test="eval-card-end"
              class="w-full rounded-md border border-hairline bg-canvas px-2 py-1.5 text-caption text-ink outline-none focus:border-primary"
            />
            <p v-if="customInvalid" class="text-fine text-danger">开始日期需早于或等于结束日期</p>
          </div>
        </div>

        <label class="flex cursor-pointer items-center gap-2 text-caption text-muted">
          <input
            v-model="watermark"
            type="checkbox"
            data-test="eval-card-watermark"
            class="h-3.5 w-3.5 accent-primary"
          />
          学生姓名水印
        </label>

        <div>
          <p class="mb-1 text-caption font-semibold text-ink">老师寄语</p>
          <textarea
            v-model="comment"
            rows="6"
            maxlength="300"
            data-test="eval-card-comment"
            placeholder="写给家长的话，可留空（默认带出本学期评语）"
            class="w-full resize-none rounded-md border border-hairline bg-canvas px-2.5 py-2 text-caption leading-relaxed text-ink outline-none focus:border-primary"
            @input="commentTouched = true"
          ></textarea>
          <AiPolishButton
            :text="comment"
            scene="学生评价卡片寄语"
            hint="写在发家长看的学生阶段表现卡片上，语气亲切、面向家长"
            :context="polishContext"
            :max-len="300"
            size="sm"
            @apply="comment = $event; commentTouched = true"
          />
        </div>
      </div>

      <!-- 右：预览列 -->
      <div class="min-w-0 flex-1">
        <div
          class="max-h-[64vh] overflow-auto rounded-md border border-hairline bg-pearl p-3"
          data-test="eval-card-preview"
        >
          <p v-if="loading" class="py-20 text-center text-caption text-weak">正在汇总数据…</p>
          <p v-else-if="loadError" class="py-20 text-center text-caption text-danger">
            {{ loadError }}
          </p>
          <p v-else-if="customInvalid" class="py-20 text-center text-caption text-weak">
            请选择有效的统计周期
          </p>
          <iframe
            v-else-if="cardHtml"
            :srcdoc="cardHtml"
            title="评价卡片预览"
            class="block origin-top-left border-0 bg-white"
            :style="{ width: '750px', zoom: 0.5, height: previewHeight }"
            @load="onPreviewLoad"
          ></iframe>
        </div>
        <p class="mt-2 text-fine text-weak">
          导出为 2 倍清晰度 PNG{{ watermark ? "，已叠加学生姓名水印" : "" }}；发送前请自行确认内容适合该家长。
        </p>
      </div>
    </div>

    <template #footer>
      <div class="flex items-center justify-end gap-2">
        <AppButton variant="secondary" @click="emit('close')">关闭</AppButton>
        <AppButton
          :disabled="!cardHtml || exporting"
          data-test="eval-card-export"
          @click="onExport"
        >
          {{ exporting ? "正在导出…" : "导出 PNG" }}
        </AppButton>
      </div>
    </template>
  </AppDialog>
</template>
