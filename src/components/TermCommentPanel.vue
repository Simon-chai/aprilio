<script setup lang="ts">
/**
 * 学期评语面板：一个学生在一个学期一条期末评语。
 * 有 AI 时可生成草稿，未配置 / 失败则手动填写（永不阻塞）。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import {
  deleteTermComment,
  getTermComment,
  listTermComments,
  upsertTermComment,
} from "../lib/db";
import {
  buildBehaviorSummary,
  buildScoreSummary,
  generateTermComment,
} from "../lib/comment-ai";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { isTauri } from "../lib/db";
import { semesterOfDate } from "../lib/semester";
import { semesterLabel } from "../lib/timetable";
import type {
  StudentBehaviorRecord,
  StudentExamScore,
  StudentTermComment,
} from "../types";

const props = defineProps<{
  studentId: number;
  studentName: string;
  gradeClass: string;
  semester: string;
  /** 本学期表现记录（父组件已按学期过滤） */
  behaviors: StudentBehaviorRecord[];
  /** 该生全部成绩（父组件按学生加载，这里再按学期过滤） */
  examScores: StudentExamScore[];
}>();

const comment = ref("");
const history = ref<StudentTermComment[]>([]);
const loading = ref(false);
const saving = ref(false);
const generating = ref(false);
const message = ref("");
const messageKind = ref<"ok" | "error">("ok");

const aiReady = computed(() => isTauri() && isAiConfigured(loadAiConfig()));

/** 本学期成绩（按 exam_date 推导学期），按考试时间正序 */
const semesterExams = computed(() => {
  const map = new Map<number, { exam_name: string; exam_date: string; subjects: { subject: string; score: number | null; grade: string | null }[] }>();
  for (const s of props.examScores) {
    if (semesterOfDate(s.exam_date) !== props.semester) continue;
    const row = map.get(s.exam_id) ?? { exam_name: s.exam_name, exam_date: s.exam_date, subjects: [] };
    row.subjects.push({ subject: s.subject, score: s.score, grade: s.grade });
    map.set(s.exam_id, row);
  }
  return [...map.values()].sort((a, b) => (a.exam_date < b.exam_date ? -1 : 1));
});

const scoreSummary = computed(() => buildScoreSummary(semesterExams.value));
const behaviorSummary = computed(() => buildBehaviorSummary(props.behaviors));

const hasHistory = computed(() => history.value.some((c) => c.semester !== props.semester));

function setMessage(text: string, kind: "ok" | "error" = "ok") {
  message.value = text;
  messageKind.value = kind;
}

async function refresh() {
  loading.value = true;
  try {
    const [current, all] = await Promise.all([
      getTermComment(props.studentId, props.semester),
      listTermComments(props.studentId),
    ]);
    comment.value = current?.content ?? "";
    history.value = all;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.studentId, props.semester], refresh, { immediate: true });

async function onSave() {
  const text = comment.value.trim();
  if (!text) {
    setMessage("请先填写评语内容", "error");
    return;
  }
  saving.value = true;
  setMessage("");
  try {
    const current = await getTermComment(props.studentId, props.semester);
    // 内容与已有 AI 草稿相同则保留 ai 来源，否则记 manual
    const source = current?.source === "ai" && current.content === text ? "ai" : "manual";
    await upsertTermComment(props.studentId, props.semester, text, source);
    await refresh();
    setMessage("已保存");
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e), "error");
  } finally {
    saving.value = false;
  }
}

async function onGenerate() {
  if (!aiReady.value) return;
  generating.value = true;
  setMessage("");
  try {
    const draft = await generateTermComment({
      studentName: props.studentName,
      semester: props.semester,
      gradeClass: props.gradeClass,
      scoreSummary: scoreSummary.value,
      behaviorSummary: behaviorSummary.value,
    });
    if (!draft) {
      setMessage("AI 未能生成草稿，可手动填写", "error");
      return;
    }
    comment.value = draft;
    await upsertTermComment(props.studentId, props.semester, draft, "ai");
    await refresh();
    setMessage("已生成 AI 草稿，可继续修改后保存");
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e), "error");
  } finally {
    generating.value = false;
  }
}

async function onDelete() {
  await deleteTermComment(props.studentId, props.semester);
  comment.value = "";
  await refresh();
  setMessage("已清空本学期评语");
}
</script>

<template>
  <div class="space-y-4" data-test="term-comment-panel">
    <!-- 本学期评语编辑 -->
    <div class="rounded-lg border border-hairline bg-canvas p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p class="text-caption font-semibold text-ink">学期评语 · {{ semesterLabel(semester) }}</p>
          <p class="mt-0.5 text-fine text-weak">每生每学期一条期末评语，重复保存覆盖</p>
        </div>
        <div class="flex items-center gap-2">
          <AppButton
            v-if="aiReady"
            variant="secondary"
            data-test="generate-comment-btn"
            :disabled="generating"
            @click="onGenerate"
          >
            {{ generating ? "生成中…" : "AI 生成草稿" }}
          </AppButton>
          <span v-else class="text-fine text-weak" data-test="ai-unavailable">
            未配置 AI，可手动填写
          </span>
        </div>
      </div>

      <textarea
        v-model="comment"
        data-test="term-comment-input"
        rows="4"
        placeholder="结合本学期成绩与表现，写一段期末评语…"
        class="scroll-thin mt-3 w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none focus:border-primary-focus"
      />

      <!-- 无 AI 时的纯统计参考：成绩 / 表现摘要 -->
      <div v-if="scoreSummary || behaviorSummary" class="mt-2 space-y-1">
        <p v-if="scoreSummary" class="text-fine text-weak" data-test="comment-score-summary">
          成绩参考：{{ scoreSummary }}
        </p>
        <p v-if="behaviorSummary" class="text-fine text-weak" data-test="comment-behavior-summary">
          表现参考：{{ behaviorSummary }}
        </p>
      </div>

      <div class="mt-3 flex items-center justify-between gap-3">
        <p v-if="message" class="text-fine" :class="messageKind === 'error' ? 'text-danger' : 'text-success'">
          {{ message }}
        </p>
        <span v-else />
        <div class="flex items-center gap-2">
          <AppButton v-if="comment" variant="pearl" :disabled="saving" @click="onDelete">清空</AppButton>
          <AppButton :disabled="saving" data-test="save-comment-btn" @click="onSave">保存</AppButton>
        </div>
      </div>
    </div>

    <!-- 历史学期评语 -->
    <div v-if="hasHistory" class="rounded-lg border border-hairline bg-canvas p-4" data-test="term-comment-history">
      <p class="text-caption font-semibold text-ink">历史学期评语</p>
      <div class="mt-2 divide-y divide-divider">
        <div
          v-for="c in history.filter((x) => x.semester !== semester)"
          :key="c.semester"
          class="py-2.5 first:pt-0 last:pb-0"
        >
          <p class="text-fine font-medium text-primary">{{ semesterLabel(c.semester) }}</p>
          <p class="mt-1 whitespace-pre-wrap text-caption text-muted">{{ c.content }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
