<script setup lang="ts">
import { onMounted, ref } from "vue";
import { listPhotos, listStudents } from "../lib/db";
import { getPhotosDir, photoUrl } from "../lib/photos";
import EmptyState from "../components/ui/EmptyState.vue";
import type { Photo, StudentRow } from "../types";

const photos = ref<Photo[]>([]);
const students = ref<StudentRow[]>([]);
const photosDir = ref("");
const loading = ref(true);

const studentName = (id: number | null) =>
  id != null ? students.value.find((s) => s.id === id)?.name ?? `学生 #${id}` : "班级照片";

onMounted(async () => {
  photosDir.value = await getPhotosDir();
  photos.value = await listPhotos();
  students.value = await listStudents();
  loading.value = false;
});
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">图片记录</h1>
    <span class="text-caption text-weak">共 {{ photos.length }} 张</span>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
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
        <div class="h-[160px] overflow-hidden bg-parchment">
          <img
            v-if="photoUrl(photosDir, photo.file_name)"
            class="h-full w-full object-cover"
            :src="photoUrl(photosDir, photo.file_name)"
            :alt="photo.caption ?? ''"
          />
          <div v-else class="flex h-full items-center justify-center text-fine text-weak">
            示例图片
          </div>
        </div>
        <figcaption class="space-y-0.5 p-3">
          <p class="text-caption font-semibold text-ink">{{ studentName(photo.student_id) }}</p>
          <p class="text-fine text-weak">{{ photo.caption || "未命名" }}</p>
        </figcaption>
      </figure>
    </div>

    <EmptyState
      v-else-if="!loading"
      title="还没有任何图片"
      description="打开某个学生的档案，点「添加图片」就能从本地导入。"
    />
  </div>
</template>
