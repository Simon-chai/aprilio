<script setup lang="ts">
/**
 * 家校沟通总结批量对话框（班级层，全局唯一实例挂在 App.vue）：
 * 按指定时段内的评价，对本班学生一键批量生成给家长的表现总结。
 * - 一键全班生成：逐个学生顺序生成，进度与失败状态在左侧名单可见
 * - 逐个查看 / 应用：右侧展示当前总结（可手改），复制或一键应用到学生档案（学期评语）
 * - 聊天式个性化重写在学生档案「家校沟通」页签（跳转链接），本对话框只做批量与应用
 * 打开参数来自 useParentSummaryBatch（班级详情入口按钮 / Agent 工具共用）。
 */
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppButton from "./ui/AppButton.vue";
import AppDialog from "./ui/AppDialog.vue";
import AppIcon from "./ui/AppIcon.vue";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import {
  closeParentSummaryBatch,
  openParentSummaryPanel,
  useParentSummaryBatch,
} from "../composables/useParentSummary";
import {
  getTermComment,
  isTauri,
  listBehaviorRecordsByClass,
  listStudents,
  upsertTermComment,
} from "../lib/db";
import { localDateStr } from "../lib/format";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import {
  buildParentSummaryMaterial,
  filterBehaviorsByRange,
  targetSemesterOfRange,
} from "../lib/parent-summary";
import { buildSummaryMessages, requestParentSummary } from "../lib/parent-summary-ai";
import { recentSemesters } from "../lib/semester";
import { resolveReportRange } from "../lib/report";
import { currentSemester, semesterLabel } from "../lib/timetable";
import type { AgentMessage } from "../agent/types";
import type { ClassBehaviorRecord, ReportRange, StudentRow } from "../types";

const batchState = useParentSummaryBatch();
const toast = useToast();
const router = useRouter();

/* ---------------- 名单与表现流水（按打开预设加载） ---------------- */

const students = ref<StudentRow[]>([]);
/** 本班全部表现流水：范围过滤在内存里做，切时段不重查库 */
const records = ref<ClassBehaviorRecord[]>([]);
const loading = ref(false);
/** 已加载的班级：重开同一班级时保留已生成的草稿，换班才清空 */
let loadedClass: string | null = null;

/* ---------------- 时间范围（口径同评价报告面板） ---------------- */

const mode = ref<"semester" | "custom">("semester");
const semester = ref(currentSemester());
const semesterOptions = ref<string[]>(recentSemesters(8));
const customStart = ref(localDateStr(new Date(new Date().setDate(1))));
const customEnd = ref(localDateStr());

const rangeKey = computed(
  () => `${mode.value}|${semester.value}|${customStart.value}|${customEnd.value}`
);
/** 已与草稿对齐的范围键：范围变化 = 素材口径变了，草稿全部作废 */
let appliedRangeKey = "";
watch(rangeKey, (key) => {
  if (key === appliedRangeKey) return;
  appliedRangeKey = key;
  resetJobs();
});

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

/* ---------------- 每生生成状态（草稿 = 会话内态，应用后落档案） ---------------- */

interface SummaryJob {
  status: "idle" | "queued" | "running" | "done" | "failed";
  /** 展示记录（仅用于「应用到档案」的来源判定，不在批量界面展示线程） */
  turns: { role: "user" | "assistant"; text: string }[];
  /** 发给模型的线程 */
  thread: AgentMessage[];
  /** 当前版总结（可手改） */
  current: string;
  applied: boolean;
  source: "ai" | "manual";
  error: string;
}

const jobs = reactive(new Map<number, SummaryJob>());

function resetJobs() {
  jobs.clear();
  // 保留选中学生的任务对象：右侧工作区（含手动填写框）随选中态始终可用
  if (selectedId.value != null) ensureJob(selectedId.value);
}

function ensureJob(id: number): SummaryJob {
  const existing = jobs.get(id);
  if (existing) return existing;
  jobs.set(id, {
    status: "idle",
    turns: [],
    thread: [],
    current: "",
    applied: false,
    source: "manual",
    error: "",
  });
  // 必须返回 Map 里的响应式代理：返回局部原始对象会让后续变更不触发重渲染
  return jobs.get(id)!;
}

function statusOf(id: number): SummaryJob["status"] {
  return jobs.get(id)?.status ?? "idle";
}

const selectedId = ref<number | null>(null);
const selectedStudent = computed(() => students.value.find((s) => s.id === selectedId.value) ?? null);
const selectedJob = computed(() => (selectedId.value != null ? jobs.get(selectedId.value) ?? null : null));
// 选中即建任务对象：右侧工作区不必等首次生成才可用
watch(selectedId, (id) => {
  if (id != null) ensureJob(id);
});

const aiReady = computed(() => isTauri() && isAiConfigured(loadAiConfig()));

/** 选中学生的时段内评价素材（范围非法时显示为空，不抛错） */
const selectedMaterial = computed(() => {
  const id = selectedId.value;
  if (id == null) return null;
  let range: ReportRange;
  try {
    range = resolveCurrentRange();
  } catch {
    return null;
  }
  return buildParentSummaryMaterial(
    filterBehaviorsByRange(
      records.value.filter((r) => r.student_id === id),
      range.start,
      range.end
    )
  );
});

/* ---------------- 打开 / 加载 ---------------- */

let batchCancel = false;

watch(
  () => [batchState.open, batchState.seq] as const,
  async ([open]) => {
    if (!open) {
      batchCancel = true;
      return;
    }
    await loadPreset();
  },
  { immediate: true }
);

async function loadPreset() {
  const preset = batchState.range;
  if (preset?.mode === "custom" && preset.start && preset.end) {
    mode.value = "custom";
    customStart.value = preset.start;
    customEnd.value = preset.end;
  } else {
    mode.value = "semester";
    semester.value =
      preset?.semester && /^\d{4}-\d{4}-[12]$/.test(preset.semester)
        ? preset.semester
        : currentSemester();
  }
  appliedRangeKey = rangeKey.value;

  await loadClass(batchState.className);

  selectedId.value =
    students.value[0]?.id ?? null;

  if (batchState.autoStart) {
    void generateWholeClass(batchState.requirement);
  }
}

/** 加载名单与表现流水；换班清草稿，重开同班保留 */
async function loadClass(className: string) {
  if (className !== loadedClass) {
    resetJobs();
    loadedClass = className;
  }
  loading.value = true;
  try {
    if (className) {
      const [list, classRecords] = await Promise.all([
        listStudents("", className),
        listBehaviorRecordsByClass(className, 2000),
      ]);
      students.value = list;
      records.value = classRecords;
    } else {
      students.value = [];
      records.value = [];
    }
  } finally {
    loading.value = false;
  }
}

/* ---------------- 批量生成（顺序逐个，进度可见、可中断） ---------------- */

async function generateOne(studentId: number, requirement: string) {
  let range: ReportRange;
  try {
    range = resolveCurrentRange();
  } catch {
    return; // 范围非法在批量入口已拦截
  }
  const student = students.value.find((s) => s.id === studentId);
  if (!student) return;
  const job = ensureJob(studentId);
  if (job.status === "running") return;

  const mat = buildParentSummaryMaterial(
    filterBehaviorsByRange(
      records.value.filter((r) => r.student_id === studentId),
      range.start,
      range.end
    )
  );

  // 失败回滚快照：线程失败恢复原样，重试不重复叠加
  const snapshotThread = [...job.thread];
  const snapshotTurns = [...job.turns];
  job.thread = buildSummaryMessages({
    studentName: student.name,
    gradeClass: student.grade_class,
    rangeText:
      range.mode === "semester" && range.semester
        ? `${range.semester} 学期（${range.start}~${range.end}）`
        : `${range.start} ~ ${range.end}`,
    material: mat.text,
    requirement,
  });
  job.turns = requirement ? [{ role: "user", text: requirement }] : [];

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
    job.error = aiReady.value ? "AI 生成失败，可重试" : "未配置 AI";
  }
}

const batch = reactive({ running: false, done: 0, total: 0 });

async function generateWholeClass(requirement = "") {
  if (batch.running) return;
  if (!aiReady.value) {
    toast("未配置 AI，无法生成；可手动填写后应用到档案", { tone: "error" });
    return;
  }
  try {
    resolveCurrentRange();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
    return;
  }
  const targets = students.value.filter((s) => statusOf(s.id) !== "done");
  if (!targets.length) {
    toast("全班都已生成，可到学生档案补充要求后重新生成");
    return;
  }
  batch.running = true;
  batch.done = 0;
  batch.total = targets.length;
  batchCancel = false;
  for (const s of targets) {
    if (statusOf(s.id) === "idle") ensureJob(s.id).status = "queued";
  }
  for (const s of targets) {
    if (batchCancel) break;
    await generateOne(s.id, requirement);
    batch.done += 1;
  }
  batch.running = false;
  if (!batchCancel) {
    const failed = targets.filter((s) => statusOf(s.id) === "failed").length;
    toast(
      failed
        ? `全班生成完成，${failed} 人失败，可在左侧选中后到学生档案重试`
        : "全班生成完成，可逐个查看并应用到档案"
    );
  }
}

/** 重试当前选中学生的生成（失败态用；个性化重写请到学生档案） */
async function retrySelected() {
  const id = selectedId.value;
  if (id == null || batch.running) return;
  await generateOne(id, "");
}

/* ---------------- 应用到档案（写入学期评语） / 复制 / 跳档案 ---------------- */

async function applyToProfile(student: StudentRow) {
  const job = jobs.get(student.id);
  const text = job?.current.trim() ?? "";
  if (!job || !text) {
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
    const existing = await getTermComment(student.id, semesterOf);
    const ok = await confirmAction({
      title: `应用到「${student.name}」的学生档案`,
      message: existing?.content
        ? `这段总结将写入${semesterLabel(semesterOf)}的学期评语，覆盖已有评语（原内容不可恢复）。确定应用？`
        : `这段总结将写入${semesterLabel(semesterOf)}的学期评语，可在学生详情的「学期评语」中查看。确定应用？`,
      confirmText: "应用到档案",
    });
    if (!ok) return;
    // 来源口径同学期评语面板：AI 生成且正文未被手改 → ai；手填 / 手改 → manual
    const lastAssistant = [...job.turns].reverse().find((t) => t.role === "assistant");
    const source = job.source === "ai" && lastAssistant && lastAssistant.text === text ? "ai" : "manual";
    await upsertTermComment(student.id, semesterOf, text, source);
    job.applied = true;
    job.source = source;
    toast(`已写入 ${student.name} 的${semesterLabel(semesterOf)}学期评语`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  }
}

async function copySummary() {
  const text = selectedJob.value?.current.trim() ?? "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制总结内容");
  } catch {
    toast("复制失败，请手动选择文本复制", { tone: "error" });
  }
}

/** 跳到该生档案的「家校沟通」页签做个性化重写（预设只负责定位页签，不自动生成） */
function goStudentProfile(student: StudentRow) {
  if (!student) return;
  openParentSummaryPanel({ studentId: student.id, autoStart: false });
  closeParentSummaryBatch();
  router.push({ name: "student-detail", params: { id: student.id } });
}

async function onClose() {
  if (batch.running) {
    const ok = await confirmAction({
      title: "正在生成中",
      message: "全班总结还在逐个生成，关闭将停止剩余学生（已生成的仍可应用）。确定关闭？",
      confirmText: "停止并关闭",
    });
    if (!ok) return;
  }
  closeParentSummaryBatch();
}
</script>

<template>
  <AppDialog
    :open="batchState.open"
    title="家校沟通总结 · 全班批量"
    width="lg"
    data-test="parent-summary-batch-dialog"
    @close="onClose"
  >
    <p class="text-caption leading-relaxed text-muted">
      按指定时段内的评价，为本班学生逐个生成给家长的表现总结；生成后可在此复制或应用到档案，需要个性化重写请进入学生档案的「家校沟通」页签。
    </p>

    <!-- 控制行：班级 + 范围 + 全班生成（窄容器单行横向滚动） -->
    <div class="scrollbar-none mt-3 flex items-center gap-2 overflow-x-auto">
      <span
        class="shrink-0 whitespace-nowrap rounded-pill bg-primary-soft px-2.5 py-0.5 text-caption font-medium text-primary"
        data-test="summary-class-name"
      >
        {{ batchState.className || "未选择班级" }}
      </span>
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
        :disabled="batch.running"
        class="h-8 shrink-0 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus disabled:opacity-50"
      >
        <option v-for="sem in semesterOptions" :key="sem" :value="sem">{{ semesterLabel(sem) }}</option>
      </select>
      <div v-else class="flex shrink-0 items-center gap-1.5 text-caption text-weak">
        <input
          v-model="customStart"
          type="date"
          data-test="summary-start"
          :disabled="batch.running"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none disabled:opacity-50"
        />
        <span>~</span>
        <input
          v-model="customEnd"
          type="date"
          data-test="summary-end"
          :disabled="batch.running"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none disabled:opacity-50"
        />
      </div>
      <span class="min-w-2 flex-1" />
      <span
        v-if="batch.running"
        class="shrink-0 whitespace-nowrap text-fine text-primary"
        data-test="batch-progress"
      >
        生成中 {{ batch.done }}/{{ batch.total }}…
      </span>
      <AppButton
        data-test="generate-all-btn"
        :disabled="batch.running || !students.length"
        @click="generateWholeClass()"
      >
        一键全班生成
      </AppButton>
    </div>
    <p v-if="!aiReady" class="mt-2 text-fine text-weak" data-test="ai-unavailable">
      未配置 AI：可在「设置」配置模型后批量生成，或在此手动填写后应用。
    </p>

    <!-- 主体：左名单 / 右工作区 -->
    <div class="mt-4 flex gap-4" style="height: 430px">
      <!-- 学生名单 -->
      <div
        class="scroll-thin w-40 shrink-0 overflow-y-auto rounded-md border border-hairline bg-canvas p-1.5"
        data-test="summary-student-list"
      >
        <button
          v-for="s in students"
          :key="s.id"
          type="button"
          class="flex w-full items-center justify-between gap-1 rounded-sm px-2 py-1.5 text-left transition-colors"
          :class="s.id === selectedId ? 'bg-primary-soft/60' : 'hover:bg-pearl'"
          @click="selectedId = s.id"
        >
          <span class="min-w-0 truncate text-caption text-ink">{{ s.name }}</span>
          <span
            v-if="statusOf(s.id) === 'running' || statusOf(s.id) === 'queued'"
            class="shrink-0 whitespace-nowrap text-fine text-primary"
          >
            生成中
          </span>
          <span
            v-else-if="statusOf(s.id) === 'done' && jobs.get(s.id)?.applied"
            class="shrink-0 text-success"
            title="已应用到档案"
          >
            <AppIcon name="check" :size="13" />
          </span>
          <span v-else-if="statusOf(s.id) === 'done'" class="shrink-0 whitespace-nowrap text-fine text-weak">
            已生成
          </span>
          <span v-else-if="statusOf(s.id) === 'failed'" class="shrink-0 whitespace-nowrap text-fine text-danger">
            失败
          </span>
          <span v-else class="h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
        </button>
        <p v-if="!students.length && !loading" class="px-2 py-4 text-center text-fine text-faint">
          本班暂无学生
        </p>
      </div>

      <!-- 工作区：当前学生的总结预览与应用 -->
      <div class="flex min-w-0 flex-1 flex-col">
        <template v-if="selectedStudent && selectedJob">
          <div class="scrollbar-none flex shrink-0 items-center justify-between gap-2 overflow-x-auto">
            <p class="min-w-0 whitespace-nowrap text-fine text-weak" data-test="material-line">
              时段内评价：共 {{ selectedMaterial?.total ?? 0 }} 条（表扬
              {{ selectedMaterial?.praiseCount ?? 0 }} · 待改进
              {{ selectedMaterial?.improveCount ?? 0 }}）
            </p>
            <button
              type="button"
              class="shrink-0 whitespace-nowrap text-caption text-primary transition-opacity hover:opacity-80"
              data-test="go-profile-btn"
              @click="goStudentProfile(selectedStudent)"
            >
              到学生档案补充要求重新生成 →
            </button>
          </div>

          <p
            v-if="selectedJob.status === 'running'"
            class="mt-2 shrink-0 text-fine text-primary"
            data-test="summary-running"
          >
            正在生成…
          </p>
          <p v-if="selectedJob.status === 'failed'" class="mt-2 shrink-0 text-fine text-danger" data-test="summary-error">
            {{ selectedJob.error }}
            <button
              type="button"
              class="ml-1 text-primary hover:opacity-80"
              data-test="retry-btn"
              @click="retrySelected"
            >
              重试
            </button>
          </p>

          <!-- 总结正文：可手改后应用；未生成时可手动填写 -->
          <textarea
            v-model="selectedJob.current"
            rows="10"
            data-test="summary-current"
            :placeholder="selectedJob.status === 'done' ? '' : '暂无生成结果。可手动填写总结（无 AI 也可填写后应用），或点右上角「一键全班生成」。'"
            class="scroll-thin mt-2 min-h-0 flex-1 w-full resize-none rounded-md border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none focus:border-primary-focus"
          />

          <div class="mt-2 flex shrink-0 items-center justify-between gap-2">
            <p class="min-w-0 truncate text-fine text-faint">
              应用到档案 = 写入{{ applySemesterLabel }}学期评语，可在学生详情查看
            </p>
            <div class="flex shrink-0 items-center gap-2">
              <AppButton
                variant="pearl"
                data-test="copy-summary-btn"
                :disabled="!selectedJob.current.trim()"
                @click="copySummary"
              >
                复制
              </AppButton>
              <AppButton
                data-test="apply-summary-btn"
                :disabled="!selectedJob.current.trim()"
                @click="applyToProfile(selectedStudent)"
              >
                {{ selectedJob.applied ? "已应用到档案" : "应用到档案" }}
              </AppButton>
            </div>
          </div>
        </template>
        <div
          v-else
          class="flex flex-1 items-center justify-center text-caption text-faint"
          data-test="workspace-empty"
        >
          {{ loading ? "加载中…" : students.length ? "在左侧选择一个学生" : "本班暂无学生" }}
        </div>
      </div>
    </div>

    <template #footer>
      <div class="mt-4 flex items-center justify-end gap-2">
        <AppButton variant="pearl" data-test="close-dialog-btn" @click="onClose">关闭</AppButton>
      </div>
    </template>
  </AppDialog>
</template>
