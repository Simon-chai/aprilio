<script setup lang="ts">
/**
 * 学生成绩面板：学生档案详情页「成绩」Tab 的主体。
 *
 * 按考试时间倒序展示该学生历次考试：考试名 + 时间 + 各科成绩 + 总分，
 * 数据来自班级成绩导入后自动关联的 exam_scores（无需在档案里手动维护）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { listStudentExamScores } from "../lib/db";
import type { StudentExamScore } from "../types";

const props = defineProps<{ studentId: number }>();

const scores = ref<StudentExamScore[]>([]);
const loading = ref(true);

async function refresh() {
  loading.value = true;
  try {
    scores.value = await listStudentExamScores(props.studentId);
  } finally {
    loading.value = false;
  }
}

watch(() => props.studentId, refresh);
onMounted(refresh);

/** 按考试分组（listStudentExamScores 已按考试时间倒序，保持组顺序） */
const examGroups = computed(() => {
  const groups: { examId: number; name: string; date: string; items: StudentExamScore[] }[] = [];
  for (const s of scores.value) {
    let g = groups.find((x) => x.examId === s.exam_id);
    if (!g) {
      g = { examId: s.exam_id, name: s.exam_name, date: s.exam_date, items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
});

function itemText(item: StudentExamScore): string {
  if (item.score !== null) return `${item.subject} ${item.score}`;
  return `${item.subject} ${item.grade ?? "—"}`;
}

function totalOf(items: StudentExamScore[]): string {
  const numeric = items.filter((i) => i.score !== null);
  if (numeric.length) {
    return String(numeric.reduce((sum, i) => sum + (i.score ?? 0), 0));
  }
  return items.map((i) => i.grade ?? "—").join("、") || "—";
}
</script>

<template>
  <div class="space-y-3" data-test="student-score-panel">
    <p v-if="loading" class="py-6 text-center text-caption text-weak">加载中…</p>

    <p v-else-if="!examGroups.length" class="py-6 text-center text-caption text-weak">
      还没有成绩记录。到「班级管理 → 考试成绩」导入一份成绩单，成绩会自动关联到这里。
    </p>

    <div
      v-for="group in examGroups"
      :key="group.examId"
      class="rounded-md border border-hairline bg-parchment px-4 py-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-caption font-semibold text-ink">
          {{ group.name }}
          <span class="ml-2 font-normal text-weak">{{ group.date.slice(0, 10) }}</span>
        </p>
        <span
          class="rounded-pill bg-canvas px-2.5 py-0.5 text-caption font-medium text-primary"
          data-test="score-total"
        >
          {{ totalOf(group.items) }}
        </span>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <span
          v-for="item in group.items"
          :key="item.id"
          class="rounded-sm bg-canvas px-2 py-0.5 text-fine text-muted"
        >
          {{ itemText(item) }}
        </span>
      </div>
    </div>
  </div>
</template>
