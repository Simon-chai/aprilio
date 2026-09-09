<script setup lang="ts">
/**
 * 评价报告面板：区间选择 → 一键生成（AI 双输出/数据版兜底）→ 预览 → 存档/打印/回写短评语。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import {
  createEvalReport,
  deleteEvalReport,
  getStudent,
  listBehaviorRecords,
  listEvalReports,
  listHomeworkRecords,
  listStudentExamScores,
  upsertTermComment,
} from "../lib/db";
import { buildBehaviorSummary, buildScoreSummary } from "../lib/comment-ai";
import { buildHomeworkSummary } from "../lib/homework";
import { buildReportTitle, resolveReportRange } from "../lib/report";
import { generateEvalReport } from "../lib/report-ai";
import { semesterOfDate } from "../lib/semester";
import { renderMarkdown } from "../lib/markdown";
import { localDateStr } from "../lib/format";
import type { StudentEvalReport } from "../types";

const props = defineProps<{
  studentId: number;
  studentName: string;
  gradeClass: string;
  semester: string;
}>();

const mode = ref<"semester" | "custom">("semester");
const customStart = ref(localDateStr(new Date(new Date().setDate(1))));
const customEnd = ref(localDateStr());
const previewMd = ref("");
const shortComment = ref("");
const source = ref<"ai" | "manual">("manual");
const generating = ref(false);
const saving = ref(false);
const message = ref("");
const history = ref<StudentEvalReport[]>([]);
const viewing = ref<StudentEvalReport | null>(null);

const previewHtml = computed(() => renderMarkdown(viewing.value?.content_md ?? previewMd.value));

function setMessage(text: string) {
  message.value = text;
  if (text) setTimeout(() => (message.value = ""), 2600);
}

async function refreshHistory() {
  history.value = await listEvalReports(props.studentId);
}

watch(() => props.studentId, refreshHistory, { immediate: true });

async function onGenerate() {
  generating.value = true;
  setMessage("");
  viewing.value = null;
  try {
    const range = resolveReportRange(
      mode.value === "semester"
        ? { mode: "semester", semester: props.semester }
        : { mode: "custom", start: customStart.value, end: customEnd.value }
    );
    const [scores, behaviors, homeworks] = await Promise.all([
      listStudentExamScores(props.studentId),
      listBehaviorRecords(props.studentId, 500),
      listHomeworkRecords(props.studentId, { start: range.start, end: range.end, limit: 500 }),
    ]);
    const inRange = (d: string) => d >= range.start && d <= range.end;
    const rangeScores = scores.filter((s) => inRange(s.exam_date));
    const rangeBehaviors = behaviors.filter((b) => inRange(b.recorded_date));

    // 成绩按考试分组后取摘要（与学期评语面板同口径）
    const examMap = new Map<
      number,
      { exam_name: string; exam_date: string; subjects: { subject: string; score: number | null; grade: string | null }[] }
    >();
    for (const s of rangeScores) {
      const row = examMap.get(s.exam_id) ?? { exam_name: s.exam_name, exam_date: s.exam_date, subjects: [] };
      row.subjects.push({ subject: s.subject, score: s.score, grade: s.grade });
      examMap.set(s.exam_id, row);
    }
    const examRows = [...examMap.values()].sort((a, b) => (a.exam_date < b.exam_date ? -1 : 1));
    const scoreSummary = buildScoreSummary(examRows);
    const behaviorSummary = buildBehaviorSummary(
      rangeBehaviors.map((b) => ({ type: b.type, dimension_name_snap: b.dimension_name_snap, comment: b.comment }))
    );
    const homeworkSummary = buildHomeworkSummary(homeworks);
    const praiseCount = rangeBehaviors.filter((b) => b.type === "praise").length;
    const improveCount = rangeBehaviors.filter((b) => b.type === "improve").length;

    const student = await getStudent(props.studentId);
    const res = await generateEvalReport({
      studentName: props.studentName,
      gradeClass: student?.grade_class ?? props.gradeClass,
      range,
      summaries: {
        scoreSummary,
        behaviorSummary,
        homeworkSummary,
        examCount: examMap.size,
        praiseCount,
        improveCount,
      },
    });
    previewMd.value = res.markdown;
    shortComment.value = res.shortComment;
    source.value = res.source;
    if (res.source === "manual") setMessage("已生成数据版报告（未配置 AI）");
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e));
  } finally {
    generating.value = false;
  }
}

async function onSave() {
  if (!previewMd.value.trim()) {
    setMessage("请先生成报告");
    return;
  }
  saving.value = true;
  try {
    const range = resolveReportRange(
      mode.value === "semester"
        ? { mode: "semester", semester: props.semester }
        : { mode: "custom", start: customStart.value, end: customEnd.value }
    );
    await createEvalReport({
      student_id: props.studentId,
      range_start: range.start,
      range_end: range.end,
      semester: range.semester,
      title: buildReportTitle(range, props.studentName),
      content_md: previewMd.value,
      short_comment: shortComment.value,
      source: source.value,
    });
    setMessage("已存档");
    await refreshHistory();
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

async function onWriteBack() {
  if (!shortComment.value.trim()) {
    setMessage("短评语为空，无法回写");
    return;
  }
  // 回写目标：学期模式写该学期，自定义模式按结束日期推导学期
  const targetSemester =
    mode.value === "semester" ? props.semester : semesterOfDate(customEnd.value);
  await upsertTermComment(props.studentId, targetSemester, shortComment.value, source.value);
  setMessage(`短评语已回写入 ${targetSemester} 学期评语`);
}

async function onDelete(id: number) {
  if (!window.confirm("删除这条报告存档？")) return;
  await deleteEvalReport(id);
  if (viewing.value?.id === id) viewing.value = null;
  await refreshHistory();
  setMessage("已删除");
}

function onPrint() {
  window.print();
}
</script>

<template>
  <div class="space-y-4" data-test="eval-report-panel">
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex items-center gap-1 rounded-sm bg-pearl p-0.5">
        <button
          type="button"
          data-test="range-mode-semester"
          class="rounded-sm px-3 py-1 text-caption"
          :class="mode === 'semester' ? 'bg-ink text-canvas' : 'text-weak'"
          @click="mode = 'semester'"
        >
          按学期
        </button>
        <button
          type="button"
          data-test="range-mode-custom"
          class="rounded-sm px-3 py-1 text-caption"
          :class="mode === 'custom' ? 'bg-ink text-canvas' : 'text-weak'"
          @click="mode = 'custom'"
        >
          自定义
        </button>
      </div>
      <div v-if="mode === 'custom'" class="flex items-center gap-1.5 text-caption text-weak">
        <input
          v-model="customStart"
          type="date"
          data-test="report-start"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none"
        />
        <span>~</span>
        <input
          v-model="customEnd"
          type="date"
          data-test="report-end"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none"
        />
      </div>
      <span v-else class="text-caption text-weak">当前学期：{{ semester }}</span>
      <AppButton data-test="generate-report-btn" :disabled="generating" @click="onGenerate">
        {{ generating ? "生成中…" : "一键生成报告" }}
      </AppButton>
    </div>

    <p v-if="message" class="text-fine text-primary">{{ message }}</p>

    <div v-if="previewMd || viewing" class="rounded-lg border border-hairline bg-canvas p-4">
      <div class="flex items-center justify-between gap-2">
        <p class="text-caption font-semibold text-ink">
          {{ viewing?.title ?? "报告预览" }}
          <span class="ml-2 text-fine font-normal text-weak">{{ source === "ai" ? "AI 生成" : "数据版" }}</span>
        </p>
        <div class="flex items-center gap-2">
          <AppButton variant="secondary" @click="onPrint">打印</AppButton>
          <AppButton variant="secondary" :disabled="!shortComment" @click="onWriteBack">
            短评语回写
          </AppButton>
          <AppButton :disabled="saving" data-test="save-report-btn" @click="onSave">存档</AppButton>
        </div>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="prose-sm mt-3 max-w-none text-caption text-ink" v-html="previewHtml" />
      <p v-if="shortComment" class="mt-3 border-t border-divider pt-2 text-fine text-weak">
        短评语：{{ shortComment }}
      </p>
    </div>

    <div v-if="history.length" class="rounded-lg border border-hairline bg-canvas p-4">
      <p class="text-caption font-semibold text-ink">历史报告（{{ history.length }}）</p>
      <div class="mt-2 divide-y divide-divider">
        <div v-for="r in history" :key="r.id" class="flex items-center justify-between gap-3 py-2">
          <button type="button" class="min-w-0 flex-1 text-left" @click="viewing = r">
            <p class="truncate text-caption font-medium text-ink">{{ r.title }}</p>
            <p class="text-fine text-weak">{{ r.range_start }}~{{ r.range_end }} · {{ r.source === "ai" ? "AI" : "数据版" }}</p>
          </button>
          <button type="button" class="shrink-0 text-caption text-danger hover:opacity-80" @click="onDelete(r.id)">
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
