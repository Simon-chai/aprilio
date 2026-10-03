<script setup lang="ts">
/**
 * 家校沟通总结面板（学生档案「家校沟通」页签）：
 * 按指定时段内该生的评价生成给家长的表现总结。
 * - 生成后可在下方补充个性化要求重新生成（聊天式多轮重写，同一线程）
 * - 应用到档案 = 确认后写入该生对应学期的学期评语；复制一键带走
 * - 无 AI 不阻塞：未配置模型 / 生成失败时可手动填写后应用
 * Agent 发起（generate_parent_summary 单生目标）经 useParentSummaryPanel 预设
 * 自动打开本页签并开始生成。
 */
import { computed, reactive, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import {
  consumeParentSummaryPanel,
  useParentSummaryPanel,
  type ParentSummaryRangePreset,
} from "../composables/useParentSummary";
import {
  getTermComment,
  isTauri,
  listBehaviorRecords,
  upsertTermComment,
} from "../lib/db";
import { localDateStr } from "../lib/format";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import {
  buildParentSummaryMaterial,
  filterBehaviorsByRange,
  rangeLabel,
  targetSemesterOfRange,
  type SummaryTurn,
} from "../lib/parent-summary";
import { buildSummaryMessages, requestParentSummary } from "../lib/parent-summary-ai";
import { recentSemesters } from "../lib/semester";
import { resolveReportRange } from "../lib/report";
import { semesterLabel } from "../lib/timetable";
import type { AgentMessage } from "../agent/types";
import type { ReportRange, StudentBehaviorRecord } from "../types";

const props = defineProps<{
  studentId: number;
  studentName: string;
  gradeClass: string;
  /** 学生档案当前选中的学期（面板按学期模式的默认值，可自行切换） */
  semester: string;
}>();

const toast = useToast();
const panelPreset = useParentSummaryPanel();

/* ---------------- 该生表现流水与时间范围 ---------------- */

/** 该生全部表现流水：范围过滤在内存里做，切时段不重查库 */
const records = ref<StudentBehaviorRecord[]>([]);
const loading = ref(false);

const mode = ref<"semester" | "custom">("semester");
const semester = ref(props.semester);
const semesterOptions = ref<string[]>(recentSemesters(8));
const customStart = ref(localDateStr(new Date(new Date().setDate(1))));
const customEnd = ref(localDateStr());

// 学生档案顶部学期切换时，按学期模式的范围跟着走（自定义模式不打扰）
watch(
  () => props.semester,
  (s) => {
    if (mode.value === "semester") semester.value = s;
  }
);

function resolveCurrentRange(): ReportRange {
  return resolveReportRange(
    mode.value === "semester"
      ? { mode: "semester", semester: semester.value }
      : { mode: "custom", start: customStart.value, end: customEnd.value }
  );
}

/** 应用到档案的目标学期（随范围联动；日期非法时给个中性文案，不阻塞渲染） */
const applySemesterLabel = computed(() => {
  try {
    return semesterLabel(targetSemesterOfRange(resolveCurrentRange()));
  } catch {
    return "对应学期";
  }
});

const aiReady = computed(() => isTauri() && isAiConfigured(loadAiConfig()));

const material = computed(() => {
  let range: ReportRange;
  try {
    range = resolveCurrentRange();
  } catch {
    return null;
  }
  return buildParentSummaryMaterial(filterBehaviorsByRange(records.value, range.start, range.end));
});

/* ---------------- 生成状态（单任务：线程 + 当前版总结） ---------------- */

const job = reactive({
  status: "idle" as "idle" | "running" | "done" | "failed",
  turns: [] as SummaryTurn[],
  thread: [] as AgentMessage[],
  current: "",
  applied: false,
  source: "manual" as "ai" | "manual",
  error: "",
});

const lastAssistantIndex = computed(() => {
  for (let i = job.turns.length - 1; i >= 0; i--) if (job.turns[i].role === "assistant") return i;
  return -1;
});

const requirementInput = ref("");

async function loadRecords() {
  loading.value = true;
  try {
    records.value = await listBehaviorRecords(props.studentId, 2000);
  } finally {
    loading.value = false;
  }
}

/**
 * 生成一版总结：fresh = 以当前素材重建线程（首启 / 线程为空）；
 * 否则在既有线程上续写（补充要求；留空 = 按既有要求重写一版）。
 * 失败回滚线程与展示记录，重试不残留半截对话。
 */
async function generate(opts: { requirement?: string; fresh?: boolean } = {}) {
  let range: ReportRange;
  try {
    range = resolveCurrentRange();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
    return;
  }
  if (job.status === "running") return;

  const mat = buildParentSummaryMaterial(filterBehaviorsByRange(records.value, range.start, range.end));
  const snapshotThread = [...job.thread];
  const snapshotTurns = [...job.turns];
  const requirement = opts.requirement?.trim() ?? "";
  if (opts.fresh || job.thread.length === 0) {
    job.thread = buildSummaryMessages({
      studentName: props.studentName,
      gradeClass: props.gradeClass,
      rangeText: rangeLabel(range),
      material: mat.text,
      requirement,
    });
    job.turns = requirement ? [{ role: "user", text: requirement }] : [];
  } else {
    const text = requirement || "请在保持已有要求的基础上，重新写一版总结。";
    job.thread.push({ role: "user", content: text });
    job.turns.push({ role: "user", text });
  }

  job.status = "running";
  job.error = "";
  const text = await requestParentSummary(job.thread);
  if (text) {
    job.turns.push({ role: "assistant", text });
    job.current = text;
    job.status = "done";
    job.source = "ai";
  } else {
    job.thread = snapshotThread;
    job.turns = snapshotTurns;
    job.status = "failed";
    job.error = aiReady.value
      ? "AI 生成失败，可重试、补充要求，或手动填写后应用"
      : "未配置 AI：可在「设置」配置模型后生成，或直接手动填写后应用";
  }
}

async function onRegenerate() {
  if (job.status === "running") return;
  const requirement = requirementInput.value.trim();
  requirementInput.value = "";
  await generate({ requirement });
}

function onRequirementKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    void onRegenerate();
  }
}

/* ---------------- 应用到档案 / 复制 ---------------- */

async function applyToProfile() {
  const text = job.current.trim();
  if (!text) {
    toast("还没有可应用的总结", { tone: "error" });
    return;
  }
  let range: ReportRange;
  try {
    range = resolveCurrentRange();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
    return;
  }
  try {
    const semesterOf = targetSemesterOfRange(range);
    const existing = await getTermComment(props.studentId, semesterOf);
    const ok = await confirmAction({
      title: `应用到「${props.studentName}」的学生档案`,
      message: existing?.content
        ? `这段总结将写入${semesterLabel(semesterOf)}的学期评语，覆盖已有评语（原内容不可恢复）。确定应用？`
        : `这段总结将写入${semesterLabel(semesterOf)}的学期评语，可在「学期评语」页签查看。确定应用？`,
      confirmText: "应用到档案",
    });
    if (!ok) return;
    // 来源口径同学期评语面板：AI 生成且正文未被手改 → ai；手填 / 手改 → manual
    const lastAssistant = [...job.turns].reverse().find((t) => t.role === "assistant");
    const source = job.source === "ai" && lastAssistant && lastAssistant.text === text ? "ai" : "manual";
    await upsertTermComment(props.studentId, semesterOf, text, source);
    job.applied = true;
    job.source = source;
    toast(`已写入${semesterLabel(semesterOf)}学期评语`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

async function copySummary() {
  const text = job.current.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制总结内容");
  } catch {
    toast("复制失败，请手动选择文本复制", { tone: "error" });
  }
}

/* ---------------- 挂载 / 预设消费（Agent 发起自动生成） ---------------- */

function applyRangePreset(preset: ParentSummaryRangePreset | null) {
  if (preset?.mode === "custom" && preset.start && preset.end) {
    mode.value = "custom";
    customStart.value = preset.start;
    customEnd.value = preset.end;
    return;
  }
  mode.value = "semester";
  semester.value =
    preset?.semester && /^\d{4}-\d{4}-[12]$/.test(preset.semester) ? preset.semester : props.semester;
}

watch(
  () => [props.studentId, panelPreset.seq] as const,
  async ([studentId]) => {
    await loadRecords();
    if (panelPreset.studentId === studentId) {
      applyRangePreset(panelPreset.range);
      if (panelPreset.autoStart) {
        void generate({ fresh: true, requirement: panelPreset.requirement });
      }
      consumeParentSummaryPanel();
    } else {
      // 非预设进入：重置为当前学期的空状态（草稿不跨学生复用）
      mode.value = "semester";
      semester.value = props.semester;
      job.status = "idle";
      job.turns = [];
      job.thread = [];
      job.current = "";
      job.applied = false;
      job.source = "manual";
      job.error = "";
      requirementInput.value = "";
    }
  },
  { immediate: true }
);
</script>

<template>
  <div class="space-y-4" data-test="parent-summary-panel">
    <!-- 范围 + 生成：窄容器保持单行横向滚动 -->
    <div class="scrollbar-none flex items-center gap-2 overflow-x-auto">
      <div class="flex shrink-0 items-center gap-1 rounded-sm bg-pearl p-0.5">
        <button
          type="button"
          data-test="summary-range-semester"
          class="rounded-sm px-3 py-1 text-caption"
          :class="mode === 'semester' ? 'grad-border-soft font-medium text-primary' : 'text-weak hover:text-ink'"
          @click="mode = 'semester'"
        >
          按学期
        </button>
        <button
          type="button"
          data-test="summary-range-custom"
          class="rounded-sm px-3 py-1 text-caption"
          :class="mode === 'custom' ? 'grad-border-soft font-medium text-primary' : 'text-weak hover:text-ink'"
          @click="mode = 'custom'"
        >
          自定义
        </button>
      </div>
      <select
        v-if="mode === 'semester'"
        v-model="semester"
        data-test="summary-semester-select"
        :disabled="job.status === 'running'"
        class="h-8 shrink-0 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus disabled:opacity-50"
      >
        <option v-for="sem in semesterOptions" :key="sem" :value="sem">{{ semesterLabel(sem) }}</option>
      </select>
      <div v-else class="flex shrink-0 items-center gap-1.5 text-caption text-weak">
        <input
          v-model="customStart"
          type="date"
          data-test="summary-start"
          :disabled="job.status === 'running'"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none disabled:opacity-50"
        />
        <span>~</span>
        <input
          v-model="customEnd"
          type="date"
          data-test="summary-end"
          :disabled="job.status === 'running'"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none disabled:opacity-50"
        />
      </div>
      <span class="min-w-2 flex-1" />
      <AppButton data-test="generate-btn" :disabled="job.status === 'running'" @click="generate({ fresh: true })">
        {{ job.status === "running" ? "生成中…" : "生成总结" }}
      </AppButton>
    </div>
    <p v-if="!aiReady" class="text-fine text-weak" data-test="ai-unavailable">
      未配置 AI：可在「设置」配置模型后生成，或直接手动填写总结后应用。
    </p>

    <p class="text-fine text-weak" data-test="material-line">
      时段内评价：共 {{ material?.total ?? 0 }} 条（表扬 {{ material?.praiseCount ?? 0 }} · 待改进
      {{ material?.improveCount ?? 0 }}）
    </p>

    <!-- 聊天线程：用户要求右浮，各版总结左浮；最后一版可编辑 -->
    <div
      class="scroll-thin max-h-80 space-y-2 overflow-y-auto rounded-md bg-parchment p-3"
      data-test="summary-thread"
    >
      <p
        v-if="!job.turns.length && job.status !== 'running'"
        class="py-6 text-center text-fine text-faint"
        data-test="thread-empty"
      >
        还没有生成总结：点上方「生成总结」，或在下方补充个性化要求后重新生成。
      </p>
      <template v-for="(turn, i) in job.turns" :key="i">
        <div v-if="turn.role === 'user'" class="flex justify-end">
          <p
            class="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-primary-soft/50 px-3 py-1.5 text-caption text-ink"
            :data-test="`requirement-bubble-${i}`"
          >
            {{ turn.text }}
          </p>
        </div>
        <div v-else class="flex justify-start">
          <textarea
            v-if="i === lastAssistantIndex"
            v-model="job.current"
            rows="5"
            data-test="summary-current"
            class="scroll-thin w-full resize-y rounded-lg rounded-tl-sm border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none focus:border-primary-focus"
          />
          <p
            v-else
            class="max-w-[90%] whitespace-pre-wrap rounded-lg rounded-tl-sm border border-hairline bg-canvas px-3 py-1.5 text-caption leading-relaxed text-muted"
          >
            {{ turn.text }}
          </p>
        </div>
      </template>
      <p v-if="job.status === 'running'" class="text-fine text-primary" data-test="summary-running">正在生成…</p>
      <p v-if="job.status === 'failed'" class="text-fine text-danger" data-test="summary-error">{{ job.error }}</p>
    </div>

    <!-- 无生成版本时：手动填写区（无 AI 也不阻塞应用） -->
    <textarea
      v-if="lastAssistantIndex < 0"
      v-model="job.current"
      rows="3"
      data-test="summary-manual-input"
      placeholder="手动填写总结（无 AI 也可填写后应用到档案）…"
      class="scroll-thin w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none focus:border-primary-focus"
    />

    <!-- 补充要求 + 应用 / 复制 -->
    <div class="space-y-2">
      <div class="scrollbar-none flex items-center gap-2 overflow-x-auto">
        <input
          v-model="requirementInput"
          data-test="requirement-input"
          placeholder="补充个性化要求后重新生成，如：多肯定课堂发言、语气轻一些；留空则重写一版"
          class="h-8 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
          @keydown="onRequirementKeydown"
        />
        <AppButton
          variant="secondary"
          data-test="regenerate-btn"
          :disabled="job.status === 'running'"
          @click="onRegenerate"
        >
          重新生成
        </AppButton>
      </div>
      <div class="flex items-center justify-between gap-2">
        <p class="min-w-0 truncate text-fine text-faint">
          应用到档案 = 写入{{ applySemesterLabel }}学期评语，可在「学期评语」页签查看
        </p>
        <div class="flex shrink-0 items-center gap-2">
          <AppButton variant="pearl" data-test="copy-summary-btn" :disabled="!job.current.trim()" @click="copySummary">
            复制
          </AppButton>
          <AppButton data-test="apply-summary-btn" :disabled="!job.current.trim()" @click="applyToProfile">
            {{ job.applied ? "已应用到档案" : "应用到档案" }}
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
