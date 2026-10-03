<script setup lang="ts">
/**
 * 「AI 润色」通用按钮：挂在人工文本输入旁，一键把已输入的文字交给模型按场景润色。
 *
 * 复用方式（以后新增人工输入 / 语音输入，照此挂一行即可获得润色能力）：
 *   <AiPolishButton :text="form.comment" scene="作业备注"
 *                  hint="记在学生作业记录里的简短备注" :context="…" :max-len="200"
 *                  @apply="form.comment = $event" />
 *
 * 职责边界：本组件只负责「取当前文本 → 调 lib/polish-ai → apply 事件抛回 + toast 反馈」，
 * 不认识任何具体业务；场景与上下文全部由挂载点通过 props 提供。发给模型的 system
 * 提示词统一走提示词模块 content.text-polish（可在「提示词管理」页调整）。
 *
 * 视觉沿用 AI 生成内容的标识色（ai / ai-soft / ai-line，见 docs/DESIGN_SYSTEM.md），
 * 与快捷记表现的「✨ AI」推荐气泡同一语言；未配置 AI 时置灰，悬浮说明原因。
 */
import { computed, ref } from "vue";
import { isAiPolishReady, polishText } from "../../lib/polish-ai";
import { useToast } from "../../composables/useToast";

const props = withDefaults(
  defineProps<{
    /** 当前输入框文本：为空（纯空白）时置灰——没有内容就没有润色对象 */
    text: string;
    /** 使用场景名（必填），如「作业备注」，会原样告知模型 */
    scene: string;
    /** 场景补充说明：这段文字写给谁看、用来做什么 */
    hint?: string;
    /** 本次输入相关的业务信息（学生姓名 / 科目等），只作背景参考 */
    context?: string;
    /** 输入框字数上限：润色结果按此截断（不传则不截断） */
    maxLen?: number;
    /** sm：紧凑行内（如课表格子的速记弹层）；默认 md */
    size?: "sm" | "md";
  }>(),
  { size: "md" }
);

const emit = defineEmits<{ apply: [value: string] }>();

const toast = useToast();
const busy = ref(false);
/**
 * AI 是否可用（桌面端且已配置模型）：与其它 AI 入口同一判断。
 * 探测失败一律视为不可用——挂载点可能处于 db 被局部替换的环境（单测），
 * 润色入口的可用性探测不能反向阻塞表单本身。
 */
const ready = computed(() => {
  try {
    return isAiPolishReady();
  } catch {
    return false;
  }
});

const disabled = computed(() => busy.value || !ready.value || !props.text.trim());

const sizeCls = computed(() =>
  props.size === "sm" ? "h-6 gap-0.5 px-2 text-[11px]" : "h-7 gap-1 px-2.5 text-fine",
);

async function onPolish() {
  if (disabled.value) return;
  busy.value = true;
  try {
    const polished = await polishText(
      { scene: props.scene, hint: props.hint, context: props.context, text: props.text },
      { maxLen: props.maxLen },
    );
    emit("apply", polished);
    toast("已润色，可继续编辑");
  } catch (e) {
    // 失败原文不动，报错走全局轻反馈唯一模式
    toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    data-test="ai-polish-btn"
    :disabled="disabled"
    :aria-label="ready ? `AI 润色${scene ? `（${scene}）` : ''}` : '未配置 AI，暂不可润色'"
    class="group/polish relative inline-flex shrink-0 items-center rounded-pill border border-ai-line bg-ai-soft font-medium text-ai"
    :class="[sizeCls, disabled ? 'cursor-not-allowed opacity-40' : 'transition-colors duration-150 hover:bg-ai-hover active:scale-[0.95]']"
    @click="onPolish"
  >
    <span v-if="busy" class="typing-dots">润色中</span>
    <template v-else>✨ AI 润色</template>
    <!-- 未配置 AI 时的悬浮说明：自绘保证 WebView 可见（disabled 不再屏蔽 hover） -->
    <span
      v-if="!ready"
      role="tooltip"
      class="pointer-events-none absolute -top-1.5 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm bg-tile px-2.5 py-1 text-fine text-white opacity-0 shadow-md transition-opacity duration-150 group-hover/polish:opacity-100 group-focus-visible/polish:opacity-100"
    >
      未配置 AI，暂不可润色
    </span>
  </button>
</template>
