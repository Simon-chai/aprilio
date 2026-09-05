<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { confirm } from "@tauri-apps/plugin-dialog";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import StatusChip from "../components/ui/StatusChip.vue";
import PhotoGrid from "../components/PhotoGrid.vue";
import StudentFormDialog from "../components/StudentFormDialog.vue";
import QuickBehaviorPopover from "../components/QuickBehaviorPopover.vue";
import StudentBehaviorTimeline from "../components/StudentBehaviorTimeline.vue";
import {
  addPhoto,
  deletePhoto,
  deleteStudent,
  getStudent,
  listBehaviorRecords,
  listPhotos,
  updateStudent,
  isTauri,
} from "../lib/db";
import { deletePhotoFile, getPhotosDir, importPhoto } from "../lib/photos";
import { formatShort } from "../lib/format";
import { STATUS_LABEL } from "../types";
import type { BehaviorPolarity, Photo, Student, StudentBehaviorRecord, StudentInput } from "../types";

const route = useRoute();
const router = useRouter();

const id = computed(() => Number(route.params.id));
const student = ref<Student | null>(null);
const photos = ref<Photo[]>([]);
const behaviors = ref<StudentBehaviorRecord[]>([]);
const activeTab = ref<"behaviors" | "photos">("behaviors");
const photosDir = ref("");
const loading = ref(true);
const error = ref("");
const dialogOpen = ref(false);
const busy = ref(false);

const quickOpen = ref(false);
const quickAnchor = ref<{ x: number; y: number } | null>(null);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

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
  toast.value = `已记录 ${payload.studentName} ${payload.dimensionName}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2400);
  behaviors.value = await listBehaviorRecords(id.value);
}

onBeforeUnmount(() => clearTimeout(toastTimer));

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [s, p, b] = await Promise.all([
      getStudent(id.value),
      listPhotos(id.value),
      listBehaviorRecords(id.value),
    ]);
    student.value = s;
    photos.value = p;
    behaviors.value = b;
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
    ["入学日期", s.enroll_date || "—"],
    ["家庭住址", s.address || "—"],
  ] as const;
});

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
  const ok = isTauri()
    ? await confirm(`删除「${photo.caption || "未命名"}」这张图片？`, {
        title: "删除图片",
        kind: "warning",
      })
    : window.confirm("删除这张图片？");
  if (!ok) return;

  await deletePhoto(photo.id);
  await deletePhotoFile(photo.file_name);
  await refresh();
}

async function onDeleteStudent() {
  const ok = isTauri()
    ? await confirm(`删除学生「${student.value?.name ?? ""}」及其全部图片记录？`, {
        title: "删除学生",
        kind: "warning",
      })
    : window.confirm("删除该学生及其全部图片记录？");
  if (!ok) return;

  for (const p of photos.value) await deletePhotoFile(p.file_name);
  await deleteStudent(id.value);
  router.push({ name: "students" });
}

function goBack() {
  if (window?.history?.state?.back) {
    router.back();
    return;
  }
  if (student.value?.grade_class) {
    router.push(`/classes/${encodeURIComponent(student.value.grade_class)}`);
    return;
  }
  router.push({ name: "students" });
}
</script>

<template>
  <!-- 顶栏 -->
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <div class="flex items-center gap-2.5">
      <button class="text-ink" title="返回列表" @click="goBack">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M10 3L5 8L10 13"
            stroke="#1d1d1f"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <h1 class="text-tagline font-semibold text-ink">学生详情</h1>
    </div>
    <div class="flex items-center gap-3">
      <AppButton
        data-test="quick-behavior-btn"
        :disabled="!student"
        @click="openQuickBehavior"
      >
        + 记表现
      </AppButton>
      <AppButton variant="secondary" :disabled="!student" @click="dialogOpen = true">
        编辑档案
      </AppButton>
      <AppButton variant="secondary" :disabled="!student || busy" @click="onAddPhoto">
        添加图片
      </AppButton>
    </div>
  </header>

  <!-- 内容 -->
  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <p v-if="error" class="mb-6 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
      {{ error }}
    </p>

    <template v-if="student">
      <!-- 档案头部 -->
      <div class="flex items-center gap-6">
        <div class="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-parchment">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <circle cx="20" cy="14" r="7" fill="#cccccc" />
            <path d="M6 36c0-7.2 6.3-11 14-11s14 3.8 14 11" fill="#cccccc" />
          </svg>
        </div>
        <div class="min-w-0 flex-1 space-y-2.5">
          <div class="flex items-center gap-3">
            <h2 class="text-display font-semibold text-ink">{{ student.name }}</h2>
            <StatusChip>{{ STATUS_LABEL[student.status] ?? student.status }}</StatusChip>
          </div>
          <div class="flex items-center gap-2 text-caption text-weak">
            <span>学号 {{ student.student_no }}</span>
            <span class="h-[3px] w-[3px] rounded-full bg-faint" />
            <span>{{ student.grade_class || "未分班" }}</span>
            <span class="h-[3px] w-[3px] rounded-full bg-faint" />
            <span>{{ student.gender || "性别未填" }}</span>
          </div>
          <p class="text-caption text-muted">
            最近更新 {{ formatShort(student.updated_at) }} · 共 {{ photos.length }} 张图片 · 共 {{ behaviors.length }} 条表现记录
          </p>
        </div>
        <AppButton variant="danger" @click="onDeleteStudent">删除学生</AppButton>
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
                class="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
              >
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
            </div>
            <p v-else class="py-2 text-caption text-weak">暂未登记监护人信息</p>
          </AppCard>
        </div>

        <!-- 右侧卡片：Tab 主体 -->
        <AppCard fill class="flex flex-col gap-4">
          <div class="flex items-center justify-between border-b border-hairline pb-3">
            <div class="flex items-center gap-2">
              <button
                type="button"
                data-test="tab-behaviors"
                class="rounded-sm px-3.5 py-1.5 text-caption font-medium transition-colors"
                :class="activeTab === 'behaviors' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
                @click="activeTab = 'behaviors'"
              >
                日常表现 ({{ behaviors.length }})
              </button>
              <button
                type="button"
                data-test="tab-photos"
                class="rounded-sm px-3.5 py-1.5 text-caption font-medium transition-colors"
                :class="activeTab === 'photos' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
                @click="activeTab = 'photos'"
              >
                图片记录 ({{ photos.length }})
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
              <button
                type="button"
                class="text-caption text-primary transition-opacity hover:opacity-80"
                @click="onAddPhoto"
              >
                从本地导入
              </button>
            </div>
          </div>

          <!-- Tab 内容：日常表现 -->
          <div v-if="activeTab === 'behaviors'">
            <StudentBehaviorTimeline
              :key="student.id"
              :records="behaviors"
              :loading="loading"
              @add="openQuickBehavior"
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

            <p v-if="!loading && !photos.length" class="py-6 text-center text-caption text-weak">
              还没有图片记录，点上面的「添加图片」从本地选一张。
            </p>
          </div>
        </AppCard>
      </div>
    </template>

    <p v-else-if="loading" class="py-20 text-center text-caption text-weak">加载中…</p>
    <p v-else class="py-20 text-center text-caption text-weak">找不到这个学生</p>
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

  <!-- 快捷记表现 Toast 提示 -->
  <Transition name="qb-toast">
    <div
      v-if="toast"
      data-test="quick-toast"
      class="fixed inset-x-0 top-4 z-[60] mx-auto w-fit rounded-full bg-tile px-4 py-1.5 text-fine text-white shadow-lg"
    >
      {{ toast }}
    </div>
  </Transition>
</template>

<style scoped>
.qb-toast-enter-active,
.qb-toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.qb-toast-enter-from,
.qb-toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
