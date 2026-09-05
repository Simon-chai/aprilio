<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppInput from "../components/ui/AppInput.vue";
import StudentTable from "../components/StudentTable.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import ImportRosterDialog from "../components/ImportRosterDialog.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import { createStudent, getStats, listStudents } from "../lib/db";
import { onPageAction } from "../agent/page-action-bus";
import type { ImportRosterMode } from "../agent/page-actions/students-import";

import type { Stats, StudentInput, StudentRow } from "../types";

const router = useRouter();
const route = useRoute();

const rows = ref<StudentRow[]>([]);
const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });
const keyword = ref("");
const loading = ref(true);
const error = ref("");
const dialogOpen = ref(false);
const dialogInitial = ref<Partial<StudentInput> | null>(null);
const importOpen = ref(false);
const importMode = ref<ImportRosterMode>("smart");

function openCreateDialog(preset?: Partial<StudentInput> | null) {
  dialogInitial.value = preset ?? null;
  dialogOpen.value = true;
}

function closeDialog() {
  dialogOpen.value = false;
  dialogInitial.value = null;
}

function openImportDialog(mode: ImportRosterMode = "smart") {
  importMode.value = mode;
  importOpen.value = true;
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await listStudents(keyword.value);
    stats.value = await getStats();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    error.value = msg;
  } finally {
    loading.value = false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
});

onMounted(refresh);
onBeforeUnmount(() => clearTimeout(timer));

// Agent 的 ui_action 广播：新建学生动作 → 打开对话框（支持参数预填）
const offCreateAction = onPageAction<Partial<StudentInput>>("students/create-student", (preset) => {
  openCreateDialog(preset);
});
onBeforeUnmount(offCreateAction);

// Agent 的 ui_action 广播：导入花名册动作 → 打开导入对话框（可指定模式）
const offImportAction = onPageAction<ImportRosterMode>("students/import-roster", (mode) => {
  openImportDialog(mode ?? "smart");
});
onBeforeUnmount(offImportAction);

// 班级管理页的「导入花名册」入口经 /students?import=1 跳转进来
onMounted(() => {
  if (route.query.import) openImportDialog("smart");
});

async function onSubmit(input: StudentInput) {
  const id = await createStudent(input);
  closeDialog();
  await refresh();
  if (id) router.push({ name: "student-detail", params: { id } });
}

const cards = () => [
  { label: "在读学生", value: stats.value.students, delta: `本月新增 ${stats.value.month_new}` },
  { label: "图片记录", value: stats.value.photos, delta: "本地存储" },
  {
    label: "筛选结果",
    value: rows.value.length,
    delta: keyword.value ? `关键词「${keyword.value}」` : "全部学生",
  },
];
</script>

<template>
  <!-- 顶栏 -->
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">学生档案</h1>
    <div class="flex items-center gap-3">
      <AppInput v-model="keyword" placeholder="搜索姓名或学号" />
      <AppButton variant="secondary" @click="openImportDialog('smart')">导入花名册</AppButton>
      <AppButton @click="openCreateDialog()">新建学生</AppButton>
    </div>
  </header>

  <!-- 内容 -->
  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="space-y-6">
      <div class="flex gap-5">
        <div
          v-for="card in cards()"
          :key="card.label"
          class="flex-1 rounded-lg border border-hairline bg-canvas p-5"
        >
          <p class="text-fine text-weak">{{ card.label }}</p>
          <p class="mt-1.5 text-stat font-semibold text-ink">{{ card.value }}</p>
          <p class="mt-1 text-fine text-weak">{{ card.delta }}</p>
        </div>
      </div>

      <p v-if="error" class="rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
        读取失败：{{ error }}
      </p>

      <StudentTable v-if="rows.length" :rows="rows" @open="(r) => router.push(`/students/${r.id}`)" />

      <EmptyState
        v-else-if="!loading"
        title="还没有学生记录"
        description="导入一份花名册批量建档，或先手动建一条学生档案。"
      >
        <div class="flex justify-center gap-3">
          <AppButton variant="secondary" @click="openImportDialog('smart')">导入花名册</AppButton>
          <AppButton @click="openCreateDialog()">新建学生</AppButton>
        </div>
      </EmptyState>
    </div>
  </div>

  <StudentFormDialog
    :open="dialogOpen"
    :initial="dialogInitial"
    title="新建学生"
    @close="closeDialog"
    @submit="onSubmit"
  />

  <ImportRosterDialog
    :open="importOpen"
    :initial-mode="importMode"
    @close="importOpen = false"
    @imported="refresh"
  />
</template>
