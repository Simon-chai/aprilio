<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppInput from "../components/ui/AppInput.vue";
import StudentTable from "../components/StudentTable.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import { createStudent, getStats, listStudents } from "../lib/db";

import type { Stats, StudentInput, StudentRow } from "../types";

const router = useRouter();

const rows = ref<StudentRow[]>([]);
const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });
const keyword = ref("");
const loading = ref(true);
const error = ref("");
const dialogOpen = ref(false);

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

async function onSubmit(input: StudentInput) {
  const id = await createStudent(input);
  dialogOpen.value = false;
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
      <AppButton @click="dialogOpen = true">新建学生</AppButton>
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
        description="先建一条学生档案，之后就可以往里挂图片记录了。"
      >
        <AppButton @click="dialogOpen = true">新建学生</AppButton>
      </EmptyState>
    </div>
  </div>

  <StudentFormDialog
    :open="dialogOpen"
    title="新建学生"
    @close="dialogOpen = false"
    @submit="onSubmit"
  />
</template>
