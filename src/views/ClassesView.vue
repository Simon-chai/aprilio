<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppIconButton from "../components/ui/AppIconButton.vue";
import ClassFormDialog, { type ClassFormValue } from "../components/ClassFormDialog.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import ImportRosterDialog from "../components/ImportRosterDialog.vue";
import ImportScoreDialog from "../components/ImportScoreDialog.vue";
import { getPhotosDir, photoUrl } from "../lib/photos";
import { onPageAction } from "../agent/page-action-bus";
import { clearPageContext, reportPageContext } from "../agent/page-context-bus";
import type { ImportRosterMode } from "../agent/page-actions/classes-import-roster";
import type { RosterImportResult, RosterTable } from "../lib/roster";
import {
  archiveClass,
  createClass,
  createStudent,
  deleteClass,
  getStats,
  listClasses,
  listPhotos,
  listStudents,
  renameClass,
  restoreClass,
} from "../lib/db";
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
/** 添加学生对话框预填（Agent 动作可带参） */
const studentDialogInitial = ref<Partial<StudentInput> | null>(null);
const importOpen = ref(false);
const importMode = ref<ImportRosterMode>("smart");
// 花名册对话框检测到成绩单后交接进来：携带已解析表格直接进入成绩导入
const scoreImportOpen = ref(false);
const scoreHandoff = ref<{ table: RosterTable; fileName: string } | null>(null);
const renameDialogOpen = ref(false);
const renamingClassName = ref<string | null>(null);
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
/** 全库本月新增学生数（原学生档案页统计卡迁移至此） */
const monthNew = ref(0);

/** 花名册批量导入入口：就地打开导入对话框（多班花名册按表内班级列自动分发） */
function openImportDialog(mode: ImportRosterMode = "smart") {
  importMode.value = mode;
  importOpen.value = true;
}

/** 手动添加单个学生：创建后留在本页刷新统计 */
function openStudentDialog(preset?: Partial<StudentInput> | null) {
  studentDialogInitial.value = preset ?? null;
  showStudentDialog.value = true;
}

async function handleCreateStudent(input: StudentInput) {
  await createStudent(input);
  showStudentDialog.value = false;
  await refresh();
}

/** 花名册导入完成：无失败行 → 关闭对话框并进入目标班级详情；有失败行 → 留在对话框看明细 */
function onRosterImported(payload: { result: RosterImportResult; targetClass: string | null }) {
  void refresh();
  if (payload.result.failed.length > 0) return;
  importOpen.value = false;
  if (payload.targetClass) {
    router.push({ name: "class-detail", params: { name: payload.targetClass } });
  }
}

/** 花名册对话框检测到成绩单：交接已解析表格，就地打开成绩导入 */
function switchToScoreImport(payload: { table: RosterTable; fileName: string }) {
  importOpen.value = false;
  scoreHandoff.value = payload;
  scoreImportOpen.value = true;
}

function closeScoreImport() {
  scoreImportOpen.value = false;
  scoreHandoff.value = null;
}

/** 成绩导入完成：进入归属班级的详情页查看成绩 */
function onScoreImported(payload: { className: string | null }) {
  closeScoreImport();
  void refresh();
  if (payload.className) {
    router.push({ name: "class-detail", params: { name: payload.className } });
  }
}

// Agent 的 ui_action 广播：班级维度动作在本页接住（添加学生 / 导入花名册对话框）
const offCreateStudentAction = onPageAction<Partial<StudentInput>>(
  "classes/create-student",
  (preset) => openStudentDialog(preset),
);
const offImportRosterAction = onPageAction<ImportRosterMode>("classes/import-roster", (mode) =>
  openImportDialog(mode ?? "smart"),
);

/** Agent 页面上下文：班级管理页的渲染概况（分组计数与当前页签，数据与页面同源） */
function reportContext(): void {
  reportPageContext({
    page: "classes",
    title: "班级管理",
    summary: [
      `在用 ${activeClasses.value.length} 个 · 已归档 ${archivedClasses.value.length} 个`,
      `在用班级学生共 ${totalStudents.value} 人`,
      `当前页签：${classTab.value === "active" ? "在用班级" : "历史带过的班"}`,
    ].join(" · "),
  });
}
watch(classTab, () => reportContext());

onMounted(() => {
  document.addEventListener("mousedown", onCardMenuMouseDown);
  document.addEventListener("keydown", onCardMenuKeydown);
  void refresh();
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onCardMenuMouseDown);
  document.removeEventListener("keydown", onCardMenuKeydown);
  offCreateStudentAction();
  offImportRosterAction();
  clearPageContext("classes");
});

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
  const [classList, studentRows, photoRows, stats] = await Promise.all([
    listClasses(),
    listStudents(),
    listPhotos(),
    getStats(),
  ]);
  groups.value = classList;
  rows.value = studentRows;
  photos.value = photoRows;
  names.value = new Map(studentRows.map((s) => [s.id, s.name]));
  monthNew.value = stats.month_new;
  photosDir.value = await getPhotosDir();
  reportContext();
}

async function handleCreateClass(value: ClassFormValue) {
  await createClass(value.name);
  showCreateDialog.value = false;
  await refresh();
}

function openRenameDialog(name: string) {
  renamingClassName.value = name;
  renameDialogOpen.value = true;
}

/** 卡片右上角「⋯」菜单：归档 / 删除这类一个班生命周期基本只用一次的低频操作 */
const cardMenuFor = ref<string | null>(null);

function toggleCardMenu(name: string) {
  cardMenuFor.value = cardMenuFor.value === name ? null : name;
}

function closeCardMenu() {
  cardMenuFor.value = null;
}

/** 点菜单（及其触发器）以外的地方收起；菜单内容点击由自身 handler 收起 */
function onCardMenuMouseDown(e: MouseEvent) {
  if (!cardMenuFor.value) return;
  const root = (e.target as HTMLElement).closest?.("[data-card-menu-root]");
  if (!root) cardMenuFor.value = null;
}

function onCardMenuKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") cardMenuFor.value = null;
}

async function handleRenameClass(value: ClassFormValue) {
  if (renamingClassName.value) {
    await renameClass(renamingClassName.value, value.name);
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
    <header class="flex h-16 shrink-0 items-center border-b border-divider bg-canvas pl-7 pr-10">
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
    </header>

    <!-- 内容：窄窗口整页可横向滚动，固定宽卡片不裁切 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-auto px-20 py-10">
      <h1 class="text-display font-semibold text-ink">班级管理</h1>
      <p class="mt-2 text-caption text-weak">
        {{ activeClasses.length }} 个在用班级 · {{ totalStudents }} 名学生 · 本月新增 {{ monthNew }}<span v-if="archivedClasses.length"> · 历史带过的班 {{ archivedClasses.length }} 个</span>
      </p>

      <!-- 在用 / 历史带过的班 + 快捷操作 -->
      <div class="mt-6 flex items-center gap-4" data-test="class-tab-row">
        <div
          class="inline-flex rounded-pill border border-hairline bg-canvas p-0.5"
          data-test="class-tab-group"
        >
          <button
            type="button"
            data-test="class-tab-active"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-pill px-4 py-1.5 text-caption font-medium transition-[color,box-shadow]"
            :class="classTab === 'active' ? 'grad-border-soft text-primary' : 'text-weak hover:text-ink'"
            @click="classTab = 'active'"
          >
            在用班级
          </button>
          <button
            type="button"
            data-test="class-tab-archived"
            class="inline-flex items-center justify-center whitespace-nowrap rounded-pill px-4 py-1.5 text-caption font-medium transition-[color,box-shadow]"
            :class="classTab === 'archived' ? 'grad-border-soft text-primary' : 'text-weak hover:text-ink'"
            @click="classTab = 'archived'"
          >
            历史带过的班
          </button>
        </div>

        <!-- 快捷操作：渐变描边图标按钮，可点性常显 -->
        <div class="flex items-center gap-2" data-test="class-quick-actions">
          <AppIconButton
            label="导入花名册"
            data-test="import-roster-btn"
            @click="openImportDialog('smart')"
          >
            <!-- 花名册：大号 2×3 格表格在左下，加号在右上角外侧、与表格留白分离 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2.8" y="11.4" width="17.6" height="9.6" rx="2.4" />
              <path d="M2.8 16.2h17.6M8.67 11.4V21M14.53 11.4V21" />
              <path d="M19.2 3v5.4M16.5 5.7h5.4" />
            </svg>
          </AppIconButton>

          <AppIconButton
            label="新建班级"
            data-test="add-class-btn"
            @click="showCreateDialog = true"
          >
            <!-- 加号 + 尖顶房子 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.8 11 12 4.3 20.2 11v9a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8Z" />
              <path d="M12 12v5.6M9.2 14.8h5.6" />
            </svg>
          </AppIconButton>
        </div>
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
              <!-- 班级名 + 简略信息独占一列，名称本身即改名入口（低频操作不占版面） -->
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    data-test="rename-class-btn"
                    class="group/name relative inline-flex min-w-0 items-center gap-1.5 text-left"
                    :aria-label="`编辑班级名称：${g.name}`"
                    @click.stop.prevent="openRenameDialog(g.name)"
                  >
                    <span class="truncate text-tagline font-semibold -tracking-[0.3px] text-ink transition-colors group-hover/name:text-primary">
                      {{ g.name }}
                    </span>
                    <svg
                      class="shrink-0 text-faint opacity-0 transition-opacity duration-150 group-hover/name:opacity-100"
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                    >
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                    <!-- 悬浮说明：WebView 原生 title 不可靠，自绘 tooltip -->
                    <span
                      role="tooltip"
                      class="pointer-events-none absolute -top-1 left-0 z-10 -translate-y-full whitespace-nowrap rounded-sm bg-tile px-2 py-0.5 text-fine text-white opacity-0 shadow-md transition-opacity duration-150 group-hover/name:opacity-100 group-focus-visible/name:opacity-100"
                    >
                      点击编辑班级名称
                    </span>
                  </button>
                  <span
                    v-if="g.archived_at"
                    class="shrink-0 rounded-pill bg-parchment px-2 py-0.5 text-[11px] text-weak"
                  >
                    已归档
                  </span>
                </div>
                <p class="mt-0.5 text-caption text-weak">
                  {{ g.studentCount }} 名学生 ({{ g.maleCount }} 男 · {{ g.femaleCount }} 女)
                </p>
              </div>
              <!-- 低频操作收进「⋯」菜单：归档 / 删除，一个班生命周期基本只用一次 -->
              <div class="relative shrink-0" data-card-menu-root data-test="class-card-menu" @click.stop>
                <AppIconButton
                  label="更多操作"
                  data-test="card-menu-btn"
                  @click.stop.prevent="toggleCardMenu(g.name)"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.7" />
                    <circle cx="12" cy="12" r="1.7" />
                    <circle cx="19" cy="12" r="1.7" />
                  </svg>
                </AppIconButton>
                <div
                  v-if="cardMenuFor === g.name"
                  data-test="card-menu"
                  class="absolute right-0 top-full z-30 mt-1.5 w-36 rounded-lg border border-hairline bg-canvas p-1.5 shadow-lg"
                >
                  <button
                    v-if="!g.archived_at"
                    type="button"
                    data-test="card-menu-archive"
                    class="inline-flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption text-muted transition-colors hover:bg-pearl hover:text-ink"
                    @click.stop.prevent="closeCardMenu(); openArchiveDialog(g.name)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="4" rx="1" />
                      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
                    </svg>
                    归档班级
                  </button>
                  <button
                    type="button"
                    data-test="card-menu-delete"
                    class="inline-flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption text-danger transition-colors hover:bg-danger-soft"
                    @click.stop.prevent="closeCardMenu(); openDeleteDialog(g.name)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                    删除班级
                  </button>
                </div>
              </div>
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
        还没有学生记录 —— 点击「导入花名册」图标批量建档，或进入班级后手动添加学生。
      </p>

      <!-- 最近记录 -->
      <template v-if="recent.length">
        <div class="mt-12 flex items-center justify-between">
          <h2 class="text-tagline font-semibold -tracking-[0.3px] text-ink">最近记录</h2>
          <RouterLink to="/photos" class="text-caption text-primary">查看全部</RouterLink>
        </div>

        <!-- 最近记录：窄窗口时横向滚动查看，不折行不隐藏 -->
        <div class="scrollbar-none mt-4 flex gap-6 overflow-x-auto pb-1">
          <div v-for="r in recent" :key="r.id" class="w-[302px] shrink-0">
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

    <!-- 新建班级 / 添加学生：浮层统一收在页面底部 -->
    <ClassFormDialog
      :open="showCreateDialog"
      mode="create"
      :existing-classes="groups"
      @close="showCreateDialog = false"
      @submit="handleCreateClass"
    />

    <StudentFormDialog
      :open="showStudentDialog"
      :initial="studentDialogInitial"
      title="添加学生"
      @close="showStudentDialog = false"
      @submit="handleCreateStudent"
    />

    <ImportRosterDialog
      :open="importOpen"
      :initial-mode="importMode"
      @close="importOpen = false"
      @imported="onRosterImported"
      @switch-to-scores="switchToScoreImport"
    />

    <ImportScoreDialog
      :open="scoreImportOpen"
      :initial-table="scoreHandoff?.table ?? null"
      :initial-file-name="scoreHandoff?.fileName ?? ''"
      @close="closeScoreImport"
      @imported="onScoreImported"
    />

    <ClassFormDialog
      :open="renameDialogOpen"
      mode="rename"
      :initial-name="renamingClassName"
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
