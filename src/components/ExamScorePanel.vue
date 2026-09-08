<script setup lang="ts">
/**
 * 班级考试成绩面板：班级详情页「考试成绩」Tab 的主体。
 *
 * 两种视角：
 * - 按考试：批次列表（考试名 + 时间 + 科目/学生数）→ 选中考试的明细表
 *   （学生 × 科目 + 总分），支持编辑批次信息、删除批次；
 * - 按学生总览：学生 × 各次考试总分的矩阵，一人一行看每次成绩。
 *
 * 「导入成绩」对话框在本组件内打开，导入完成自动刷新。
 */
import { computed, onMounted, ref, watch } from "vue";
import { confirm } from "@tauri-apps/plugin-dialog";
import AppButton from "./ui/AppButton.vue";
import AppIconButton from "./ui/AppIconButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import ImportScoreDialog from "./ImportScoreDialog.vue";
import {
  deleteExam,
  getClassScoreOverview,
  getExamScores,
  isTauri,
  listExamsByClass,
  updateExam,
} from "../lib/db";
import type { ClassScoreOverviewRow, Exam, ExamScoreRow, ExamWithStats } from "../types";

const props = defineProps<{ className: string }>();

const exams = ref<ExamWithStats[]>([]);
const selectedExamId = ref<number | null>(null);
const scores = ref<ExamScoreRow[]>([]);
const overview = ref<{ exams: Exam[]; rows: ClassScoreOverviewRow[] }>({ exams: [], rows: [] });
const view = ref<"exams" | "overview">("exams");
const importOpen = ref(false);
const editOpen = ref(false);
const editName = ref("");
const editDate = ref("");
const loading = ref(false);

async function refresh() {
  loading.value = true;
  try {
    const [list, ov] = await Promise.all([
      listExamsByClass(props.className),
      getClassScoreOverview(props.className),
    ]);
    exams.value = list;
    overview.value = ov;
    // 选中批次被删/不存在时回落到第一场
    if (selectedExamId.value === null || !list.some((e) => e.id === selectedExamId.value)) {
      selectedExamId.value = list[0]?.id ?? null;
    }
    scores.value = selectedExamId.value ? await getExamScores(selectedExamId.value) : [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.className,
  () => {
    selectedExamId.value = null;
    void refresh();
  }
);

watch(selectedExamId, async (id) => {
  scores.value = id ? await getExamScores(id) : [];
});

onMounted(refresh);

/* ---------------- 考试明细：学生 × 科目矩阵 ---------------- */

/** 科目列（按成绩首次出现顺序） */
const subjects = computed(() => {
  const seen: string[] = [];
  for (const s of scores.value) {
    if (!seen.includes(s.subject)) seen.push(s.subject);
  }
  return seen;
});

/** 明细行：每名学生一行，subject → 成绩单元格 */
const detailRows = computed(() => {
  const byStudent = new Map<
    number,
    { id: number; name: string; student_no: string | null; cells: Map<string, ExamScoreRow> }
  >();
  for (const s of scores.value) {
    let row = byStudent.get(s.student_id);
    if (!row) {
      row = { id: s.student_id, name: s.student_name, student_no: s.student_no, cells: new Map() };
      byStudent.set(s.student_id, row);
    }
    row.cells.set(s.subject, s);
  }
  return [...byStudent.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

function cellText(cell: ExamScoreRow | undefined): string {
  if (!cell) return "—";
  if (cell.score !== null) return String(cell.score);
  return cell.grade ?? "—";
}

function totalOf(row: { cells: Map<string, ExamScoreRow> }): { score: number | null; grade: string | null } {
  let total = 0;
  let hasNumeric = false;
  const grades: string[] = [];
  for (const cell of row.cells.values()) {
    if (cell.score !== null) {
      total += cell.score;
      hasNumeric = true;
    } else if (cell.grade) {
      grades.push(cell.grade);
    }
  }
  return hasNumeric ? { score: total, grade: null } : { score: null, grade: grades.join("、") || null };
}

const selectedExam = computed(() => exams.value.find((e) => e.id === selectedExamId.value) ?? null);

/* ---------------- 批次编辑 / 删除 ---------------- */

function openEditExam() {
  if (!selectedExam.value) return;
  editName.value = selectedExam.value.name;
  editDate.value = selectedExam.value.exam_date;
  editOpen.value = true;
}

async function saveExamEdit() {
  if (!selectedExam.value) return;
  const name = editName.value.trim();
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(editDate.value)) return;
  await updateExam(selectedExam.value.id, { name, exam_date: editDate.value });
  editOpen.value = false;
  await refresh();
}

async function onDeleteExam() {
  const exam = selectedExam.value;
  if (!exam) return;
  const message = `删除考试「${exam.name}」（${exam.exam_date}）？该批次的所有成绩将一并删除，且不可恢复。`;
  const ok = isTauri()
    ? await confirm(message, { title: "删除考试", kind: "warning" })
    : window.confirm(message);
  if (!ok) return;
  await deleteExam(exam.id);
  selectedExamId.value = null;
  await refresh();
}

function fmtDate(d: string): string {
  return d?.slice(0, 10) ?? "";
}
</script>

<template>
  <div class="space-y-4" data-test="exam-score-panel">
    <!-- 工具行：视角切换 → 「导入成绩」紧挨其右 → 说明文字 -->
    <div class="flex flex-wrap items-center gap-3" data-test="score-toolbar">
      <div class="flex flex-wrap items-center gap-2" data-test="score-toolbar-actions">
        <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
          <button
            type="button"
            data-test="view-exams-btn"
            class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
            :class="view === 'exams' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
            @click="view = 'exams'"
          >
            按考试
          </button>
          <button
            type="button"
            data-test="view-overview-btn"
            class="rounded-[6px] px-3 py-1.5 text-caption transition-colors"
            :class="view === 'overview' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
            @click="view = 'overview'"
          >
            按学生总览
          </button>
        </div>

        <AppIconButton label="导入成绩" data-test="import-score-btn" @click="importOpen = true">
          <!-- 语义图标：文件上有对勾勾线，表示成绩单批量导入 -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M9 15l2 2 4-4" />
          </svg>
        </AppIconButton>
      </div>

      <span class="text-fine text-weak">
        {{ view === "exams" ? "每次考试一份成绩单批次" : "每个学生每次考试的总分" }}
      </span>
    </div>

    <p v-if="loading" class="text-caption text-weak">加载中…</p>

    <!-- 空状态 -->
    <EmptyState
      v-if="!loading && !exams.length"
      title="暂无考试成绩"
      description="点击「按学生总览」右侧的「导入成绩」图标，把一份成绩单导入为一次考试（可指定考试名与考试时间）"
    />

    <!-- 视角 1：按考试 -->
    <template v-else-if="view === 'exams'">
      <!-- 批次胶囊 -->
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="exam in exams"
          :key="exam.id"
          type="button"
          :data-test="`exam-chip-${exam.id}`"
          class="rounded-pill px-3 py-1.5 text-caption transition-colors"
          :class="
            exam.id === selectedExamId
              ? 'bg-ink text-canvas font-medium'
              : 'bg-canvas border border-hairline text-weak hover:text-ink hover:border-ink'
          "
          @click="selectedExamId = exam.id"
        >
          {{ exam.name }}
          <span class="opacity-70">· {{ fmtDate(exam.exam_date) }}</span>
        </button>
      </div>

      <!-- 选中批次明细 -->
      <div v-if="selectedExam" class="rounded-lg border border-hairline bg-canvas">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
          <div class="min-w-0">
            <p class="text-body font-semibold text-ink">
              {{ selectedExam.name }}
              <span class="ml-2 text-caption font-normal text-weak">{{ fmtDate(selectedExam.exam_date) }}</span>
            </p>
            <p class="mt-0.5 text-fine text-weak">
              科目 {{ selectedExam.subject_count }} 个 · 成绩 {{ selectedExam.score_count }} 条 ·
              学生 {{ selectedExam.student_count }} 人
            </p>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              data-test="edit-exam-btn"
              class="rounded-md px-2 py-1 text-fine text-weak hover:bg-pearl hover:text-ink transition-colors"
              @click="openEditExam"
            >
              编辑考试信息
            </button>
            <button
              type="button"
              data-test="delete-exam-btn"
              class="rounded-md px-2 py-1 text-fine text-weak hover:bg-[#fdeef0] hover:text-danger transition-colors"
              @click="onDeleteExam"
            >
              删除考试
            </button>
          </div>
        </div>

        <div class="scroll-thin overflow-x-auto">
          <table class="w-full text-caption" data-test="exam-detail-table">
            <thead>
              <tr class="bg-parchment text-left">
                <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">学生</th>
                <th
                  v-for="subj in subjects"
                  :key="subj"
                  class="whitespace-nowrap px-4 py-2 font-normal text-weak"
                >
                  {{ subj }}
                </th>
                <th class="whitespace-nowrap px-4 py-2 font-normal text-ink">总分</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in detailRows" :key="row.id" class="border-t border-hairline">
                <td class="whitespace-nowrap px-4 py-2 text-ink">
                  {{ row.name }}
                  <span v-if="row.student_no" class="ml-1 text-fine text-weak">{{ row.student_no }}</span>
                </td>
                <td
                  v-for="subj in subjects"
                  :key="subj"
                  class="whitespace-nowrap px-4 py-2 text-muted"
                >
                  {{ cellText(row.cells.get(subj)) }}
                </td>
                <td class="whitespace-nowrap px-4 py-2 font-medium text-ink">
                  <template v-if="totalOf(row).score !== null">{{ totalOf(row).score }}</template>
                  <template v-else>{{ totalOf(row).grade ?? "—" }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 视角 2：按学生总览（学生 × 各次考试总分矩阵） -->
    <template v-else>
      <EmptyState
        v-if="!overview.rows.length"
        title="暂无成绩数据"
        description="导入成绩后，这里会展示每个学生每次考试的总分"
      />
      <div v-else class="scroll-thin overflow-x-auto rounded-lg border border-hairline bg-canvas">
        <table class="w-full text-caption" data-test="score-overview-table">
          <thead>
            <tr class="bg-parchment text-left">
              <th class="whitespace-nowrap px-4 py-2 font-normal text-weak">学生</th>
              <th
                v-for="exam in overview.exams"
                :key="exam.id"
                class="whitespace-nowrap px-4 py-2 font-normal text-weak"
              >
                {{ exam.name }}
                <span class="ml-1 opacity-70">{{ fmtDate(exam.exam_date).slice(5) }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in overview.rows" :key="row.student_id" class="border-t border-hairline">
              <td class="whitespace-nowrap px-4 py-2 text-ink">
                {{ row.student_name }}
                <span v-if="row.student_no" class="ml-1 text-fine text-weak">{{ row.student_no }}</span>
              </td>
              <td
                v-for="exam in overview.exams"
                :key="exam.id"
                class="whitespace-nowrap px-4 py-2"
                :class="row.cells[exam.id] ? 'text-muted' : 'text-faint'"
              >
                <template v-if="row.cells[exam.id]?.score !== null && row.cells[exam.id]?.score !== undefined">
                  {{ row.cells[exam.id].score }}
                </template>
                <template v-else-if="row.cells[exam.id]?.grade">{{ row.cells[exam.id].grade }}</template>
                <template v-else>—</template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 编辑考试信息 -->
    <div
      v-if="editOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
      @click.self="editOpen = false"
    >
      <div class="w-[380px] rounded-lg bg-canvas p-6 shadow-window">
        <h3 class="text-tagline font-semibold text-ink">编辑考试信息</h3>
        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="text-caption text-weak">考试名</span>
            <input
              v-model="editName"
              data-test="edit-exam-name"
              class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
          <label class="block">
            <span class="text-caption text-weak">考试时间</span>
            <input
              v-model="editDate"
              data-test="edit-exam-date"
              placeholder="YYYY-MM-DD"
              class="mt-1 h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none focus:border-primary-focus"
            />
          </label>
        </div>
        <div class="mt-5 flex items-center justify-end gap-3">
          <AppButton variant="pearl" @click="editOpen = false">取消</AppButton>
          <AppButton data-test="save-exam-btn" @click="saveExamEdit">保存</AppButton>
        </div>
      </div>
    </div>

    <!-- 导入成绩对话框 -->
    <ImportScoreDialog
      :open="importOpen"
      :preset-class="props.className"
      @close="importOpen = false"
      @imported="refresh"
    />
  </div>
</template>
