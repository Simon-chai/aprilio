<script setup lang="ts">
import type { Photo } from "../types";
import { photoUrl } from "../lib/photos";
import { formatDate } from "../lib/format";

const props = withDefaults(
  defineProps<{ photos: Photo[]; dir?: string; canAdd?: boolean }>(),
  { dir: "", canAdd: false }
);

const emit = defineEmits<{ add: []; remove: [photo: Photo] }>();
</script>

<template>
  <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))">
    <figure v-for="photo in props.photos" :key="photo.id" class="group space-y-2">
      <div class="relative h-[132px] overflow-hidden rounded-sm bg-parchment">
        <img
          v-if="photoUrl(props.dir, photo.file_name)"
          :src="photoUrl(props.dir, photo.file_name)"
          :alt="photo.caption ?? ''"
          class="h-full w-full object-cover"
        />
        <div v-else class="flex h-full items-center justify-center text-fine text-weak">
          示例图片
        </div>

        <button
          v-if="props.canAdd"
          class="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-canvas/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          title="删除这张图片"
          @click="emit('remove', photo)"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2.5 4h9M5.5 4V2.8h3V4M3.6 4l.5 7.2h5.8L10.4 4M6 6v3.4M8 6v3.4"
              stroke="#d70015"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <figcaption class="truncate text-fine text-weak">
        {{ photo.caption || "未命名" }}
        <span v-if="photo.taken_at"> · {{ formatDate(photo.taken_at) }}</span>
      </figcaption>
    </figure>

    <!-- 添加图片 -->
    <button
      v-if="props.canAdd"
      class="flex h-[132px] flex-col items-center justify-center gap-1.5 rounded-sm border border-dashed border-hairline bg-pearl text-primary transition-colors hover:bg-parchment"
      @click="emit('add')"
    >
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 4.5V15.5M4.5 10H15.5" stroke="#0066cc" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <span class="text-fine">添加图片</span>
    </button>
  </div>
</template>
