<script setup lang="ts">
/**
 * 提示词管理：按分组浏览全部 AI 系统提示词，逐模块调整与恢复默认。
 *
 * 布局（方案 A · 顶部轨道）：模块导航压进页头下两条横带——
 * 分组 Tab（能量线选中态）+ 模块胶囊轨道（横向滚动应对模块增多），
 * 纵向空间尽量让给编辑区；「可用变量 / 预览」收进右侧信息卡的分段器，少一层卡片。
 *
 * 数据全部来自 src/prompts（扫描装载 + 本机覆盖值），本页不做任何业务判断：
 * 渲染、取值、校验（契约变量提示）都复用框架同一套函数，
 * 保证「页面上预览到的」与「运行期真正发出去的」不会两说。
 */
import { computed, nextTick, ref, watch } from "vue";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import AppInput from "../components/ui/AppInput.vue";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import {
  bucketPromptModules,
  effectivePromptText,
  loadPromptOverrides,
  missingContractVariables,
  promptPreview,
  promptVersion,
  resetAllPromptOverrides,
  resetPromptOverride,
  savePromptOverride,
  unknownPlaceholders,
  type PromptModule,
} from "../prompts";

const toast = useToast();

/**
 * 覆盖值快照：localStorage 读取不具备响应性，所有派生状态都必须经由这个 computed
 * 读取（它依赖 promptVersion）。若某处直接调 loadPromptOverrides()，
 * 该派生值不会随保存/恢复而重算——「保存后仍显示未保存」就是这么来的。
 */
const overrides = computed(() => {
  promptVersion.value;
  return loadPromptOverrides();
});

/* ---------------- 模块列表与选中项 ---------------- */

const buckets = computed(() => bucketPromptModules());
const modules = computed(() => buckets.value.flatMap((b) => b.modules));

/** 已自定义 id 集合 */
const customized = computed(() => new Set(Object.keys(overrides.value)));
const customCount = computed(() => customized.value.size);

const selectedId = ref<string>("");
const selected = computed<PromptModule | undefined>(
  () => modules.value.find((m) => m.id === selectedId.value) ?? modules.value[0],
);

// 首次进入默认选中第一个模块
watch(
  modules,
  (list) => {
    if (!selectedId.value && list.length) selectedId.value = list[0].id;
  },
  { immediate: true },
);

/* ---------------- 顶部导航（分组 Tab + 模块轨道 + 搜索） ---------------- */

/** 「全部」不是分组 taxonomy 的一员，只是胶囊轨道的一个过滤视图 */
const ALL_TAB_ID = "__all__";

/** 搜索词：非空时轨道跨分组展示全部匹配（分组 Tab 暂时让位） */
const query = ref("");

/** 当前分组 Tab；默认「全部」，保证全部模块在轨道上同时可见 */
const activeGroupId = ref<string>(ALL_TAB_ID);

/** 右侧信息卡分段：可用变量 / 预览（默认变量，点变量名即插入） */
const infoPane = ref<"vars" | "preview">("vars");

const groupTabs = computed(() => [
  { id: ALL_TAB_ID, label: "全部", count: modules.value.length },
  ...buckets.value.map((b) => ({ id: b.group.id, label: b.group.label, count: b.modules.length })),
]);

/** 轨道上的模块：选中分组的模块；搜索时跨分组取全部匹配 */
const railModules = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (q) return modules.value.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(q));
  if (activeGroupId.value === ALL_TAB_ID) return modules.value;
  return buckets.value.find((b) => b.group.id === activeGroupId.value)?.modules ?? [];
});

/** Tab 带右侧的当前分组说明（搜索中不展示） */
const activeGroupDesc = computed(() => {
  if (query.value.trim()) return "";
  if (activeGroupId.value === ALL_TAB_ID) return `共 ${modules.value.length} 个模块`;
  return buckets.value.find((b) => b.group.id === activeGroupId.value)?.group.description ?? "";
});

function selectGroup(id: string) {
  activeGroupId.value = id;
  query.value = "";
  if (id === ALL_TAB_ID) return;
  const list = buckets.value.find((b) => b.group.id === id)?.modules ?? [];
  // 切到具体分组时，若当前模块不在组内，落到该组第一个
  if (list.length && !list.some((m) => m.id === selectedId.value)) {
    selectedId.value = list[0].id;
  }
}

// 清空搜索后，若当前模块不属于选中分组，把 Tab 归位到它的分组，避免「编辑中的模块不在轨道上」
watch(query, (q) => {
  const mod = selected.value;
  if (q.trim() || activeGroupId.value === ALL_TAB_ID || !mod) return;
  const list = buckets.value.find((b) => b.group.id === activeGroupId.value)?.modules ?? [];
  if (!list.some((m) => m.id === mod.id)) activeGroupId.value = mod.group;
});

/** 选中模块变化时，把轨道上的选中胶囊滚进可视区（模块多时横向滚动兜底） */
const railEl = ref<HTMLElement | null>(null);
watch(selectedId, async (id) => {
  if (!id) return;
  await nextTick();
  const el = railEl.value?.querySelector<HTMLElement>(`[data-prompt-id="${id}"]`);
  // jsdom 未实现 scrollIntoView，缺失时静默跳过（只影响滚动，不影响功能）
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
});

/* ---------------- 编辑态 ---------------- */

const draft = ref("");

/** 选中模块变化 / 覆盖值变化时，把编辑区重置为该模块的生效正文 */
function syncDraft() {
  const mod = selected.value;
  if (!mod) {
    draft.value = "";
    return;
  }
  draft.value = effectivePromptText(mod, overrides.value);
}

watch([selectedId, overrides], syncDraft, { immediate: true });

const dirty = computed(() => {
  const mod = selected.value;
  if (!mod) return false;
  return draft.value !== effectivePromptText(mod, overrides.value);
});

const isCustomized = computed(() => (selected.value ? customized.value.has(selected.value.id) : false));

/** 契约变量缺失 / 未知占位符：只提示不阻断（尊重用户改写提示词的自由） */
const contractMissing = computed(() =>
  selected.value ? missingContractVariables(selected.value, draft.value) : [],
);
const unknownVars = computed(() =>
  selected.value ? unknownPlaceholders(selected.value, draft.value) : [],
);

/** 占位符名的展示形式：模板里不便内联拼接花括号，统一在这里格式化 */
function asPlaceholder(name: string): string {
  return `{${name}}`;
}

const contractMissingText = computed(() => contractMissing.value.map(asPlaceholder).join("、"));
const unknownVarsText = computed(() => unknownVars.value.map(asPlaceholder).join("、"));

/** 预览：与运行期同一套渲染语义（契约变量用程序实际值代入） */
const preview = computed(() =>
  selected.value
    ? promptPreview(selected.value, {
        [selected.value.id]: { text: draft.value, updated_at: "" },
      })
    : "",
);

const textareaEl = ref<HTMLTextAreaElement | null>(null);

/** 变量插入：有光标就插在光标处，否则追加到末尾 */
function insertVariable(name: string) {
  const token = `{${name}}`;
  const el = textareaEl.value;
  if (!el) {
    draft.value += token;
    return;
  }
  const start = el.selectionStart ?? draft.value.length;
  const end = el.selectionEnd ?? start;
  draft.value = draft.value.slice(0, start) + token + draft.value.slice(end);
  // 插入后把光标移到占位符之后，便于继续输入
  requestAnimationFrame(() => {
    el.focus();
    const caret = start + token.length;
    el.setSelectionRange(caret, caret);
  });
}

/* ---------------- 保存 / 恢复默认 ---------------- */

function onSave() {
  const mod = selected.value;
  if (!mod) return;
  savePromptOverride(mod.id, draft.value);
  toast(
    draft.value.trim() ? `已保存「${mod.label}」` : `「${mod.label}」正文为空，已恢复默认`,
    { tone: "success" },
  );
}

async function onResetOne() {
  const mod = selected.value;
  if (!mod || !isCustomized.value) return;
  const ok = await confirmAction({
    title: `恢复「${mod.label}」的默认提示词？`,
    message: "将丢弃你对这一模块的调整，恢复成应用内置的默认文案。",
    confirmText: "恢复默认",
  });
  if (!ok) return;
  resetPromptOverride(mod.id);
  toast(`已恢复「${mod.label}」的默认提示词`, { tone: "success" });
}

async function onResetAll() {
  if (!customCount.value) return;
  const ok = await confirmAction({
    title: `恢复全部 ${customCount.value} 个模块的默认提示词？`,
    message: "将丢弃你对所有模块的调整，恢复成应用内置的默认文案。",
    tone: "danger",
    confirmText: "全部恢复",
  });
  if (!ok) return;
  resetAllPromptOverrides();
  toast("已恢复全部模块的默认提示词", { tone: "success" });
}

function selectModule(id: string) {
  selectedId.value = id;
}
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">提示词管理</h1>
    <div class="flex items-center gap-3">
      <span class="whitespace-nowrap text-fine text-weak" data-test="prompt-custom-count">
        已自定义 <span class="font-semibold text-ai">{{ customCount }}</span> / {{ modules.length }}
      </span>
      <AppButton
        variant="pearl"
        data-test="prompt-reset-all"
        :disabled="customCount === 0"
        @click="onResetAll"
      >
        全部恢复默认
      </AppButton>
    </div>
  </header>

  <!-- 第一条横带：分组 Tab（能量线选中态）+ 当前分组说明 + 搜索 -->
  <div class="flex shrink-0 items-center gap-4 border-b border-hairline bg-canvas pl-2 pr-6">
    <nav class="scrollbar-none flex items-center overflow-x-auto">
      <button
        v-for="tab in groupTabs"
        :key="tab.id"
        type="button"
        class="-mb-px flex h-11 shrink-0 items-center gap-1.5 px-3.5 text-caption transition-colors duration-150"
        :class="
          !query.trim() && tab.id === activeGroupId
            ? 'tab-energy font-semibold text-ink'
            : 'text-weak hover:text-ink'
        "
        @click="selectGroup(tab.id)"
      >
        {{ tab.label }}
        <span
          class="rounded-pill px-1.5 py-0.5 text-[10px] leading-4"
          :class="!query.trim() && tab.id === activeGroupId ? 'bg-primary-soft text-primary' : 'bg-parchment text-weak'"
        >
          {{ tab.count }}
        </span>
      </button>
    </nav>
    <p class="min-w-0 flex-1 truncate text-right text-fine text-weak">{{ activeGroupDesc }}</p>
    <AppInput
      v-model="query"
      variant="search"
      width="220px"
      placeholder="搜索模块名称或 id…"
      class="shrink-0"
    />
  </div>

  <!-- 第二条横带：模块胶囊轨道（横向滚动，模块再多也不占纵向空间） -->
  <div
    ref="railEl"
    class="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline bg-canvas px-6 py-2.5"
  >
    <button
      v-for="mod in railModules"
      :key="mod.id"
      type="button"
      data-test="prompt-module"
      :data-prompt-id="mod.id"
      :title="mod.id"
      class="flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-caption transition-colors duration-150"
      :class="
        selected?.id === mod.id
          ? 'grad-border-soft font-semibold text-primary'
          : 'border border-hairline bg-canvas text-ink hover:border-faint hover:bg-pearl'
      "
      @click="selectModule(mod.id)"
    >
      <span class="whitespace-nowrap">{{ mod.label }}</span>
      <span
        v-if="customized.has(mod.id)"
        class="shrink-0 whitespace-nowrap rounded-pill bg-ai-soft px-1.5 py-0.5 text-[10px] leading-4 text-ai"
      >
        已自定义
      </span>
    </button>
    <p v-if="!railModules.length" class="text-caption text-weak">
      没有匹配「{{ query.trim() }}」的模块
    </p>
  </div>

  <!-- 主体：左编辑卡 + 右信息卡（变量 / 预览 分段切换） -->
  <div class="flex min-h-0 flex-1 gap-5 overflow-hidden bg-parchment p-6">
    <!-- 左：编辑器 -->
    <AppCard class="scroll-thin min-w-0 flex-1 overflow-y-auto" data-test="prompt-editor">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-tagline font-semibold text-ink">{{ selected?.label }}</h2>
            <span
              class="rounded-pill border border-divider bg-pearl px-2 py-0.5 font-mono text-[10px] leading-4 text-weak"
            >
              {{ selected?.id }}
            </span>
            <span
              v-if="isCustomized"
              class="rounded-pill bg-ai-soft px-2 py-0.5 text-[10px] leading-4 text-ai"
            >
              已自定义
            </span>
          </div>
          <p class="mt-1 text-caption text-weak">{{ selected?.description }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <AppButton
            variant="pearl"
            data-test="prompt-reset-one"
            :disabled="!isCustomized"
            @click="onResetOne"
          >
            恢复默认
          </AppButton>
          <AppButton variant="primary" data-test="prompt-save" @click="onSave">保存</AppButton>
        </div>
      </div>

      <p
        v-if="selected?.note"
        class="mt-3 flex items-start gap-2 rounded-sm bg-pearl px-3 py-2 text-fine leading-relaxed text-muted"
      >
        <AppIcon name="warn" :size="14" class="mt-0.5 shrink-0 text-improve" />
        <span>{{ selected.note }}</span>
      </p>

      <div class="mb-1.5 mt-4 flex items-baseline justify-between">
        <label class="text-fine text-weak" :for="`prompt-text-${selected?.id}`">系统提示词正文</label>
        <span class="text-fine text-faint">{{ draft.length }} 字</span>
      </div>
      <textarea
        :id="`prompt-text-${selected?.id}`"
        ref="textareaEl"
        v-model="draft"
        rows="12"
        spellcheck="false"
        class="scroll-thin w-full resize-y rounded-sm border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none transition-colors focus:border-primary-focus"
      />

      <div class="mt-2 flex flex-wrap items-center gap-3">
        <span v-if="dirty" class="text-fine text-improve" data-test="prompt-dirty">
          有未保存的改动
        </span>
        <span v-else class="text-fine text-faint">已保存</span>
        <span
          v-if="unknownVars.length"
          class="text-fine text-danger"
          data-test="prompt-unknown-warning"
        >
          正文里有未声明的占位符：{{ unknownVarsText }}（会按字面发送给模型）
        </span>
      </div>

      <p
        v-if="contractMissing.length"
        class="mt-2 text-fine text-improve"
        data-test="prompt-contract-warning"
      >
        正文里没有出现 {{ contractMissingText }}，程序靠它按固定结构解析输出；
        删掉可能导致识别失效（仍可保存）。
      </p>
    </AppCard>

    <!-- 右：信息卡（可用变量 / 预览） -->
    <AppCard :padded="false" class="flex w-[360px] shrink-0 flex-col overflow-hidden">
      <div class="flex shrink-0 gap-1 border-b border-divider p-3">
        <button
          type="button"
          class="h-7 flex-1 rounded-sm text-caption transition-colors duration-150"
          :class="
            infoPane === 'vars'
              ? 'grad-border-soft font-semibold text-primary'
              : 'text-weak hover:bg-pearl hover:text-ink'
          "
          @click="infoPane = 'vars'"
        >
          可用变量{{ selected?.variables?.length ? ` · ${selected.variables.length}` : "" }}
        </button>
        <button
          type="button"
          class="h-7 flex-1 rounded-sm text-caption transition-colors duration-150"
          :class="
            infoPane === 'preview'
              ? 'grad-border-soft font-semibold text-primary'
              : 'text-weak hover:bg-pearl hover:text-ink'
          "
          @click="infoPane = 'preview'"
        >
          预览
        </button>
      </div>

      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <!-- 两个面板都常驻 DOM（v-show）：预览随时反映当前草稿，变量随时可查 -->
        <div v-show="infoPane === 'vars'">
          <ul v-if="selected?.variables?.length" class="space-y-1">
            <li
              v-for="v in selected.variables"
              :key="v.name"
              class="border-b border-divider py-2.5 last:border-b-0"
            >
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-test="prompt-variable"
                  class="shrink-0 rounded-sm bg-ai-soft px-2 py-0.5 text-fine text-ai transition-colors duration-150 hover:bg-ai-hover"
                  @click="insertVariable(v.name)"
                >
                  {{ asPlaceholder(v.name) }}
                </button>
                <span
                  v-if="v.fixedValue !== undefined"
                  class="rounded-pill border border-divider bg-pearl px-2 text-[10px] leading-4 text-muted"
                >
                  契约 · 只读
                </span>
              </div>
              <p class="mt-1.5 text-fine leading-relaxed text-muted">{{ v.description }}</p>
              <p v-if="v.fixedValue !== undefined" class="mt-1 break-all text-fine leading-relaxed text-weak">
                程序固定代入（只读）：{{ v.fixedValue }}
              </p>
              <p v-else-if="v.defaultValue !== undefined" class="mt-1 text-fine text-weak">
                默认值：{{ v.defaultValue }}
              </p>
              <p v-else-if="v.sample" class="mt-1 text-fine text-weak">示例：{{ v.sample }}</p>
            </li>
          </ul>
          <p v-else class="py-2 text-fine text-weak">这个模块没有可用变量。</p>
        </div>

        <div v-show="infoPane === 'preview'">
          <p class="mb-2 text-fine text-weak">
            按当前正文渲染出的最终系统提示词（变量已代入实际值，与运行期同一套渲染逻辑）。
          </p>
          <pre
            class="whitespace-pre-wrap break-words rounded-sm bg-pearl px-3 py-2 text-fine leading-relaxed text-muted"
            data-test="prompt-preview"
          >{{ preview }}</pre>
        </div>
      </div>
    </AppCard>
  </div>
</template>
