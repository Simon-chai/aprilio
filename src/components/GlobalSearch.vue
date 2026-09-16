<script setup lang="ts">
/**
 * Ctrl+F 全局搜索浮层：命令面板式跨实体搜索（学生 / 班级 / 考试 / 照片 / 日程备忘）。
 *
 * - Ctrl/Cmd+F 开 / 关（覆盖浏览器自带查找），Esc 关闭并清空
 * - 输入 200ms 防抖 + 递增 token 丢弃过期响应（同 ClassDetailView 模式）
 * - ↑↓ 循环选择、Enter 或点击跳转，跳转后自动关闭
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppInput from "./ui/AppInput.vue";
import {
  searchGlobal,
  type GlobalSearchGroup,
  type GlobalSearchResult,
} from "../lib/global-search";

/** 防抖时长：与班内学生搜索保持一致 */
const DEBOUNCE_MS = 200;

/** 各实体内联图标（stroke 走 currentColor，统一 1.5 线宽） */
const ICON_PATHS: Record<string, string> = {
  student: "M8 7.4a2.7 2.7 0 100-5.4 2.7 2.7 0 000 5.4zM2.8 13.6c0-2.3 2.3-3.9 5.2-3.9s5.2 1.6 5.2 3.9",
  class: "M2.6 3.6h4.5a1.7 1.7 0 011.7 1.7v7.1H4.3a1.7 1.7 0 01-1.7-1.7zM13.4 3.6H8.8v8.8h4.6z",
  exam: "M5.6 2.6h4.8M4.4 3.6h7.2a1 1 0 011 1v8.8a1 1 0 01-1 1H4.4a1 1 0 01-1-1V4.6a1 1 0 011-1zM6 7.6h4M6 10.1h2.6",
  photo: "M2.6 4.2h10.8v7.6H2.6zM2.6 9.9l3.2-2.6 2.6 2 2.4-1.9 3.2 2.5",
  memo: "M3.4 4.6h9.2v8.8H3.4zM3.4 7.4h9.2M6 2.8v2M10 2.8v2",
};

const router = useRouter();

const open = ref(false);
const keyword = ref("");
const groups = ref<GlobalSearchGroup[]>([]);
const searching = ref(false);
const activeIndex = ref(0);

const inputRef = ref<InstanceType<typeof AppInput> | null>(null);
const listRef = ref<HTMLElement | null>(null);

/** 扁平化结果：键盘导航在同一序列里上下移动 */
const flatResults = computed<GlobalSearchResult[]>(() => groups.value.flatMap((g) => g.results));

/** 结果 → 扁平序号（模板判高亮与悬浮定位用） */
const flatIndexMap = computed(() => {
  const map = new Map<GlobalSearchResult, number>();
  flatResults.value.forEach((r, i) => map.set(r, i));
  return map;
});

function isActive(result: GlobalSearchResult): boolean {
  return flatIndexMap.value.get(result) === activeIndex.value;
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** 请求序号：丢弃防抖等待期间已过期的响应 */
let requestToken = 0;

async function runSearch(kw: string) {
  const token = ++requestToken;
  if (!kw.trim()) {
    groups.value = [];
    searching.value = false;
    return;
  }
  searching.value = true;
  try {
    const result = await searchGlobal(kw);
    if (token !== requestToken) return;
    groups.value = result;
  } catch {
    if (token !== requestToken) return;
    groups.value = [];
  } finally {
    if (token === requestToken) searching.value = false;
  }
}

watch(keyword, (kw) => {
  activeIndex.value = 0;
  clearTimeout(timer);
  timer = setTimeout(() => void runSearch(kw), DEBOUNCE_MS);
});

async function show() {
  open.value = true;
  await nextTick();
  inputRef.value?.focus();
}

function close() {
  open.value = false;
  clearTimeout(timer);
  requestToken++;
  keyword.value = "";
  groups.value = [];
  activeIndex.value = 0;
}

async function go(result: GlobalSearchResult) {
  await router.push(result.route);
  close();
}

/* ---------------- 快捷键 ---------------- */

function onDocKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault(); // 覆盖浏览器自带查找
    if (open.value) close();
    else void show();
    return;
  }
  if (e.key === "Escape" && open.value) close();
}

function scrollActiveIntoView() {
  const el = listRef.value?.querySelector<HTMLElement>('[data-active="true"]');
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
}

function onInputKeydown(e: KeyboardEvent) {
  const total = flatResults.value.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!total) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + step + total) % total;
    void nextTick(() => scrollActiveIntoView());
    return;
  }
  if (e.key === "Enter") {
    const target = flatResults.value[activeIndex.value];
    if (!target) return;
    e.preventDefault();
    void go(target);
  }
}

onMounted(() => document.addEventListener("keydown", onDocKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onDocKeydown));
</script>

<template>
  <div
    v-if="open"
    data-test="global-search"
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-8"
    @click.self="close"
  >
    <div class="w-[560px] max-w-full overflow-hidden rounded-lg bg-canvas shadow-window">
      <!-- 搜索框：键盘导航事件从内层 input 冒泡到 AppInput 根节点 -->
      <div class="border-b border-divider px-4 py-3">
        <AppInput
          ref="inputRef"
          v-model="keyword"
          data-test="global-search-input"
          width="100%"
          placeholder="搜索学生、班级、考试、照片与备忘"
          @keydown="onInputKeydown"
        />
      </div>

      <div ref="listRef" class="scroll-thin max-h-80 overflow-y-auto py-2">
        <p v-if="!keyword.trim()" class="px-4 py-8 text-center text-caption text-weak">
          输入关键词搜索学生、班级、考试、照片与备忘
        </p>
        <p v-else-if="searching" class="px-4 py-8 text-center text-caption text-weak">搜索中…</p>
        <p v-else-if="!flatResults.length" class="px-4 py-8 text-center text-caption text-weak">
          未找到匹配结果
        </p>
        <template v-else>
          <section v-for="group in groups" :key="group.entity" data-test="global-search-group">
            <h3 class="px-4 pb-1 pt-2 text-fine text-faint">{{ group.label }}</h3>
            <ul>
              <li
                v-for="r in group.results"
                :key="`${r.entity}-${r.id}`"
                data-test="global-search-item"
                :data-active="isActive(r) ? 'true' : 'false'"
                class="flex cursor-pointer items-center gap-2.5 px-4 py-2 transition-colors"
                :class="isActive(r) ? 'bg-pearl' : ''"
                @click="go(r)"
                @mouseenter="activeIndex = flatIndexMap.get(r) ?? 0"
              >
                <svg
                  class="shrink-0 text-weak"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    :d="ICON_PATHS[r.entity]"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-caption text-ink">{{ r.title }}</span>
                  <span class="block truncate text-fine text-faint">{{ r.subtitle }}</span>
                </span>
              </li>
            </ul>
          </section>
        </template>
      </div>

      <footer class="border-t border-divider px-4 py-2 text-fine text-faint">
        ↑↓ 切换 · Enter 跳转 · Esc 关闭
      </footer>
    </div>
  </div>
</template>