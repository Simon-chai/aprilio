<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  aiConfigVersion,
  aiProviderById,
  isAiConfigured,
  loadAiProfiles,
  setActiveAiProfile,
  type AiProfile,
} from "../../lib/ai";

/**
 * 模型快捷切换胶囊：显示当前使用的模型方案，点开下拉即一键切换。
 *
 * 与设置页方案列表共用同一份存储（lib/ai 的方案集），切换即时生效：
 * 正在进行的请求仍用原配置完成，下一条消息起走新方案。
 *
 * - tone="light"：设置页卡片头里的浅色皮肤（渐变描边胶囊）
 * - tone="dark"：AI 助手深色玻璃窗里的皮肤
 * - compact：窄空间（聊天头部）只展示模型 ID，不展示供应商名
 */
const props = withDefaults(
  defineProps<{
    tone?: "light" | "dark";
    compact?: boolean;
  }>(),
  { tone: "light", compact: false }
);

const emit = defineEmits<{ manage: [] }>();

const open = ref(false);
/** 切换被拦截时的行内提示（写在菜单底部，不弹全局 toast） */
const blockedMsg = ref("");

/* loadAiProfiles 读 localStorage 不具备响应性，靠 aiConfigVersion 版本号驱动刷新 */
const state = computed(() => {
  aiConfigVersion.value;
  return loadAiProfiles();
});
const profiles = computed(() => state.value.profiles);
const active = computed(
  () => profiles.value.find((p) => p.id === state.value.activeId) ?? profiles.value[0]
);
const activeReady = computed(() => (active.value ? isAiConfigured(active.value) : false));

const pillLabel = computed(() => {
  if (!active.value) return "";
  const provider = aiProviderById(active.value.provider)?.label ?? active.value.provider;
  return props.compact ? active.value.model : `${provider} · ${active.value.model}`;
});

function isProfileOn(p: AiProfile): boolean {
  return active.value?.id === p.id;
}

function onToggle() {
  blockedMsg.value = "";
  open.value = !open.value;
}

/** 一键切换；缺密钥的方案不放行，在菜单里给出补配置的指引 */
function onSwitch(profile: AiProfile) {
  blockedMsg.value = "";
  if (isProfileOn(profile)) {
    open.value = false;
    return;
  }
  if (!isAiConfigured(profile)) {
    blockedMsg.value = `「${profile.name || profile.model}」还没配置 API 密钥，先在设置里补上。`;
    return;
  }
  setActiveAiProfile(profile.id);
  open.value = false;
}

function onManage() {
  open.value = false;
  emit("manage");
}

function onDocClick(e: MouseEvent) {
  if (open.value && !rootEl.value?.contains(e.target as Node)) {
    open.value = false;
    blockedMsg.value = "";
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    open.value = false;
    blockedMsg.value = "";
  }
}

const rootEl = ref<HTMLElement | null>(null);
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});

const dark = computed(() => props.tone === "dark");
</script>

<template>
  <div v-if="active" ref="rootEl" class="menu-wrap relative">
    <!-- 当前模型胶囊：点开下拉直接切 -->
    <button
      type="button"
      class="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-pill transition-colors duration-150 active:scale-[0.97]"
      :class="
        dark
          ? 'border border-white/15 bg-white/10 px-2.5 py-1 text-[12px] text-white/90 hover:bg-white/15'
          : 'grad-border h-9 px-3.5 text-caption text-ink hover:shadow-[var(--shadow-halo)]'
      "
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-label="切换模型"
      data-test="ai-switcher"
      @click.stop="onToggle"
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :class="activeReady ? 'bg-success' : 'bg-danger'"
        :title="activeReady ? '当前模型已配置' : '当前模型未配置'"
      />
      <span class="min-w-0 truncate">{{ pillLabel }}</span>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        :class="dark ? 'text-white/50' : 'text-weak'"
      >
        <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- 方案下拉：当前项打勾，其余点击即切 -->
    <div
      v-if="open"
      class="menu-pop absolute right-0 top-full z-50 mt-1.5 min-w-[248px] rounded-md p-1.5"
      :class="dark ? 'glass-dark' : 'border border-hairline bg-canvas shadow-window'"
      role="menu"
      data-test="ai-switcher-menu"
    >
      <p class="px-2.5 pb-1 pt-0.5 text-fine" :class="dark ? 'text-white/50' : 'text-weak'">切换模型</p>
      <button
        v-for="p in profiles"
        :key="p.id"
        type="button"
        class="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-caption transition-colors duration-150"
        :class="dark ? 'text-white/85 hover:bg-white/10' : 'text-ink hover:bg-pearl'"
        role="menuitem"
        data-test="ai-switcher-item"
        @click.stop="onSwitch(p)"
      >
        <svg
          v-if="isProfileOn(p)"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          :class="dark ? 'text-primary-on-dark' : 'text-primary'"
        >
          <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-else class="w-[13px] shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ p.name || p.model }}</span>
        <span class="shrink-0 text-fine" :class="dark ? 'text-white/45' : 'text-faint'">{{ p.model }}</span>
      </button>

      <p
        v-if="blockedMsg"
        class="px-2.5 py-1.5 text-fine"
        :class="dark ? 'text-red-300' : 'text-danger'"
        role="alert"
      >
        {{ blockedMsg }}
      </p>

      <div class="my-1 h-px" :class="dark ? 'bg-white/10' : 'bg-divider'" />
      <button
        type="button"
        class="w-full rounded-sm px-2.5 py-1.5 text-left text-fine transition-colors duration-150"
        :class="dark ? 'text-primary-on-dark hover:bg-white/10' : 'text-primary hover:bg-pearl'"
        role="menuitem"
        data-test="ai-switcher-manage"
        @click.stop="onManage"
      >
        管理模型方案 →
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 下拉展开的轻入场：下移淡入，方向与展开位置一致 */
.menu-pop {
  animation: menu-pop 0.15s ease-out;
}
@keyframes menu-pop {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .menu-pop {
    animation: none;
  }
}
</style>
