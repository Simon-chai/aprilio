<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAgent } from "../../composables/useAgent";
import ToolCallCard from "./ToolCallCard.vue";

/**
 * AI 助手全局悬浮窗（自主 Agent 入口）。
 *
 * 由 App.vue 全局挂载，任何页面都能唤起；通过自然语言即可
 * 跳转界面、查数据、翻文档。视觉沿用深色毛玻璃语言。
 */
const open = ref(true);
const draft = ref("");
const { items, sending, error, aiReady, canSend, send, clear } = useAgent();
const logEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const placeholder = computed(() =>
  aiReady.value ? "让助手跳转页面、查数据、找文档…" : "先在「数据与设置」配置 AI 模型",
);

// 新消息 / 工具状态变化时贴底
watch(
  () => [items.value.length, sending.value],
  () => scrollLog(),
);

async function scrollLog() {
  await nextTick();
  const el = logEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function send2() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  draft.value = "";
  await send(text);
  await scrollLog();
  nextTick(() => inputEl.value?.focus());
}
</script>

<template>
  <!-- 展开态：消息展示区 + 输入条 -->
  <Transition name="dock-rise">
    <div
      v-if="open"
      class="fixed bottom-5 right-5 z-40 flex w-[min(360px,42vw)] flex-col items-stretch gap-2"
    >
      <section
        class="glass-dark select-text overflow-hidden rounded-md"
        aria-label="AI 助手对话记录"
      >
        <header class="flex items-center justify-between border-b border-white/10 px-3.5 py-1.5">
          <div class="flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="text-white/60">
              <path
                d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linejoin="round"
              />
              <path
                d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"
                fill="currentColor"
                opacity="0.55"
              />
            </svg>
            <span class="text-fine font-medium text-white/80">AI 助手</span>
            <span
              class="h-1.5 w-1.5 rounded-full"
              :class="aiReady ? 'bg-success' : 'bg-white/25'"
              :title="aiReady ? '模型已配置' : '模型未配置'"
            />
          </div>
          <button
            type="button"
            class="rounded-sm px-1 text-fine text-white/45 transition-colors hover:text-white/85"
            @click="clear"
          >
            清空
          </button>
        </header>

        <div
          ref="logEl"
          class="ai-log-scroll scroll-thin max-h-[min(44vh,380px)] space-y-2 overflow-y-auto px-3 py-2.5"
          role="log"
          aria-live="polite"
        >
          <template v-for="(item, i) in items" :key="i">
            <div v-if="item.kind === 'tool'" class="flex justify-start">
              <ToolCallCard :item="item" class="max-w-[92%]" />
            </div>
            <div
              v-else
              class="flex"
              :class="item.kind === 'user' ? 'justify-end' : 'justify-start'"
            >
              <p
                class="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-md px-3 py-1.5 text-[13px] leading-relaxed"
                :class="item.kind === 'user' ? 'bg-primary text-white' : 'bg-white/15 text-white/90'"
              >
                <template v-if="item.text">{{ item.text }}</template>
                <span v-else class="typing-dots text-white/55">正在思考</span>
              </p>
            </div>
          </template>

          <p v-if="sending" class="typing-dots text-[12px] text-white/45">助手正在执行</p>
        </div>
      </section>

      <p v-if="error" class="px-1 text-center text-fine text-danger" role="alert">{{ error }}</p>

      <!-- 输入条：常驻的输入入口 -->
      <form
        class="glass-dark flex h-10 items-center gap-1 rounded-md px-1.5 transition-colors focus-within:border-primary-on-dark"
        @submit.prevent="send2"
      >
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-white/65 transition-[background-color,color,transform] hover:bg-white/10 hover:text-white active:scale-[0.92]"
          title="收起 AI 助手（对话会保留）"
          aria-label="收起 AI 助手"
          @click="open = false"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
            <path
              d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"
              fill="currentColor"
              opacity="0.55"
            />
          </svg>
        </button>
        <input
          ref="inputEl"
          v-model="draft"
          class="select-text min-w-0 flex-1 bg-transparent text-[13px] text-white caret-white outline-none placeholder:text-white/45"
          :placeholder="placeholder"
          aria-label="AI 助手消息输入"
          spellcheck="false"
          autocomplete="off"
        />
        <button
          type="submit"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-primary-on-dark text-white transition-[background-color,transform,opacity] hover:brightness-110 active:scale-[0.92] disabled:pointer-events-none disabled:opacity-35"
          :disabled="!canSend || !draft.trim()"
          aria-label="发送"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 19V5m0 0l-6 6m6-6l6 6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </form>
    </div>
  </Transition>

  <!-- 收起态：只留一个小圆钮，随时可以再次展开 -->
  <Transition name="dock-rise">
    <button
      v-if="!open"
      type="button"
      class="glass-dark fixed bottom-5 right-5 z-40 flex h-10 w-10 items-center justify-center rounded-md text-white transition-transform hover:scale-[1.05] active:scale-[0.94]"
      title="展开 AI 助手"
      aria-label="展开 AI 助手"
      @click="open = true"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
        <path
          d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"
          fill="currentColor"
          opacity="0.55"
        />
      </svg>
    </button>
  </Transition>
</template>

<style scoped>
/* 悬浮窗展开 / 收起 / 消息区升起的入场动效，收尾都朝右下角 */
.dock-rise-enter-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.dock-rise-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.dock-rise-enter-from,
.dock-rise-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.985);
}

/* 玻璃面内的滚动条：深色底上用更淡的滑块，避免发丝线抢眼 */
.ai-log-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgb(255 255 255 / 0.28) transparent;
}
.ai-log-scroll::-webkit-scrollbar-thumb {
  background: rgb(255 255 255 / 0.28);
  border-radius: 9999px;
}
</style>
