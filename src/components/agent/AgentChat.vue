<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAgent } from "../../composables/useAgent";
import { renderMarkdown } from "../../lib/markdown";
import ToolCallCard from "./ToolCallCard.vue";

/**
 * AI 助手全局悬浮窗（自主 Agent 入口）。
 *
 * 由 App.vue 全局挂载，任何页面都能唤起；通过自然语言即可
 * 跳转界面、查数据、翻文档。视觉沿用深色毛玻璃语言。
 *
 * 界面分两段、支持两阶段折叠：
 * - 没开始聊天（无消息）→ 消息区不渲染，天然只剩输入条；
 * - 阶段一：标题栏 ⌄ 收起消息区，输入条上方留「⌃ 对话 · N 条」手柄；
 * - 阶段二：输入条左侧 ⇓ 整窗收成小圆钮（角标显示消息条数，对话保留）。
 */
const open = ref(true);
const logOpen = ref(true);
const draft = ref("");
const { items, sending, error, aiReady, canSend, send, clear } = useAgent();
const logEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

/** 是否已有对话内容：决定消息区要不要出现 */
const hasConversation = computed(() => items.value.length > 0);

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
  // 用户正在发起对话 → 自动亮出消息区，保证回复可见
  logOpen.value = true;
  await send(text);
  await scrollLog();
  nextTick(() => inputEl.value?.focus());
}

/** 阶段一：只收起消息区，输入条保留 */
function collapseLog() {
  logOpen.value = false;
  nextTick(() => inputEl.value?.focus());
}

/** 从阶段一恢复：重新展开消息区并贴底 */
async function expandLog() {
  logOpen.value = true;
  await scrollLog();
}

/** 阶段二：整窗收成小圆钮，对话保留 */
function collapseAll() {
  open.value = false;
}

/** 从小圆钮恢复：有对话回到完整展开，否则回到纯输入条 */
async function restore() {
  open.value = true;
  logOpen.value = hasConversation.value;
  if (logOpen.value) await scrollLog();
  nextTick(() => inputEl.value?.focus());
}
</script>

<template>
  <!-- 悬浮窗主体：消息区（仅有对话时渲染）+ 输入条，间距由各段自身 margin 控制 -->
  <Transition name="dock-rise">
    <div
      v-if="open"
      class="fixed bottom-5 right-5 z-40 flex w-[min(360px,42vw)] flex-col items-stretch"
    >
      <section
        v-if="hasConversation"
        id="agent-log"
        class="glass-dark select-text overflow-hidden rounded-md transition-[max-height,opacity,margin-bottom] duration-300 ease-out"
        :class="
          logOpen
            ? 'mb-2 max-h-[26rem] opacity-100'
            : 'pointer-events-none mb-0 max-h-0 opacity-0'
        "
        :inert="!logOpen"
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
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center rounded-sm text-white/45 transition-colors hover:bg-white/10 hover:text-white/90"
            :aria-expanded="logOpen"
            aria-controls="agent-log"
            title="收起消息区，只留输入条"
            aria-label="收起消息区"
            @click="collapseLog"
          >
            <!-- 单层人字形：只收一层（消息区） -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 9l6 6 6-6"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
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
              <!-- 用户消息保持纯文本(输入不该被 md 改写);助手回复按 markdown 消毒后渲染 -->
              <p
                v-if="item.kind === 'user'"
                class="max-w-[85%] select-text whitespace-pre-wrap break-words rounded-md bg-primary px-3 py-1.5 text-[13px] leading-relaxed text-white"
              >
                {{ item.text }}
              </p>
              <div
                v-else
                class="md-body max-w-[85%] select-text break-words rounded-md bg-white/15 px-3 py-1.5 text-[13px] leading-relaxed text-white/90"
              >
                <span v-if="item.text" v-html="renderMarkdown(item.text)" />
                <span v-else class="typing-dots text-white/55">正在思考</span>
              </div>
            </div>
          </template>

          <p v-if="sending" class="typing-dots text-[12px] text-white/45">助手正在执行</p>
        </div>
      </section>

      <!-- 阶段一恢复手柄：消息区收起后留在输入条上方，一眼可知对话还能向上展开 -->
      <Transition name="dock-rise">
        <button
          v-if="hasConversation && !logOpen"
          type="button"
          class="glass-dark group mx-auto mb-1 flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] leading-none text-white/70 transition-colors hover:text-white"
          title="展开对话记录"
          aria-label="展开对话记录"
          aria-controls="agent-log"
          @click="expandLog"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            class="transition-transform group-hover:-translate-y-px"
          >
            <path
              d="M6 15l6-6 6 6"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          对话 · {{ items.length }} 条
        </button>
      </Transition>

      <p v-if="error" class="mb-2 px-1 text-center text-fine text-danger" role="alert">{{ error }}</p>

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
          @click="collapseAll"
        >
          <!-- 双层人字形：全部收起（连输入条一起，收成小圆钮） -->
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 7l6 6 6-6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              d="M6 13l6 6 6-6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
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

  <!-- 收起态（阶段二）：只留一个小圆钮；有对话时角标提示条数，点一下即恢复 -->
  <Transition name="dock-rise">
    <button
      v-if="!open"
      type="button"
      class="glass-dark fixed bottom-5 right-5 z-40 flex h-10 w-10 items-center justify-center rounded-md text-white transition-transform hover:scale-[1.05] active:scale-[0.94]"
      title="展开 AI 助手"
      aria-label="展开 AI 助手"
      @click="restore"
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
      <span
        v-if="items.length > 0"
        class="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-white"
      >
        {{ items.length > 99 ? "99+" : items.length }}
      </span>
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

/* 助手气泡内的 markdown 排版。v-html 注入的节点没有 scoped 属性，须走 :deep()；
   深色玻璃底上统一白色系；间距用「相邻兄弟」模型：块级 margin 先清零，
   只有相邻块之间留呼吸，首尾贴齐气泡内边距 */
.md-body :deep(*) {
  margin: 0;
}
.md-body :deep(* + *) {
  margin-top: 0.45em;
}
.md-body :deep(li + li) {
  margin-top: 0.2em;
}
.md-body :deep(h1),
.md-body :deep(h2) {
  font-size: 14px;
}
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  font-size: 13px;
}
.md-body :deep(strong) {
  color: rgb(255 255 255 / 0.95);
}
.md-body :deep(a) {
  color: var(--color-primary-on-dark);
  text-underline-offset: 2px;
}
.md-body :deep(ul) {
  padding-left: 1.25em;
  list-style: disc;
}
.md-body :deep(ol) {
  padding-left: 1.35em;
  list-style: decimal;
}
.md-body :deep(blockquote) {
  padding-left: 0.7em;
  border-left: 2px solid rgb(255 255 255 / 0.25);
  color: rgb(255 255 255 / 0.68);
}
.md-body :deep(code) {
  padding: 0.08em 0.35em;
  border-radius: 4px;
  background: rgb(255 255 255 / 0.12);
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
  font-size: 12px;
}
.md-body :deep(pre) {
  padding: 8px 10px;
  border: 1px solid rgb(255 255 255 / 0.1);
  border-radius: 8px;
  background: rgb(0 0 0 / 0.25);
  overflow-x: auto;
}
.md-body :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 12px;
  line-height: 1.55;
}
.md-body :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
}
.md-body :deep(th),
.md-body :deep(td) {
  padding: 2px 8px;
  border: 1px solid rgb(255 255 255 / 0.16);
}
.md-body :deep(th) {
  background: rgb(255 255 255 / 0.08);
}
.md-body :deep(hr) {
  border: 0;
  border-top: 1px solid rgb(255 255 255 / 0.14);
}
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 8px;
}
</style>
