<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { getPhotosDir, photoUrl } from "../lib/photos";
import { listPhotos, listStudents } from "../lib/db";
import type { Photo, StudentRow } from "../types";

interface ClassGroup {
  name: string;
  students: number;
  photos: number;
}

interface RecordCard {
  id: number;
  title: string;
  time: string;
  url: string;
}

const rows = ref<StudentRow[]>([]);
const photos = ref<Photo[]>([]);
const names = ref<Map<number, string>>(new Map());
const photosDir = ref("");

const groups = computed<ClassGroup[]>(() => {
  const map = new Map<string, ClassGroup>();
  for (const r of rows.value) {
    const key = r.grade_class || "未分班";
    const g = map.get(key) ?? { name: key, students: 0, photos: 0 };
    g.students += 1;
    g.photos += r.photo_count;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

const totalStudents = computed(() => rows.value.length);

/** 最近 4 条图片记录；浏览器演示模式下文件不存在，展示占位底色 */
const recent = computed<RecordCard[]>(() =>
  photos.value.slice(0, 4).map((p) => ({
    id: p.id,
    title: p.caption || names.value.get(p.student_id) || "图片记录",
    time: (p.taken_at || p.created_at || "").slice(0, 10),
    url: photoUrl(photosDir.value, p.file_name),
  }))
);

onMounted(async () => {
  const [studentRows, photoRows] = await Promise.all([listStudents(), listPhotos()]);
  rows.value = studentRows;
  photos.value = photoRows;
  names.value = new Map(studentRows.map((s) => [s.id, s.name]));
  photosDir.value = await getPhotosDir();
});
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

      <button
        class="flex items-center gap-1.5 rounded-pill bg-primary px-[22px] py-[11px] text-caption text-on-primary transition-transform active:scale-[0.95]"
        title="下一版提供"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 2v10M2 7h10" stroke="#ffffff" stroke-width="2" stroke-linecap="round" />
        </svg>
        新建班级
      </button>
    </header>

    <!-- 内容 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-20 py-10">
      <h1 class="text-display font-semibold text-ink">班级管理</h1>
      <p class="mt-2 text-caption text-weak">
        {{ groups.length }} 个班级 · {{ totalStudents }} 名学生
      </p>

      <!-- 班级卡片 -->
      <div v-if="groups.length" class="mt-7 flex flex-wrap gap-6">
        <RouterLink
          v-for="g in groups"
          :key="g.name"
          to="/students"
          class="flex w-[410px] flex-col gap-5 rounded-lg border border-hairline bg-canvas p-7 transition-all hover:bg-pearl active:scale-[0.95]"
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
              <p class="truncate text-tagline font-semibold -tracking-[0.3px] text-ink">
                {{ g.name }}
              </p>
              <p class="mt-0.5 text-caption text-weak">{{ g.students }} 名学生</p>
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
            <span class="text-caption text-weak">图片记录 {{ g.photos }} 条</span>
            <span class="text-caption text-weak">进入查看</span>
          </div>
        </RouterLink>
      </div>

      <p v-else class="mt-10 text-caption text-weak">
        还没有学生记录 —— 先到「学生档案」里建第一条学生，班级会自动归组。
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
  </div>
</template>
