<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppIconButton from "./ui/AppIconButton.vue";
import ImageCropDialog from "./ImageCropDialog.vue";
import {
  backgroundSrc,
  ensureBackgroundLibrary,
  importUrlBackground,
  loadCropSource,
  markBackgroundUsed,
  pickerBackgrounds,
  removeBackground,
  saveCroppedBackground,
  type CropSourceInput,
} from "../lib/backgrounds";
import {
  clearProfileImageRefs,
  discardSelectedProfileImage,
  selectProfileImage,
} from "../lib/profile";
import { pickLocalFile } from "../lib/image";
import { isTauri } from "../lib/db";
import type { BackgroundImage, BackgroundKind, BackgroundSource } from "../types";

/**
 * 背景图选择器：本地上传 / 粘贴图片链接 / 从历史里切换。
 * 三类背景（头像、首页大图、课表背景）共用同一个入口，网络图片先下载到本地缓存再入库。
 *
 * 开启 crop 时（课表背景），本地上传与链接都先进入裁剪窗：
 * 窗口固定 16:9、移动的是图片，窗口内所见即最终背景，确认后才落盘入库。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    kind: BackgroundKind;
    /** 当前生效的缓存标识（高亮用） */
    current?: string;
    /** 保存前先进裁剪窗（课表背景用；与各课表表面的 16:9 比例一致） */
    crop?: boolean;
  }>(),
  { current: "", crop: false },
);

const emit = defineEmits<{
  close: [];
  /** file = 缓存标识；fresh = 本次新上传/新下载（未保存离开时要清理，历史图不用） */
  select: [file: string, fresh: boolean];
  clear: [];
  /** 正在上传/下载：父页面据此禁用控件并拦截离开 */
  busy: [value: boolean];
}>();

const url = ref("");
const urlInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref("");

/* ---- 裁剪窗状态 ---- */
const cropOpen = ref(false);
const cropSrc = ref("");
let cropMeta: { source: BackgroundSource; originUrl?: string; name?: string } | null = null;

watch(busy, (value) => emit("busy", value));

/** 弹窗被卸载时（如用户直接离开页面），还没落地的选图要自己清掉 */
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});

const TITLES: Record<BackgroundKind, string> = {
  avatar: "头像",
  hero: "首页大图",
  timetable_bg: "课表背景图",
};

const title = computed(() => TITLES[props.kind]);
const items = computed<BackgroundImage[]>(() => pickerBackgrounds(props.kind));
/** 首页大图与课表背景共享一套图库，头像独立（提示文案只在该场景展示） */
const sharedPool = computed(() => props.kind !== "avatar");

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) return;
    url.value = "";
    error.value = "";
    void ensureBackgroundLibrary();
    // 焦点落在链接输入框：想直接用网络图片时打开即可粘贴
    await nextTick();
    urlInput.value?.focus();
  },
);

function messageOf(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

/** 裁剪确认：dataURL 写盘 / 入库 → 采用 */
async function adoptCropped(dataUrl: string): Promise<void> {
  const item = await saveCroppedBackground(props.kind, dataUrl, {
    source: cropMeta?.source ?? "local",
    originUrl: cropMeta?.originUrl,
    name: cropMeta?.name,
  });
  if (disposed) {
    await discardSelectedProfileImage(item.file).catch(() => undefined);
    return;
  }
  markBackgroundUsed(props.kind, item.file);
  emit("select", item.file, true);
  emit("close");
}

/** 本地上传：课表背景先进裁剪窗，其余选完即入库 */
async function pickLocal() {
  if (busy.value) return;
  error.value = "";
  busy.value = true;
  try {
    if (props.crop) {
      const input = isTauri()
        ? await pickLocalPath()
        : await pickLocalFileInput();
      if (!input) return;
      const { src, name } = await loadCropSource(input);
      cropMeta = { source: "local", name };
      cropSrc.value = src;
      cropOpen.value = true;
      return;
    }

    const selected = await selectProfileImage(props.kind);
    if (!selected) return;
    if (disposed) {
      // 页面已经离开：这张图没被采用，直接清理
      await discardSelectedProfileImage(selected.value).catch(() => undefined);
      return;
    }
    markBackgroundUsed(props.kind, selected.value);
    emit("select", selected.value, true);
    emit("close");
  } catch (cause) {
    error.value = messageOf(cause, "图片选择失败，请重试。");
  } finally {
    busy.value = false;
  }
}

/** 网络链接：课表背景下载原图先进裁剪窗，其余直接缓存入库 */
async function addFromUrl() {
  if (busy.value) return;
  const target = url.value.trim();
  if (!target) {
    error.value = "请先粘贴图片链接";
    return;
  }
  error.value = "";
  busy.value = true;
  try {
    if (props.crop) {
      if (!/^https?:\/\/\S+$/i.test(target)) {
        throw new Error("请填写 http/https 开头的图片链接");
      }
      const { src, name } = await loadCropSource({ type: "url", url: target });
      cropMeta = { source: "url", originUrl: target, name };
      cropSrc.value = src;
      cropOpen.value = true;
      url.value = "";
      return;
    }

    const item = await importUrlBackground(props.kind, target);
    if (disposed) {
      await discardSelectedProfileImage(item.file).catch(() => undefined);
      return;
    }
    markBackgroundUsed(props.kind, item.file);
    url.value = "";
    emit("select", item.file, true);
    emit("close");
  } catch (cause) {
    error.value = messageOf(cause, "图片加载失败，请检查链接后重试。");
  } finally {
    busy.value = false;
  }
}

async function onCropConfirm(dataUrl: string): Promise<void> {
  cropOpen.value = false;
  error.value = "";
  busy.value = true;
  try {
    await adoptCropped(dataUrl);
  } catch (cause) {
    if (!disposed) error.value = messageOf(cause, "图片保存失败，请重试。");
  } finally {
    busy.value = false;
    cropMeta = null;
    cropSrc.value = "";
  }
}

function onCropCancel(): void {
  cropOpen.value = false;
  cropMeta = null;
  cropSrc.value = "";
}

/** 桌面端：系统选择框 → 返回本地路径（字节流在 loadCropSource 里读） */
async function pickLocalPath(): Promise<CropSourceInput | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return { type: "local", path: selected };
}

/** 浏览器演示态：file input → File */
async function pickLocalFileInput(): Promise<CropSourceInput | null> {
  const picked = await pickLocalFile();
  return picked ? { type: "file", file: picked.file } : null;
}


/** 从历史里切一张 */
function useItem(item: BackgroundImage) {
  markBackgroundUsed(props.kind, item.file);
  emit("select", item.file, false);
  emit("close");
}

async function dropItem(item: BackgroundImage) {
  if (busy.value) return;
  busy.value = true;
  try {
    await removeBackground(item.id);
    // 共享池里一张图可能正被首页大图 / 课表背景引用，删除时一并清掉引用
    await clearProfileImageRefs(item.file);
    if (props.current && props.current === item.file) emit("clear");
  } catch (cause) {
    error.value = messageOf(cause, "删除失败，请重试。");
  } finally {
    busy.value = false;
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function labelOf(item: BackgroundImage): string {
  return item.name || (item.source === "url" ? "网络图片" : "本地上传");
}
</script>

<template>
  <div
    v-if="open"
    data-test="bg-picker"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @mousedown.self="emit('close')"
  >
    <div class="max-h-full w-[520px] max-w-full overflow-y-auto scroll-thin rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-5 flex items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">{{ title }} · 图片库</h2>
        <button
          type="button"
          class="inline-flex items-center text-caption text-weak hover:text-ink"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-3">
          <AppIconButton
            data-test="bg-picker-local"
            label="本地上传"
            :disabled="busy"
            @click="pickLocal"
          >
            <!-- 语义图标：上传托盘，与「导入花名册」同一套图标 -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 8l5-5 5 5" />
              <path d="M12 3v12" />
            </svg>
          </AppIconButton>
          <p class="text-fine text-weak">
            {{ crop ? "支持 png / jpg / webp / gif / bmp · 上传后可裁剪取景" : "支持 png / jpg / webp / gif / bmp" }}
          </p>
        </div>

        <div>
          <p class="mb-1.5 text-fine text-weak">
            {{ crop ? "粘贴图片链接（下载后可裁剪取景）" : "粘贴图片链接（自动下载到本地缓存）" }}
          </p>
          <div class="flex items-center gap-2">
            <input
              ref="urlInput"
              v-model="url"
              data-test="bg-picker-url"
              type="url"
              inputmode="url"
              placeholder="https://example.com/photo.jpg"
              :disabled="busy"
              class="h-9 flex-1 rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              @keydown.enter.prevent="addFromUrl"
            />
            <AppButton
              data-test="bg-picker-add"
              variant="primary"
              :disabled="busy"
              @click="addFromUrl"
            >
              {{ busy ? "加载中" : "添加" }}
            </AppButton>
          </div>
        </div>

        <p
          v-if="error"
          data-test="bg-picker-error"
          role="alert"
          class="text-caption text-danger"
        >
          {{ error }}
        </p>

        <div class="border-t border-divider pt-4">
          <div class="mb-2 flex items-center justify-between">
            <p class="text-caption font-semibold text-ink">历史图片</p>
            <button
              v-if="current"
              data-test="bg-picker-clear"
              type="button"
              class="text-fine text-weak underline-offset-2 hover:text-danger hover:underline"
              @click="emit('clear'); emit('close')"
            >
              移除当前背景
            </button>
          </div>

          <p v-if="sharedPool" class="mb-2 text-fine text-weak">
            首页大图与课表背景共用这套图片库（头像独立）。
          </p>

          <p v-if="!items.length" class="py-4 text-fine text-weak">
            还没有历史图片，上传或添加一个链接后即可随时切换。
          </p>

          <div v-else class="grid grid-cols-4 gap-2">
            <div v-for="item in items" :key="item.id" class="group relative">
              <button
                type="button"
                data-test="bg-picker-item"
                class="block h-16 w-full overflow-hidden rounded-sm border bg-pearl bg-cover bg-center transition-colors"
                :class="
                  current === item.file
                    ? 'border-primary ring-1 ring-primary'
                    : 'border-hairline hover:border-ink'
                "
                :style="{ backgroundImage: backgroundSrc(item) ? `url(${backgroundSrc(item)})` : undefined }"
                :title="`${labelOf(item)} · ${shortTime(item.added_at)}`"
                @click="useItem(item)"
              >
                <span
                  v-if="item.source === 'url'"
                  class="absolute left-1 top-1 rounded-pill bg-black/55 px-1.5 text-[10px] leading-4 text-white"
                >
                  网络
                </span>
              </button>
              <button
                type="button"
                data-test="bg-picker-remove"
                class="absolute right-1 top-1 hidden h-4 w-4 items-center justify-center rounded-pill bg-black/55 text-white group-hover:flex"
                :aria-label="`删除 ${labelOf(item)}`"
                @click="dropItem(item)"
              >
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </button>
              <p class="mt-1 truncate text-[10px] text-weak">{{ labelOf(item) }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 裁剪窗：窗口固定 16:9，移动的是图片，确认后才落盘入库 -->
    <ImageCropDialog
      :open="cropOpen"
      :src="cropSrc"
      :title="`${title} · 裁剪取景`"
      @confirm="onCropConfirm"
      @cancel="onCropCancel"
    />
  </div>
</template>
