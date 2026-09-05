<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppInput from "../components/ui/AppInput.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import StudentTable from "../components/StudentTable.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import ImportRosterDialog from "../components/ImportRosterDialog.vue";
import {
  addClassPhoto,
  createStudent,
  getClassSummary,
  isTauri,
  listPhotosByClass,
  listStudents,
} from "../lib/db";
import { getPhotosDir, importPhoto, photoUrl } from "../lib/photos";
import type { ClassSummary, Photo, StudentInput, StudentRow } from "../types";

const props = defineProps<{ name: string }>();
const router = useRouter();

const summary = ref<ClassSummary | null>(null);
const students = ref<StudentRow[]>([]);
const photos = ref<Photo[]>([]);
const photosDir = ref("");
const studentNames = ref<Map<number, string>>(new Map());

const keyword = ref("");
const activeTab = ref<"students" | "photos">("students");
const photoFilter = ref<"all" | "public" | "student">("all");

const importOpen = ref(false);
const createDialogOpen = ref(false);
const fileInputRef = ref<HTMLInputElement | null>(null);

const filterOptions: { label: string; value: "all" | "public" | "student" }[] = [
  { label: "全部", value: "all" },
  { label: "班级公共", value: "public" },
  { label: "学生个人", value: "student" },
];

async function refresh() {
  const [sum, studentList, photoList, allStudents, pDir] = await Promise.all([
    getClassSummary(props.name),
    listStudents(keyword.value, props.name),
    listPhotosByClass(props.name, photoFilter.value),
    listStudents(),
    getPhotosDir(),
  ]);
  summary.value = sum;
  students.value = studentList;
  photos.value = photoList;
  photosDir.value = pDir;
  studentNames.value = new Map(allStudents.map((s) => [s.id, s.name]));
}

let timer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    students.value = await listStudents(keyword.value, props.name);
  }, 200);
});

watch(photoFilter, async () => {
  photos.value = await listPhotosByClass(props.name, photoFilter.value);
});

watch(() => props.name, refresh);

onMounted(refresh);
onBeforeUnmount(() => clearTimeout(timer));

function openImportDialog() {
  importOpen.value = true;
}

function openCreateStudentDialog() {
  createDialogOpen.value = true;
}

async function handleCreateStudent(input: StudentInput) {
  await createStudent({ ...input, grade_class: input.grade_class || props.name });
  createDialogOpen.value = false;
  await refresh();
}

async function openAddPhotoDialog() {
  if (isTauri()) {
    const fileName = await importPhoto();
    if (fileName) {
      await addClassPhoto(
        props.name,
        fileName,
        `${props.name}活动照片`,
        new Date().toISOString().slice(0, 10)
      );
      await refresh();
    }
  } else {
    fileInputRef.value?.click();
  }
}

async function onFileSelected(e: Event) {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) {
    await addClassPhoto(
      props.name,
      file.name,
      file.name.replace(/\.[^/.]+$/, "") || `${props.name}照片`,
      new Date().toISOString().slice(0, 10)
    );
    await refresh();
    target.value = "";
  }
}

function goStudentDetail(row: StudentRow) {
  router.push({ name: "student-detail", params: { id: row.id } });
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-parchment">
    <!-- 隐藏的浏览器文件选择器 -->
    <input
      ref="fileInputRef"
      type="file"
      accept="image/*"
      class="hidden"
      @change="onFileSelected"
    />

    <!-- Header -->
    <header class="border-b border-divider bg-canvas px-8 py-4 shrink-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-4 min-w-0">
          <RouterLink
            to="/classes"
            class="flex items-center gap-1.5 text-caption font-medium text-primary hover:underline shrink-0 transition-transform active:scale-[0.98]"
          >
            ← 班级管理
          </RouterLink>
          <span class="text-hairline shrink-0">|</span>
          <div class="min-w-0">
            <div class="flex items-baseline gap-3 flex-wrap">
              <h1 class="text-display font-semibold text-ink truncate">{{ name }}</h1>
              <span class="text-caption text-weak">
                {{ summary?.studentCount ?? 0 }} 名学生 ({{ summary?.maleCount ?? 0 }} 男 · {{ summary?.femaleCount ?? 0 }} 女) · 照片 {{ summary?.photoCount ?? 0 }} 张
              </span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <AppButton variant="secondary" @click="openImportDialog">导入本班花名册</AppButton>
          <AppButton variant="secondary" @click="openAddPhotoDialog">添加班级照片</AppButton>
          <AppButton variant="primary" @click="openCreateStudentDialog">新建学生</AppButton>
        </div>
      </div>
    </header>

    <!-- 主体区域 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6 space-y-6">
      <!-- 概览指标卡片 -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <AppCard>
          <div class="text-caption text-weak">本班学生</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.studentCount ?? 0 }} 人
          </div>
          <div class="mt-1 text-fine text-muted">
            男 {{ summary?.maleCount ?? 0 }} · 女 {{ summary?.femaleCount ?? 0 }}
          </div>
        </AppCard>

        <AppCard>
          <div class="text-caption text-weak">班级照片</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ summary?.photoCount ?? 0 }} 张
          </div>
          <div class="mt-1 text-fine text-muted">
            公共 {{ summary?.classPhotoCount ?? 0 }} · 个人 {{ summary?.studentPhotoCount ?? 0 }}
          </div>
        </AppCard>

        <AppCard>
          <div class="text-caption text-weak">档案动态</div>
          <div class="mt-2 text-title font-semibold text-ink">
            {{ students.length }} 名有效学生
          </div>
          <div class="mt-1 text-fine text-muted">已归档</div>
        </AppCard>
      </div>

      <!-- Tab 切换 -->
      <div class="flex items-center gap-3 border-b border-hairline pb-3">
        <button
          type="button"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'students' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'students'"
        >
          学生条目 ({{ summary?.studentCount ?? students.length }})
        </button>
        <button
          type="button"
          class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
          :class="activeTab === 'photos' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
          @click="activeTab = 'photos'"
        >
          班级相册 ({{ summary?.photoCount ?? 0 }})
        </button>
      </div>

      <!-- Tab 1: 学生条目 -->
      <div v-if="activeTab === 'students'" class="space-y-4">
        <div class="flex items-center justify-between gap-4">
          <AppInput
            v-model="keyword"
            placeholder="搜索本班学生姓名或学号"
            width="320px"
          />
        </div>

        <StudentTable
          v-if="students.length"
          :rows="students"
          @open="goStudentDetail"
        />

        <EmptyState
          v-else
          title="暂无学生"
          description="点击上方「新建学生」或「导入本班花名册」为本班添加学生"
        />
      </div>

      <!-- Tab 2: 班级相册 -->
      <div v-else-if="activeTab === 'photos'" class="space-y-4">
        <!-- 筛选标签 -->
        <div class="flex items-center gap-2">
          <button
            v-for="f in filterOptions"
            :key="f.value"
            type="button"
            class="rounded-pill px-3 py-1 text-fine transition-colors"
            :class="photoFilter === f.value ? 'bg-ink text-canvas font-medium' : 'bg-canvas border border-hairline text-weak hover:text-ink hover:border-ink'"
            @click="photoFilter = f.value"
          >
            {{ f.label }}
          </button>
        </div>

        <!-- 照片卡片列表 -->
        <div
          v-if="photos.length"
          class="grid gap-4"
          style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))"
        >
          <figure
            v-for="photo in photos"
            :key="photo.id"
            class="overflow-hidden rounded-lg border border-hairline bg-canvas"
          >
            <div class="relative h-[160px] overflow-hidden bg-parchment">
              <img
                v-if="photoUrl(photosDir, photo.file_name)"
                class="h-full w-full object-cover"
                :src="photoUrl(photosDir, photo.file_name)"
                :alt="photo.caption ?? ''"
              />
              <div v-else class="flex h-full items-center justify-center text-fine text-weak">
                示例图片
              </div>
              <span
                class="absolute left-2 top-2 rounded-sm px-2 py-0.5 text-fine font-medium shadow-sm"
                :class="photo.student_id == null ? 'bg-primary text-canvas' : 'bg-canvas/90 text-ink'"
              >
                {{ photo.student_id == null ? "班级公共" : "个人归档" }}
              </span>
            </div>
            <figcaption class="space-y-1 p-3">
              <p class="text-caption font-semibold text-ink truncate">{{ photo.caption || "未命名" }}</p>
              <p class="text-fine text-weak">
                {{ (photo.taken_at || photo.created_at || "").slice(0, 10) }}
                <span v-if="photo.student_id != null && studentNames.get(photo.student_id)">
                  · {{ studentNames.get(photo.student_id) }}
                </span>
              </p>
            </figcaption>
          </figure>
        </div>

        <EmptyState
          v-else
          title="暂无相册照片"
          description="点击右上角「添加班级照片」上传班级活动照片"
        />
      </div>
    </div>

    <!-- 对话框 -->
    <ImportRosterDialog
      :open="importOpen"
      :preset-class="name"
      @close="importOpen = false"
      @imported="refresh"
    />

    <StudentFormDialog
      :open="createDialogOpen"
      :initial="{ grade_class: name }"
      @close="createDialogOpen = false"
      @submit="handleCreateStudent"
    />
  </div>
</template>
