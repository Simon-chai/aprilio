<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppCard from "../components/ui/AppCard.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import AppIconButton from "../components/ui/AppIconButton.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import StatusChip from "../components/ui/StatusChip.vue";
import PhotoGrid from "../components/PhotoGrid.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import QuickBehaviorPopover from "../components/QuickBehaviorPopover.vue";
import StudentBehaviorTimeline from "../components/StudentBehaviorTimeline.vue";
import StudentScorePanel from "../components/StudentScorePanel.vue";
import TermCommentPanel from "../components/TermCommentPanel.vue";
import HomeworkPanel from "../components/HomeworkPanel.vue";
import EvalReportPanel from "../components/EvalReportPanel.vue";
import {
  addPhoto,
  deleteBehaviorRecord,
  deletePhoto,
  deleteStudent,
  getStudent,
  listBehaviorRecords,
  listPhotos,
  listStudentExamScores,
  updateStudent,
  isTauri,
} from "../lib/db";
import { deletePhotoFile, getPhotosDir, importPhoto } from "../lib/photos";
import { formatShort } from "../lib/format";
import { currentSemester, semesterLabel } from "../lib/timetable";
import { recentSemesters, semesterOfDate } from "../lib/semester";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import { STATUS_LABEL } from "../types";
import type { BehaviorPolarity, Photo, Student, StudentBehaviorRecord, StudentExamScore, StudentInput } from "../types";

const route = useRoute();
const router = useRouter();

const id = computed(() => Number(route.params.id));
const student = ref<Student | null>(null);
const photos = ref<Photo[]>([]);
const behaviors = ref<StudentBehaviorRecord[]>([]);
const examScores = ref<StudentExamScore[]>([]);
const activeTab = ref<"behaviors" | "photos" | "scores" | "comment" | "homework" | "report">("behaviors");
const photosDir = ref("");
const loading = ref(true);
const error = ref("");
const dialogOpen = ref(false);
const busy = ref(false);

/** 学期视角：默认当前学期，可回看历史学期 */
const activeSemester = ref(currentSemester());

/** 该生出现过的全部学期（成绩 + 表现推导），按倒序；至少含当前学期 */
const semesterOptions = computed<string[]>(() => {
  // 最近若干学期兜底：某学期即使没有任何数据，也要能切过去查看空态
  const set = new Set<string>([currentSemester(), ...recentSemesters(6)]);
  for (const s of examScores.value) set.add(semesterOfDate(s.exam_date));
  for (const b of behaviors.value) set.add(semesterOfDate(b.recorded_date));
  return [...set].sort((a, b) => (a < b ? 1 : -1));
});

/** 按选中学期过滤的表现记录（学期由 recorded_date 实时推导） */
const semesterBehaviors = computed(() =>
  behaviors.value.filter((b) => semesterOfDate(b.recorded_date) === activeSemester.value)
);

const quickOpen = ref(false);
const quickAnchor = ref<{ x: number; y: number } | null>(null);
/** 全局轻反馈（ToastHost 挂在 App.vue）：快捷记表现 / 删除表现的落地提示 */
const toast = useToast();

function openQuickBehavior(e?: MouseEvent) {
  if (e && (e.currentTarget || e.target)) {
    const el = (e.currentTarget || e.target) as HTMLElement;
    if (typeof el.getBoundingClientRect === "function") {
      const rect = el.getBoundingClientRect();
      quickAnchor.value = { x: rect.right, y: rect.bottom + 6 };
    } else {
      quickAnchor.value = null;
    }
  } else {
    quickAnchor.value = null;
  }
  quickOpen.value = true;
}

async function onQuickSaved(payload: { studentName: string; dimensionName: string; polarity: BehaviorPolarity }) {
  toast(`已记录 ${payload.studentName} ${payload.dimensionName}`);
  behaviors.value = await listBehaviorRecords(id.value);
}

/** 删除一条表现记录（含评语），并刷新时间轴 */
async function handleRemoveBehavior(recordId: number) {
  await deleteBehaviorRecord(recordId);
  toast("已删除该条表现记录");
  behaviors.value = await listBehaviorRecords(id.value);
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [s, p, b, es] = await Promise.all([
      getStudent(id.value),
      listPhotos(id.value),
      listBehaviorRecords(id.value),
      listStudentExamScores(id.value),
    ]);
    student.value = s;
    photos.value = p;
    behaviors.value = b;
    examScores.value = es;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  photosDir.value = await getPhotosDir();
  await refresh();
});
watch(id, refresh);

const fields = computed(() => {
  const s = student.value;
  if (!s) return [];
  return [
    ["姓名", s.name],
    ["性别", s.gender || "—"],
    ["出生日期", s.birth_date || "—"],
    ["学号", s.student_no],
    ["年级班级", s.grade_class || "—"],
    ["身份证号", s.id_card || "—"],
    ["家庭住址", s.address || "—"],
  ] as const;
});

/** 参加过的考试批次数（Tab 徽标用） */
const examCount = computed(() => new Set(examScores.value.map((s) => s.exam_id)).size);

async function onSave(input: StudentInput) {
  await updateStudent(id.value, input);
  dialogOpen.value = false;
  await refresh();
}

async function onAddPhoto() {
  if (!isTauri()) {
    error.value = "图片导入需要 Tauri 外壳，请用 npm run tauri:dev 启动";
    return;
  }
  busy.value = true;
  try {
    const fileName = await importPhoto();
    if (fileName) {
      await addPhoto(id.value, fileName, null, new Date().toISOString().slice(0, 10));
      await refresh();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onRemovePhoto(photo: Photo) {
  const ok = await confirmAction({
    title: "删除图片",
    message: `删除「${photo.caption || "未命名"}」这张图片？`,
    tone: "danger",
    confirmText: "删除",
  });
  if (!ok) return;

  await deletePhoto(photo.id);
  await deletePhotoFile(photo.file_name);
  await refresh();
}

async function onDeleteStudent() {
  const ok = await confirmAction({
    title: `删除学生「${student.value?.name ?? ""}」`,
    message: "删除后将移入回收站，保留 7 天，期间可恢复。",
    tone: "danger",
    confirmText: "删除",
  });
  if (!ok) return;

  await deleteStudent(id.value);
  goBackToList();
}

/** 删除 / 无返回历史时回到学生所属班级；没有班级则回班级管理列表 */
function goBackToList() {
  if (student.value?.grade_class) {
    router.push(`/classes/${encodeURIComponent(student.value.grade_class)}`);
    return;
  }
  router.push({ name: "classes" });
}

function goBack() {
  if (window?.history?.state?.back) {
    router.back();
    return;
  }
  goBackToList();
}
</script>

<template>
  <!-- 顶栏：只放页面级导航与学期筛选；学生个人操作贴着档案头部的姓名（窄窗口横向滚动，不换行） -->
  <header
    class="scrollbar-none flex h-[52px] shrink-0 items-center justify-between gap-4 overflow-x-auto border-b border-hairline bg-parchment px-8"
  >
    <div class="flex shrink-0 items-center gap-2.5">
      <button class="text-ink" title="返回列表" @click="goBack">
        <AppIcon name="arrow-left" />
      </button>
      <h1 class="whitespace-nowrap text-tagline font-semibold text-ink">学生详情</h1>
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <label class="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-caption text-weak">
        学期
        <select
          v-model="activeSemester"
          data-test="semester-select"
          class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
        >
          <option v-for="sem in semesterOptions" :key="sem" :value="sem">
            {{ semesterLabel(sem) }}
          </option>
        </select>
      </label>
    </div>
  </header>

  <!-- 内容：窄窗口不出竖排，整页内容按最小宽度横向滚动 -->
  <div class="scroll-thin flex-1 overflow-auto p-8">
    <div class="min-w-[1000px]">
    <p v-if="error" class="mb-6 rounded-md bg-danger-soft p-3 text-caption text-danger">
      {{ error }}
    </p>

    <template v-if="student">
      <!-- 档案头部 -->
      <div class="flex items-center gap-6">
        <div class="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-parchment">
          <AppIcon name="person" :size="40" class="text-faint" />
        </div>
        <div class="min-w-0 flex-1 space-y-2.5">
          <div class="flex items-center gap-3">
            <h2 class="min-w-0 truncate text-display font-semibold text-ink">{{ student.name }}</h2>
            <StatusChip>{{ STATUS_LABEL[student.status] ?? student.status }}</StatusChip>
          </div>
          <div class="flex min-w-0 items-center gap-2 text-caption text-weak">
            <span class="whitespace-nowrap">学号 {{ student.student_no }}</span>
            <span class="h-[3px] w-[3px] shrink-0 rounded-full bg-faint" />
            <span class="whitespace-nowrap">{{ student.grade_class || "未分班" }}</span>
            <span class="h-[3px] w-[3px] shrink-0 rounded-full bg-faint" />
            <span class="whitespace-nowrap">{{ student.gender || "性别未填" }}</span>
          </div>
          <p class="text-caption text-muted">
            最近更新 {{ formatShort(student.updated_at) }} · 共 {{ photos.length }} 张图片 · 共 {{ behaviors.length }} 条表现记录
          </p>
        </div>
        <!-- 学生个人操作：常显「图标 + 文字」胶囊（与班级详情页身份行同款），只作用于该生，不涉及班级管理 -->
        <div class="flex shrink-0 items-center gap-2">
          <AppIconButton
            label="记表现"
            show-label
            data-test="quick-behavior-btn"
            @click="openQuickBehavior"
          >
            <AppIcon name="plus" :size="12" />
          </AppIconButton>
          <AppIconButton label="编辑档案" show-label @click="dialogOpen = true">
            <AppIcon name="edit" :size="12" />
          </AppIconButton>
          <AppIconButton
            label="关联图片"
            show-label
            data-test="associate-photo-btn"
            :disabled="busy"
            @click="onAddPhoto"
          >
            <AppIcon name="photo" :size="12" />
          </AppIconButton>
          <AppIconButton label="删除学生" tone="danger" show-label @click="onDeleteStudent">
            <AppIcon name="trash" :size="12" />
          </AppIconButton>
        </div>
      </div>

      <!-- 主体 -->
      <div class="mt-8 flex items-stretch gap-6">
        <div class="w-[400px] shrink-0 space-y-5">
          <AppCard>
            <h3 class="mb-1 text-body font-semibold text-ink">基本信息</h3>
            <div>
              <div
                v-for="[label, value] in fields"
                :key="label"
                class="flex h-[34px] items-center justify-between border-b border-divider last:border-b-0"
              >
                <span class="text-fine text-weak">{{ label }}</span>
                <span class="text-caption text-ink">{{ value }}</span>
              </div>
            </div>
          </AppCard>

          <AppCard>
            <div class="mb-3 flex items-center justify-between">
              <h3 class="text-body font-semibold text-ink">家长联系</h3>
              <span class="rounded-pill bg-parchment px-2 py-0.5 text-fine text-weak">
                {{ student.guardians?.length ?? 0 }} 位
              </span>
            </div>
            <div v-if="student.guardians?.length" class="divide-y divide-divider">
              <div
                v-for="g in student.guardians"
                :key="g.name + g.phone"
                class="py-2.5 first:pt-0 last:pb-0"
              >
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="rounded bg-parchment px-2 py-0.5 text-fine font-medium text-ink shrink-0">
                      {{ g.relation || "监护人" }}
                    </span>
                    <span class="truncate text-caption font-medium text-ink">{{ g.name }}</span>
                    <span
                      v-if="g.is_primary"
                      class="rounded-pill bg-primary-soft px-2 py-0.5 text-[11px] text-primary shrink-0"
                    >
                      主联系
                    </span>
                  </div>
                  <span class="text-caption text-muted shrink-0">{{ g.phone || "—" }}</span>
                </div>
                <div
                  v-if="g.occupation || g.tags?.length"
                  class="mt-1.5 flex flex-wrap items-center gap-1.5"
                >
                  <span v-if="g.occupation" class="text-fine text-weak">
                    职业 {{ g.occupation }}
                  </span>
                  <span
                    v-for="tag in g.tags ?? []"
                    :key="tag"
                    class="rounded-pill bg-parchment px-2 py-0.5 text-[11px] text-muted"
                  >
                    {{ tag }}
                  </span>
                </div>
              </div>
            </div>
            <p v-else class="py-2 text-caption text-weak">暂未登记监护人信息</p>
          </AppCard>
        </div>

        <!-- 右侧卡片：Tab 主体 -->
        <AppCard fill class="flex flex-col gap-4">
          <div class="flex items-center justify-between gap-3 border-b border-hairline">
            <div class="scrollbar-none flex min-w-0 items-center gap-2 overflow-x-auto">
              <button
                type="button"
                data-test="tab-behaviors"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'behaviors' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'behaviors'"
              >
                日常表现 ({{ semesterBehaviors.length }})
              </button>
              <button
                type="button"
                data-test="tab-photos"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'photos' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'photos'"
              >
                图片记录 ({{ photos.length }})
              </button>
              <button
                type="button"
                data-test="tab-scores"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'scores' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'scores'"
              >
                成绩 ({{ examCount }})
              </button>
              <button
                type="button"
                data-test="tab-comment"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'comment' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'comment'"
              >
                学期评语
              </button>
              <button
                type="button"
                data-test="tab-homework"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'homework' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'homework'"
              >
                作业
              </button>
              <button
                type="button"
                data-test="tab-report"
                class="relative whitespace-nowrap px-3.5 py-2 text-caption font-medium transition-colors"
                :class="activeTab === 'report' ? 'text-primary font-semibold tab-energy' : 'text-weak hover:text-ink'"
                @click="activeTab = 'report'"
              >
                评价报告
              </button>
            </div>
            <div v-if="activeTab === 'behaviors'">
              <button
                type="button"
                class="text-caption text-primary transition-opacity hover:opacity-80"
                @click="openQuickBehavior"
              >
                + 记表现
              </button>
            </div>
            <div v-else-if="activeTab === 'photos'">
              <AppIconButton
                label="从本地导入照片"
                data-test="add-photo-btn"
                @click="onAddPhoto"
              >
                <!-- 语义图标：上传托盘，与「导入花名册」同一套图标 -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="M7 8l5-5 5 5" />
                  <path d="M12 3v12" />
                </svg>
              </AppIconButton>
            </div>
          </div>

          <!-- Tab 内容：日常表现 -->
          <div v-if="activeTab === 'behaviors'">
            <StudentBehaviorTimeline
              :key="`${student.id}-${activeSemester}`"
              :records="semesterBehaviors"
              :loading="loading"
              @add="openQuickBehavior"
              @remove="handleRemoveBehavior"
            />
          </div>

          <!-- Tab 内容：图片记录 -->
          <div v-else-if="activeTab === 'photos'" class="flex flex-col gap-4">
            <PhotoGrid
              :photos="photos"
              :dir="photosDir"
              can-add
              @add="onAddPhoto"
              @remove="onRemovePhoto"
            />

            <EmptyState
              v-if="!loading && !photos.length"
              title="还没有图片记录"
              description="点上面的「关联图片」从本地选一张。"
            />
          </div>

          <!-- Tab 内容：成绩（班级成绩导入后自动关联） -->
          <div v-else-if="activeTab === 'scores'">
            <StudentScorePanel :student-id="student.id" :semester="activeSemester" />
          </div>

          <!-- Tab 内容：学期评语 -->
          <div v-else-if="activeTab === 'comment'">
            <TermCommentPanel
              :student-id="student.id"
              :student-name="student.name"
              :grade-class="student.grade_class"
              :semester="activeSemester"
              :behaviors="semesterBehaviors"
              :exam-scores="examScores"
            />
          </div>

          <!-- Tab 内容：作业台账 -->
          <div v-else-if="activeTab === 'homework'">
            <HomeworkPanel :student-id="student.id" :semester="activeSemester" />
          </div>

          <!-- Tab 内容：评价报告 -->
          <div v-else-if="activeTab === 'report'">
            <EvalReportPanel
              :student-id="student.id"
              :student-name="student.name"
              :grade-class="student.grade_class"
              :semester="activeSemester"
            />
          </div>
        </AppCard>
      </div>
    </template>

    <p v-else-if="loading" class="py-20 text-center text-caption text-weak">加载中…</p>
    <p v-else class="py-20 text-center text-caption text-weak">找不到这个学生</p>
    </div>
  </div>

  <StudentFormDialog
    :open="dialogOpen"
    :initial="student"
    title="编辑档案"
    @close="dialogOpen = false"
    @submit="onSave"
  />

  <QuickBehaviorPopover
    :open="quickOpen"
    :student="student"
    :anchor="quickAnchor"
    @close="quickOpen = false"
    @saved="onQuickSaved"
  />
</template>
