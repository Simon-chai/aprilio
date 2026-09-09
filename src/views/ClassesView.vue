<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import ClassFormDialog, { type ClassFormValue } from "../components/ClassFormDialog.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import { getPhotosDir, photoUrl } from "../lib/photos";
import {
  archiveClass,
  createClass,
  createStudent,
  deleteClass,
  getClassMeta,
  listClasses,
  listPhotos,
  listStudents,
  renameClass,
  restoreClass,
  saveClassMeta,
} from "../lib/db";
import { classCurrentLabel, upgradedClasses } from "../lib/semester";
import { currentSemester } from "../lib/timetable";
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
const renamingMeta = ref<{ entry_grade: number | null; entry_semester: string | null }>({
  entry_grade: null,
  entry_semester: null,
});
const deleteDialogOpen = ref(false);
const deletingClassName = ref<string | null>(null);
const archiveDialogOpen = ref(false);
const archivingClassName = ref<string | null>(null);
/** 列表筛选：在用班级 / 历史带过的班 */
const classTab = ref<"active" | "archived">("active");

/** 在用 / 已归档分组 */
const activeClasses = computed(() => groups.value.filter((g) => !g.archived_at));
const archivedClasses = computed(() => groups.value.filter((g) => g.archived_at));
const shownClasses = computed(() =>
  classTab.value === "active" ? activeClasses.value : archivedClasses.value
);

const totalStudents = computed(() =>
  activeClasses.value.reduce((acc, g) => acc + g.studentCount, 0)
);

/** 班级当前年级文案（未登记返回 null） */
function currentLabel(g: ClassSummary): string | null {
  return classCurrentLabel(g.entry_grade ?? null, g.entry_semester ?? null);
}

/** 升级提醒：已升过年级的在用班级（仅提示，不自动改数据） */
const upgradeNotices = computed(() => upgradedClasses(activeClasses.value));
/** 升级提醒的关闭状态：按学期记忆，进入新学期的第一天再提醒一次 */
const UPGRADE_NOTICE_KEY = "aprilio:upgrade-notice-dismissed-semester";

function readDismissedSemester(): string | null {
  try {
    return sessionStorage.getItem(UPGRADE_NOTICE_KEY);
  } catch {
    return null;
  }
}

const dismissedSemester = ref<string | null>(readDismissedSemester());
/** 当前学期是否已点过「知道了」 */
const noticeDismissed = computed(() => dismissedSemester.value === currentSemester());

function dismissNotice() {
  dismissedSemester.value = currentSemester();
  try {
    sessionStorage.setItem(UPGRADE_NOTICE_KEY, currentSemester());
  } catch {
    /* 存储不可用时只保留本次挂载的关闭状态 */
  }
}

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

async function handleCreateClass(value: ClassFormValue) {
  await createClass(value.name);
  if (value.entry_grade != null || value.entry_semester) {
    await saveClassMeta(value.name, {
      entry_grade: value.entry_grade,
      entry_semester: value.entry_semester,
    });
  }
  showCreateDialog.value = false;
  await refresh();
}

async function openRenameDialog(name: string) {
  renamingClassName.value = name;
  const meta = await getClassMeta(name);
  renamingMeta.value = { entry_grade: meta.entry_grade, entry_semester: meta.entry_semester };
  renameDialogOpen.value = true;
}

async function handleRenameClass(value: ClassFormValue) {
  if (renamingClassName.value) {
    await renameClass(renamingClassName.value, value.name);
    await saveClassMeta(value.name, {
      entry_grade: value.entry_grade,
      entry_semester: value.entry_semester,
    });
  }
  renameDialogOpen.value = false;
  renamingClassName.value = null;
  await refresh();
}

function openArchiveDialog(name: string) {
  archivingClassName.value = name;
  archiveDialogOpen.value = true;
}

function closeArchiveDialog() {
  archiveDialogOpen.value = false;
  archivingClassName.value = null;
}

async function handleArchiveClass() {
  const name = archivingClassName.value;
  if (!name) return;
  await archiveClass(name);
  closeArchiveDialog();
  await refresh();
}

async function handleRestoreClass(name: string) {
  await restoreClass(name);
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
        {{ activeClasses.length }} 个在用班级 · {{ totalStudents }} 名学生<span v-if="archivedClasses.length"> · 历史带过的班 {{ archivedClasses.length }} 个</span>
      </p>

      <!-- 升级提醒：新学期的第一天提示哪些班已升年级（只提示，不自动改数据） -->
      <div
        v-if="upgradeNotices.length && !noticeDismissed"
        data-test="upgrade-notice"
        class="mt-5 flex items-start justify-between gap-4 rounded-lg border border-primary/30 bg-primary-soft/50 px-4 py-3"
      >
        <div class="min-w-0">
          <p class="text-caption font-medium text-ink">新的学期开始了</p>
          <p class="mt-1 text-fine text-muted">
            <span v-for="(n, i) in upgradeNotices" :key="n.name">
              {{ i > 0 ? "、" : "" }}{{ n.name }} 现在是{{ n.label }}
            </span>
            。不再带的班级可以归档，归档后数据仍可查。
          </p>
        </div>
        <button
          type="button"
          class="inline-flex shrink-0 items-center text-caption text-primary hover:underline"
          @click="dismissNotice"
        >
          知道了
        </button>
      </div>

      <!-- 在用 / 历史带过的班 -->
      <div class="mt-6 inline-flex rounded-pill border border-hairline bg-canvas p-0.5">
        <button
          type="button"
          data-test="class-tab-active"
          class="inline-flex items-center justify-center rounded-pill px-4 py-1.5 text-caption font-medium transition-colors"
          :class="classTab === 'active' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink'"
          @click="classTab = 'active'"
        >
          在用班级
        </button>
        <button
          type="button"
          data-test="class-tab-archived"
          class="inline-flex items-center justify-center rounded-pill px-4 py-1.5 text-caption font-medium transition-colors"
          :class="classTab === 'archived' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink'"
          @click="classTab = 'archived'"
        >
          历史带过的班
        </button>
      </div>

      <!-- 班级卡片 -->
      <div v-if="shownClasses.length" class="mt-7 flex flex-wrap gap-6">
        <div
          v-for="g in shownClasses"
          :key="g.name"
          class="group relative w-[410px]"
        >
          <RouterLink
            :to="{ name: 'class-detail', params: { name: g.name } }"
            class="flex w-full flex-col gap-5 rounded-lg border border-hairline bg-canvas p-7 transition-all hover:bg-pearl active:scale-[0.98]"
            :class="g.archived_at ? 'opacity-90' : ''"
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
                  <span
                    v-if="g.archived_at"
                    class="shrink-0 rounded-pill bg-parchment px-2 py-0.5 text-[11px] text-weak"
                  >
                    已归档
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
                    v-if="!g.archived_at"
                    type="button"
                    data-test="archive-class-btn"
                    class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-weak opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:bg-parchment hover:text-ink"
                    title="归档班级（移入历史带过的班）"
                    @click.stop.prevent="openArchiveDialog(g.name)"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="4" width="18" height="4" rx="1" />
                      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
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
                  <template v-if="currentLabel(g)">
                    <span data-test="class-grade-badge" class="text-primary">{{ currentLabel(g) }}</span> ·
                  </template>
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
                <template v-if="g.archived_at">
                  归档于 {{ (g.archived_at || "").slice(0, 10) }} · 只读
                </template>
                <template v-else>
                  照片 {{ g.photoCount }} 张 (公共 {{ g.classPhotoCount }} · 个人 {{ g.studentPhotoCount }})
                </template>
              </span>
              <span
                v-if="!g.archived_at"
                class="flex items-center gap-1 text-caption text-primary transition-transform duration-150 group-hover:translate-x-0.5"
              >
                进入班级
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <button
                v-else
                type="button"
                data-test="restore-class-btn"
                class="inline-flex items-center text-caption text-primary hover:underline"
                @click.stop.prevent="handleRestoreClass(g.name)"
              >
                恢复班级
              </button>
            </div>
          </RouterLink>
        </div>
      </div>

      <p v-else-if="classTab === 'archived'" class="mt-10 text-caption text-weak">
        还没有归档的班级。归档后，班级会从「在用班级」移到这里，数据只读保留、可随时恢复。
      </p>

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
      :initial-grade="renamingMeta.entry_grade"
      :initial-semester="renamingMeta.entry_semester"
      :existing-classes="groups"
      @close="renameDialogOpen = false"
      @submit="handleRenameClass"
    />

    <!-- 归档确认：从班级管理移出，进入历史带过的班，数据只读可恢复 -->
    <div
      v-if="archiveDialogOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
      @click.self="closeArchiveDialog"
    >
      <div class="w-[440px] max-w-full rounded-lg bg-canvas p-6 shadow-window" data-test="archive-class-dialog">
        <h2 class="text-tagline font-semibold text-ink">
          归档班级「{{ archivingClassName }}」
        </h2>
        <p class="mt-3 text-caption leading-relaxed text-muted">
          归档后，班级会从「在用班级」移出，进入「历史带过的班」；学生、成绩、表现、照片、评语与课表全部保留，只读可查，随时可以恢复。
        </p>
        <div class="mt-6 flex justify-end gap-3">
          <AppButton variant="pearl" @click="closeArchiveDialog">取消</AppButton>
          <AppButton variant="primary" data-test="confirm-archive-btn" @click="handleArchiveClass">
            归档
          </AppButton>
        </div>
      </div>
    </div>

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
