<script setup lang="ts">
/**
 * 背景图裁剪窗（基于 cropperjs）：
 * 原图完整展示，选区外自动变暗 —— 选了什么、裁掉了什么一眼可见；
 * 选区可拖到图片任意位置（包括正中间），边角拉伸改变取景范围，比例锁定。
 *
 * 对外接口：open / src / title / aspect → confirm(dataUrl) / cancel。
 * 确认后导出固定宽度（1600px）的 JPEG dataURL，由调用方落盘 / 入库。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import { CROP_FILL_COLOR } from "../lib/image";
import AppButton from "./ui/AppButton.vue";
import AppDialog from "./ui/AppDialog.vue";
import AppIcon from "./ui/AppIcon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 原图 dataURL（裁剪输入，canvas 直接可读） */
    src: string;
    title?: string;
    /** 选区宽高比（w/h），课表背景统一 16:9 */
    aspect?: number;
  }>(),
  { title: "裁剪取景", aspect: 16 / 9 },
);

const emit = defineEmits<{
  confirm: [dataUrl: string];
  cancel: [];
}>();

/** 导出宽度（px）；高度按选区比例推导 */
const OUTPUT_WIDTH = 1600;

const stageEl = ref<HTMLElement | null>(null);
const imgEl = ref<HTMLImageElement | null>(null);
const ready = ref(false);
const failed = ref(false);
/** 确认失败原因（未就绪 / 导出失败），不再静默吞掉 */
const confirmError = ref("");

let cropper: Cropper | null = null;

function destroyCropper(): void {
  cropper?.destroy();
  cropper = null;
  ready.value = false;
  failed.value = false;
  confirmError.value = "";
}

/** 原图就绪后初始化：比例锁定 + viewMode 1（图片不超出画布，完整可见） */
function buildCropper(): void {
  destroyCropper();
  if (!imgEl.value || !props.src) return;
  // 双通道置 ready：options.ready 回调 + DOM ready 事件，任一先到即可
  const markReady = () => {
    ready.value = true;
  };
  imgEl.value.addEventListener("ready", markReady, { once: true });
  cropper = new Cropper(imgEl.value, {
    aspectRatio: props.aspect,
    viewMode: 1,
    dragMode: "move",
    autoCropArea: 0.9,
    background: false,
    responsive: true,
    ready: markReady,
  });
}

function onImgError(): void {
  failed.value = true;
}

function confirmCrop(): void {
  confirmError.value = "";
  if (!cropper || !ready.value) {
    confirmError.value = "图片还在加载，请等预览出现后再试。";
    return;
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = cropper.getCroppedCanvas({
      width: OUTPUT_WIDTH,
      imageSmoothingQuality: "high",
      fillColor: CROP_FILL_COLOR,
    });
  } catch (cause) {
    console.error("[crop] getCroppedCanvas failed", cause);
  }
  if (!canvas) {
    confirmError.value = "导出失败，请调整选区后重试。";
    return;
  }
  try {
    emit("confirm", canvas.toDataURL("image/jpeg", 0.9));
  } catch (cause) {
    console.error("[crop] toDataURL failed", cause);
    confirmError.value = "导出失败，请调整选区后重试。";
  }
}

function onCancel(): void {
  destroyCropper();
  emit("cancel");
}

/* 弹窗打开（或换了图）就重建裁剪器；关闭 / 卸载一律销毁。
   Esc / 遮罩点击由 AppDialog 壳承担：@close 走 onCancel 同一条取消路径 */
async function syncCropper(open: boolean, src: string): Promise<void> {
  if (open && src) {
    await nextTick();
    buildCropper();
  } else {
    destroyCropper();
  }
}

onMounted(() => {
  void syncCropper(props.open, props.src);
});

watch(
  () => [props.open, props.src] as const,
  ([open, src]) => {
    void syncCropper(open, src);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  destroyCropper();
});
</script>

<template>
  <!-- AppDialog 壳：遮罩 / Esc / 焦点圈定 / 过渡由壳承担；叠在背景选择器之上，z=60 抬高一层 -->
  <AppDialog
    :open="open"
    :title="title"
    width="lg"
    :z="60"
    data-test="crop-dialog"
    @close="onCancel"
  >
    <!-- 关闭 ✕：对齐面板右上角（原标题行「关闭」文字按钮统一为图标） -->
    <button
      type="button"
      class="absolute right-6 top-6 flex h-6 w-6 items-center justify-center rounded-sm text-weak transition-colors hover:bg-parchment hover:text-ink"
      aria-label="关闭"
      @click="onCancel"
    >
      <AppIcon name="close" :size="16" />
    </button>

    <div class="mt-4">
      <!-- cropper 舞台：图片完整可见，选区外变暗，选区可拖到任意位置 -->
      <div
        ref="stageEl"
        data-test="crop-stage"
        class="h-[min(58vh,540px)] w-full overflow-hidden rounded-sm bg-ink/80"
      >
        <img
          ref="imgEl"
          :src="src"
          alt="待裁剪图片"
          class="block max-w-none"
          draggable="false"
          @error="onImgError"
        />
      </div>

      <p v-if="failed" data-test="crop-error" role="alert" class="mt-3 text-caption text-danger">
        图片加载失败，请换一张或重新上传。
      </p>
      <p
        v-else-if="confirmError"
        data-test="crop-confirm-error"
        role="alert"
        class="mt-3 text-caption text-danger"
      >
        {{ confirmError }}
      </p>

      <div class="mt-3 flex items-center justify-between gap-3">
        <p class="text-fine text-weak">
          拖动选框选位置（可放图片正中）· 边角拉伸调大小 · 滚轮缩放图片 · 比例已锁定
        </p>
        <div class="flex shrink-0 justify-end gap-3">
          <AppButton variant="pearl" data-test="crop-cancel" @click="onCancel">取消</AppButton>
          <AppButton
            variant="primary"
            data-test="crop-confirm"
            :disabled="!ready || failed"
            @click="confirmCrop"
          >
            使用这一帧
          </AppButton>
        </div>
      </div>
    </div>
  </AppDialog>
</template>
