<script setup lang="ts">
/**
 * 作业台账面板：按学期过滤展示 + 新增/编辑/删除。
 * 数据口径与报告共用 lib/homework.ts。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import {
  addHomeworkRecord,
  deleteHomeworkRecord,
  listHomeworkRecords,
  updateHomeworkRecord,
} from "../lib/db";
import { buildHomeworkSummary } from "../lib/homework";
import { HOMEWORK_STATUS_LABEL } from "../lib/homework";
import { semesterOfDate } from "../lib/semester";
import { localDateStr } from "../lib/format";
import type { HomeworkStatus, StudentHomeworkRecord } from "../types";

const props = defineProps<{
  studentId: number;
  semester: string;
}>();

const rows = ref<StudentHomeworkRecord[]>([]);
const loading = ref(false);
const message = ref("");
const dialogOpen = ref(false);
const editing = ref<StudentHomeworkRecord | null>(null);

const form = ref({
  homework_date: localDateStr(),
  subject: "",
  status: "done" as HomeworkStatus,
  scoreText: "",
  comment: "",
});

const STATUS_OPTIONS: HomeworkStatus[] = ["excellent", "done", "late", "missing", "exempt"];

/** 本学期作业（按 homework_date 推导学期） */
const semesterRows = computed(() =>
  rows.value
    .filter((r) => semesterOfDate(r.homework_date) === props.semester)
    .sort((a, b) => (a.homework_date < b.homework_date ? 1 : -1) || b.id - a.id)
);

const summary = computed(() => buildHomeworkSummary(semesterRows.value));

function setMessage(text: string) {
  message.value = text;
  if (text) setTimeout(() => (message.value = ""), 2400);
}

async function refresh() {
  loading.value = true;
  try {
    rows.value = await listHomeworkRecords(props.studentId, { limit: 500 });
  } finally {
    loading.value = false;
  }
}

watch(() => [props.studentId, props.semester], refresh, { immediate: true });

function openAdd() {
  editing.value = null;
  form.value = { homework_date: localDateStr(), subject: "", status: "done", scoreText: "", comment: "" };
  dialogOpen.value = true;
}

function openEdit(record: StudentHomeworkRecord) {
  editing.value = record;
  form.value = {
    homework_date: record.homework_date,
    subject: record.subject,
    status: record.status,
    scoreText: record.score === null || record.score === undefined ? "" : String(record.score),
    comment: record.comment ?? "",
  };
  dialogOpen.value = true;
}

async function onSave() {
  const scoreText = form.value.scoreText.trim();
  const score = scoreText === "" ? null : Number(scoreText);
  try {
    if (editing.value) {
      await updateHomeworkRecord(editing.value.id, {
        homework_date: form.value.homework_date,
        subject: form.value.subject,
        status: form.value.status,
        score,
        comment: form.value.comment,
      });
      setMessage("已更新");
    } else {
      await addHomeworkRecord({
        student_id: props.studentId,
        homework_date: form.value.homework_date,
        subject: form.value.subject,
        status: form.value.status,
        score,
        comment: form.value.comment,
      });
      setMessage("已记录");
    }
    dialogOpen.value = false;
    await refresh();
  } catch (e) {
    setMessage(e instanceof Error ? e.message : String(e));
  }
}

async function onDelete(record: StudentHomeworkRecord) {
  if (!window.confirm(`删除 ${record.homework_date} ${record.subject} 这条作业记录？`)) return;
  await deleteHomeworkRecord(record.id);
  setMessage("已删除");
  await refresh();
}
</script>

<template>
  <div class="space-y-4" data-test="homework-panel">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-caption text-weak" data-test="homework-summary">
        {{ summary || "本学期暂无作业记录" }}
      </p>
      <AppButton data-test="add-homework-btn" @click="openAdd">+ 记作业</AppButton>
    </div>

    <p v-if="message" class="text-fine text-primary">{{ message }}</p>
    <p v-if="loading" class="py-6 text-center text-caption text-weak">加载中…</p>
    <p v-else-if="!semesterRows.length" class="py-6 text-center text-caption text-weak">
      本学期还没有作业记录，点「记作业」录入第一条。
    </p>
    <div v-else class="divide-y divide-divider rounded-lg border border-hairline bg-canvas">
      <div
        v-for="r in semesterRows"
        :key="r.id"
        class="flex items-center justify-between gap-3 px-4 py-2.5"
      >
        <div class="min-w-0">
          <p class="text-caption font-medium text-ink">
            {{ r.homework_date }} · {{ r.subject }} · {{ HOMEWORK_STATUS_LABEL[r.status] }}
            <span v-if="r.score !== null" class="ml-1 text-weak">{{ r.score }}分</span>
          </p>
          <p v-if="r.comment" class="mt-0.5 truncate text-fine text-muted">{{ r.comment }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button type="button" class="text-caption text-primary hover:opacity-80" @click="openEdit(r)">
            编辑
          </button>
          <button type="button" class="text-caption text-danger hover:opacity-80" @click="onDelete(r)">
            删除
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="dialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      data-test="homework-dialog"
    >
      <div class="w-full max-w-md rounded-lg bg-canvas p-5">
        <h3 class="text-body font-semibold text-ink">{{ editing ? "编辑作业" : "记作业" }}</h3>
        <div class="mt-4 space-y-3">
          <label class="block text-caption text-weak">
            日期
            <input
              v-model="form.homework_date"
              type="date"
              data-test="homework-date"
              class="mt-1 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
          <label class="block text-caption text-weak">
            科目
            <input
              v-model="form.subject"
              type="text"
              placeholder="如 语文 / 数学"
              data-test="homework-subject"
              class="mt-1 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
          <label class="block text-caption text-weak">
            状态
            <select
              v-model="form.status"
              data-test="homework-status"
              class="mt-1 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            >
              <option v-for="s in STATUS_OPTIONS" :key="s" :value="s">
                {{ HOMEWORK_STATUS_LABEL[s] }}
              </option>
            </select>
          </label>
          <label class="block text-caption text-weak">
            分数（可空，0~100）
            <input
              v-model="form.scoreText"
              type="number"
              min="0"
              max="100"
              placeholder="可空"
              data-test="homework-score"
              class="mt-1 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
          <label class="block text-caption text-weak">
            备注（可空，≤200字）
            <input
              v-model="form.comment"
              type="text"
              placeholder="如 书写工整、有两道错题"
              data-test="homework-comment"
              class="mt-1 h-9 w-full rounded-md border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <AppButton variant="secondary" @click="dialogOpen = false">取消</AppButton>
          <AppButton data-test="save-homework-btn" @click="onSave">保存</AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
