<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import ClassFormDialog from "../components/ClassFormDialog.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import { getPhotosDir, photoUrl } from "../lib/photos";
import { createClass, createStudent, deleteClass, listClasses, listPhotos, listStudents, renameClass } from "../lib/db";
import type { ClassSummary, Photo, StudentInput, StudentRow } from "../types";

const router = useRouter();

interface RecordCard {
  id: number;
  title: string;
  time: string;
  url: string;
}

const groups = ref<ClassSummary[]>([]);
const rows = ref<StudentRow[]>([]);
const photos = ref<Photo[]>([]);
const names = ref<Map<number, string>>(new Map());
const photosDir = ref("");

const showCreateDialog = ref(false);
const showStudentDialog = ref(false);
const renameDialogOpen = ref(false);
const renamingClassName = ref<string | null>(null);
const deleteDialogOpen = ref(false);
const deletingClassName = ref<string | null>(null);

const totalStudents = computed(() =>
  groups.value.reduce((acc, g) => acc + g.studentCount, 0)
);

/** 花名册批量导入入口：跳到学生档案页并自动打开导入对话框 */
function goImportRoster() {
  router.push({ path: "/students", query: { import: "1" } });
}

/** 手动添加单个学生：创建后留在本页刷新统计 */
async function handleCreateStudent(input: StudentInput) {
  await createStudent(input);
  showStudentDialog.value = false;
  await refresh();
}

/** 最近 4 条图片记录；浏览器演示模式下文件不存在，展示占位底色 */
const recent = computed<RecordCard[]>(() =>
  photos.value.slice(0, 4).map((p) => ({
    id: p.id,
    title: p.caption || (p.student_id != null ? names.value.get(p.student_id) : p.grade_class) || "图片记录",
    time: (p.taken_at || p.created_at || "").slice(0, 10),
    url: photoUrl(photosDir.value, p.file_name),
  }))
);

async function refresh() {
  const [classList, studentRows, photoRows] = await Promise.all([
    listClasses(),
    listStudents(),
    listPhotos(),
  ]);
  groups.value = classList;
  rows.value = studentRows;
  photos.value = photoRows;
  names.value = new Map(studentRows.map((s) => [s.id, s.name]));
  photosDir.value = await getPhotosDir();
}

onMounted(refresh);

async function handleCreateClass(name: string) {
  await createClass(name);
  showCreateDialog.value = false;
  await refresh();
}

function openRenameDialog(name: string) {
  renamingClassName.value = name;
  renameDialogOpen.value = true;
}

async function handleRenameClass(newName: string) {
  if (renamingClassName.value) {
    await renameClass(renamingClassName.value, newName);
  }
  renameDialogOpen.value = false;
  renamingClassName.value = null;
  await refresh();
}

function openDeleteDialog(name: string) {
  deletingClassName.value = name;
  deleteDialogOpen.value = true;
}

function closeDeleteDialog() {
  deleteDialogOpen.value = false;
  deletingClassName.value = null;
}

/** 删除班级进回收站；recreate 为 true 时一键删除并重建同名空班级 */
async function handleDeleteClass(recreate: boolean) {
  const name = deletingClassName.value;
  if (!name) return;
  await deleteClass(name);
  if (recreate) {
    await createClass(name);
  }
  closeDeleteDialog();
  await refresh();
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-parchment">
    <!-- 导航栏 -->
    <header class="flex h-16 shrink-0 items-center justify-between border-b border-divider bg-canvas pl-7 pr-10">
      <RouterLink
        to="/home"
        class="flex items-center gap-1.5 transition-transform active:scale-[0.95]"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M15 5l-7 7 7 7"
            stroke="#0066cc"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="text-body text-primary">首页</span>
      </RouterLink>

      <div class="flex items-center gap-3">
        <AppButton variant="secondary" @click="goImportRoster">导入花名册</AppButton>
        <AppButton variant="secondary" data-test="add-student-btn" @click="showStudentDialog = true">
          添加学生
        </AppButton>
        <AppButton variant="primary" @click="showCreateDialog = true">
          新建班级
        </AppButton>

        <ClassFormDialog
          :open="showCreateDialog"
          mode="create"
          :existing-classes="groups"
          @close="showCreateDialog = false"
          @submit="handleCreateClass"
        />

        <StudentFormDialog
          :open="showStudentDialog"
          title="添加学生"
          @close="showStudentDialog = false"
          @submit="handleCreateStudent"
        />
      </div>
    </header>

    <!-- 内容 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-20 py-10">
      <h1 class="text-display font-semibold text-ink">班级管理</h1>
      <p class="mt-2 text-caption text-weak">
        {{ groups.length }} 个班级 · {{ totalStudents }} 名学生
      </p>

      <!-- 班级卡片 -->
      <div v-if="groups.length" class="mt-7 flex flex-wrap gap-6">
        <div
          v-for="g in groups"
          :key="g.name"
          class="group relative w-[410px]"
        >
          <RouterLink
            :to="{ name: 'class-detail', params: { name: g.name } }"
            class="flex w-full flex-col gap-5 rounded-lg border border-hairline bg-canvas p-7 transition-all hover:bg-pearl active:scale-[0.98]"
          >
            <div class="flex items-center gap-4">
              <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[11px] bg-parchment">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="4" y="7" width="16" height="13" rx="2" stroke="#0066cc" stroke-width="1.8" />
                  <path
                    d="M12 7V4.5M12 4.5l7 2.5-7 2.5L5 7l7-2.5z"
                    stroke="#0066cc"
                    stroke-width="1.8"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="truncate text-tagline font-semibold -tracking-[0.3px] text-ink">
                    {{ g.name }}
                  </span>
                  <button
                    type="button"
                    class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-weak opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-parchment hover:text-ink"
                    title="修改班级名称"
                    @click.stop.prevent="openRenameDialog(g.name)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    data-test="delete-class-btn"
                    class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-weak opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-[#fdeef0] hover:text-danger"
                    title="删除班级"
                    @click.stop.prevent="openDeleteDialog(g.name)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
                <p class="mt-0.5 text-caption text-weak">
                  {{ g.studentCount }} 名学生 ({{ g.maleCount }} 男 · {{ g.femaleCount }} 女)
                </p>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M9 5l7 7-7 7"
                  stroke="#7a7a7a"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </div>

            <div class="h-px w-full bg-hairline" />

            <div class="flex items-center justify-between">
              <span class="text-caption text-weak">
                照片 {{ g.photoCount }} 张 (公共 {{ g.classPhotoCount }} · 个人 {{ g.studentPhotoCount }})
              </span>
              <span class="text-caption text-primary">进入班级 →</span>
            </div>
          </RouterLink>
        </div>
      </div>

      <p v-else class="mt-10 text-caption text-weak">
        还没有学生记录 —— 点击右上角「导入花名册」批量建档，或到「学生档案」新建第一条学生。
      </p>

      <!-- 最近记录 -->
      <template v-if="recent.length">
        <div class="mt-12 flex items-center justify-between">
          <h2 class="text-tagline font-semibold -tracking-[0.3px] text-ink">最近记录</h2>
          <RouterLink to="/photos" class="text-caption text-primary">查看全部</RouterLink>
        </div>

        <div class="mt-4 flex gap-6">
          <div v-for="r in recent" :key="r.id" class="w-[302px]">
            <img
              v-if="r.url"
              :src="r.url"
              :alt="r.title"
              class="h-[180px] w-full rounded-sm object-cover"
              draggable="false"
            />
            <div
              v-else
              class="flex h-[180px] w-full items-center justify-center rounded-sm bg-parchment"
            >
              <svg width="28" height="28" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect
                  x="1.8"
                  y="2.8"
                  width="12.4"
                  height="10.4"
                  rx="2.2"
                  stroke="#cccccc"
                  stroke-width="1.4"
                />
                <circle cx="5.7" cy="6.3" r="1.15" fill="#cccccc" />
                <path
                  d="M2.3 11.7l3.4-3.2 2.6 2.4 2.4-2.2 3 2.9"
                  stroke="#cccccc"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <p class="mt-3 text-caption font-semibold text-ink">{{ r.title }}</p>
            <p class="mt-0.5 text-fine text-weak">{{ r.time }}</p>
          </div>
        </div>
      </template>
    </div>

    <ClassFormDialog
      :open="renameDialogOpen"
      mode="rename"
      :initial-name="renamingClassName"
      :existing-classes="groups"
      @close="renameDialogOpen = false"
      @submit="handleRenameClass"
    />

    <!-- 删除班级确认：普通删除进回收站，或一键删除并重建同名空班级 -->
    <div
      v-if="deleteDialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
      @click.self="closeDeleteDialog"
    >
      <div class="w-[440px] max-w-full rounded-lg bg-canvas p-6 shadow-window" data-test="delete-class-dialog">
        <h2 class="text-tagline font-semibold text-ink">
          删除班级「{{ deletingClassName }}」
        </h2>
        <p class="mt-3 text-caption leading-relaxed text-muted">
          班级下的学生档案、照片与表现记录将一并移入回收站，保留 7 天，期间可随时恢复；超过 7 天将彻底删除。
        </p>
        <div class="mt-6 flex justify-end gap-3">
          <AppButton variant="pearl" @click="closeDeleteDialog">取消</AppButton>
          <AppButton variant="danger" data-test="confirm-delete-btn" @click="handleDeleteClass(false)">
            删除
          </AppButton>
          <AppButton data-test="delete-recreate-btn" @click="handleDeleteClass(true)">
            删除并重建
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
