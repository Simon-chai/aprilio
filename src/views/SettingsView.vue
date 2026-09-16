<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppDialog from "../components/ui/AppDialog.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import AppIconButton from "../components/ui/AppIconButton.vue";
import AppInput from "../components/ui/AppInput.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import ModelSwitcher from "../components/ui/ModelSwitcher.vue";
import { confirmAction } from "../composables/useConfirm";
import { useToast } from "../composables/useToast";
import {
  AI_PROVIDERS,
  aiErrorMessage,
  aiProviderById,
  isAiConfigured,
  listAiModels,
  loadAiProfiles,
  maskApiKey,
  newAiProfileId,
  saveAiProfileVerified,
  setActiveAiProfile,
  deleteAiProfile,
  type AiModelOption,
  type AiProfile,
  type AiProfilesState,
} from "../lib/ai";
import { clearAll, getStats, isTauri } from "../lib/db";
import { getPhotosDir } from "../lib/photos";
import {
  backgroundSrc,
  clearBackgroundLibrary,
  ensureBackgroundLibrary,
} from "../lib/backgrounds";
import {
  bingWallpaperEntries,
  importBingWallpapers,
  loadWallpaperConfig,
  saveWallpaperConfig,
} from "../lib/wallpaper";
import type { BackgroundImage, Stats } from "../types";

const photosDir = ref("");
const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });

/* ---- 必应壁纸（手动入库，背景图在选图弹窗里挑用） ---- */
const wallpaper = ref(loadWallpaperConfig());
const wpUpdating = ref(false);
const wpMsg = ref("");

const wpStatus = computed(() => {
  if (!isTauri()) return "仅桌面端可用（浏览器演示态不联网）。";
  return wallpaper.value.last_date
    ? `上次拉取：${wallpaper.value.last_date}`
    : "还没有拉取过，点「拉取必应壁纸」试试。";
});

/* 拉取进图库的必应壁纸（最近用过的在前）：缩略图按缓存文件解析，离线也能显示 */
const wpEntries = computed(() => bingWallpaperEntries());

function wpThumbSrc(item: BackgroundImage): string {
  return backgroundSrc(item);
}

function onCountChange() {
  saveWallpaperConfig({ ...wallpaper.value });
}

async function onFetchWallpapers() {
  wpUpdating.value = true;
  wpMsg.value = "";
  try {
    const count = await importBingWallpapers();
    wallpaper.value = loadWallpaperConfig();
    wpMsg.value = `已入库 ${count} 张（重复的自动复用，不重复下载）`;
  } catch {
    wpMsg.value = "拉取失败，请检查网络后重试";
  } finally {
    wpUpdating.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* AI 模型方案：列表 + 一键切换 + 添加/编辑弹窗                           */
/* ------------------------------------------------------------------ */

const profilesState = ref<AiProfilesState>(loadAiProfiles());
const profiles = computed(() => profilesState.value.profiles);
const activeProfile = computed(
  () =>
    profilesState.value.profiles.find((p) => p.id === profilesState.value.activeId) ??
    profilesState.value.profiles[0]
);
const aiReady = computed(() => (activeProfile.value ? isAiConfigured(activeProfile.value) : false));

/** 全局轻反馈：保存 / 切换 / 删除的结果统一顶部 toast（成功场景 success tone） */
const toast = useToast();
const switchError = ref("");

function isActive(p: AiProfile): boolean {
  return activeProfile.value?.id === p.id;
}

function providerOf(p: AiProfile) {
  return aiProviderById(p.provider) ?? AI_PROVIDERS[0];
}

function missingKey(p: AiProfile): boolean {
  return providerOf(p).needsKey && !p.apiKey.trim();
}

function profileMeta(p: AiProfile): string {
  const keyPart = providerOf(p).needsKey
    ? p.apiKey.trim()
      ? `已配置 ${maskApiKey(p.apiKey)}`
      : "还差 API 密钥"
    : "无需密钥";
  return `${providerOf(p).label} · ${p.model || "未填写模型 ID"} · ${keyPart}`;
}

/** 一键切换当前方案；缺密钥的方案不放行，给出补配置指引 */
function onSwitchProfile(p: AiProfile) {
  switchError.value = "";
  if (!isAiConfigured(p)) {
    switchError.value = `「${p.name || p.model}」还没配置 API 密钥，先点「编辑」补上再切换。`;
    return;
  }
  profilesState.value = setActiveAiProfile(p.id);
  toast(`已切换到「${p.name || p.model}」`, { tone: "success" });
}

/** 切换胶囊里的「管理模型方案」：列表就在本页，滚过去即可 */
function onSwitcherManage() {
  listEl.value?.scrollIntoView({ behavior: "smooth", block: "center" });
}

const listEl = ref<HTMLElement | null>(null);

/* ---- 行内「⋯」菜单：编辑 / 删除 ---- */
const rowMenuId = ref("");

function toggleRowMenu(id: string) {
  rowMenuId.value = rowMenuId.value === id ? "" : id;
}

/** 删除方案：统一走全局危险确认弹层（行内两步确认已退役） */
async function onRequestDelete(p: AiProfile) {
  rowMenuId.value = "";
  const label = p.name || p.model;
  const ok = await confirmAction({
    title: `删除「${label}」？`,
    message: "删除后不可恢复。",
    tone: "danger",
    confirmText: "删除",
  });
  if (!ok) return;
  const wasActive = isActive(p);
  profilesState.value = deleteAiProfile(p.id);
  const next = profilesState.value.profiles.find((x) => x.id === profilesState.value.activeId);
  toast(
    wasActive && next
      ? `已删除「${label}」，当前方案换为「${next.name || next.model}」`
      : `已删除「${label}」`,
    { tone: "success" }
  );
}

/* 点击行菜单外任意处收起 ⋯ 菜单 */
function onDocClick(e: MouseEvent) {
  if (rowMenuId.value && !(e.target as HTMLElement).closest("[data-row-menu-root]")) {
    rowMenuId.value = "";
  }
}
onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
});

/* ---- 添加 / 编辑弹窗 ---- */
const modalOpen = ref(false);
const editingId = ref<string | null>(null); // null = 新增
const form = ref<AiProfile>(blankProfile());
const showApiKey = ref(false);
const aiValidating = ref(false);
const aiSaveError = ref("");

function blankProfile(): AiProfile {
  // 新增默认落到 DeepSeek：国内可直连、按量计费对校园场景友好，改起来也只是一次下拉
  return {
    id: newAiProfileId(),
    name: "",
    provider: "deepseek",
    model: "deepseek-chat",
    apiKey: "",
    baseUrl: "",
    temperature: 0.7,
    systemPrompt: "",
  };
}

const formProvider = computed(() => providerOf(form.value));

function openAdd() {
  editingId.value = null;
  form.value = blankProfile();
  resetModalMsgs();
  modalOpen.value = true;
}

function openEdit(p: AiProfile) {
  rowMenuId.value = "";
  editingId.value = p.id;
  form.value = { ...p };
  resetModalMsgs();
  modalOpen.value = true;
}

function resetModalMsgs() {
  showApiKey.value = false;
  aiSaveError.value = "";
  modelOptions.value = [];
  modelsMsg.value = "";
}

function closeModal() {
  modalOpen.value = false;
}

function onProviderChange() {
  // 换供应商后旧候选不再适用，一并清掉；默认模型自动带入
  modelOptions.value = [];
  modelsMsg.value = "";
  if (formProvider.value.defaultModel) {
    form.value.model = formProvider.value.defaultModel;
  }
}

/* 一键拉取供应商支持的模型列表：候选进 datalist，点「模型 ID」输入框即可挑选 */
const modelOptions = ref<AiModelOption[]>([]);
const modelsLoading = ref(false);
const modelsMsg = ref("");

async function onFetchModels() {
  if (formProvider.value.needsKey && !form.value.apiKey.trim()) {
    modelsMsg.value = "请先填写 API 密钥再拉取模型列表。";
    return;
  }
  modelsLoading.value = true;
  modelsMsg.value = "";
  try {
    // 直接用当前表单值（含未保存的密钥 / 地址），无需先保存
    modelOptions.value = await listAiModels(form.value);
    modelsMsg.value = `已拉取 ${modelOptions.value.length} 个模型，点「模型 ID」输入框即可从候选中选择。`;
  } catch (err) {
    modelsMsg.value = aiErrorMessage(err);
  } finally {
    modelsLoading.value = false;
  }
}

function onSaveModal() {
  if (aiValidating.value) return;
  const name = form.value.name.trim();
  const model = form.value.model.trim();
  if (!name) {
    aiSaveError.value = "先给模型起个名字，方便在切换列表里认出它。";
    return;
  }
  if (!model) {
    aiSaveError.value = "模型 ID 不能为空。";
    return;
  }
  // 快照当前表单值：校验的是所填内容，落盘的也是同一份
  const snapshot: AiProfile = { ...form.value, name, model };
  aiSaveError.value = "";
  aiValidating.value = true;
  saveAiProfileVerified(snapshot)
    .then((result) => {
      // 存完即收起明文，避免密钥长时间暴露在界面上
      showApiKey.value = false;
      profilesState.value = loadAiProfiles();
      modalOpen.value = false;
      toast(result === "verified" ? "已保存，校验通过" : "已保存（浏览器演示态不联网，未校验）", {
        tone: "success",
      });
    })
    .catch((err) => {
      // 校验不过不落盘，把原因亮出来
      aiSaveError.value = `校验未通过：${aiErrorMessage(err)}`;
    })
    .finally(() => {
      aiValidating.value = false;
    });
}

async function refresh() {
  // 图库索引 + 缓存目录就绪后缩略图才能解析（直接落到设置页也要能看）
  await ensureBackgroundLibrary().catch(() => undefined);
  photosDir.value = await getPhotosDir();
  stats.value = await getStats();
}

onMounted(refresh);

async function onClear() {
  const ok = await confirmAction({
    title: "清空全部数据",
    message: "将清空全部学生与图片记录，且无法撤销。",
    tone: "danger",
    confirmText: "清空",
  });
  if (!ok) return;
  await clearAll();
  // 背景图库是本地索引 + 缓存文件，清数据时一并清掉，避免留下孤儿文件
  await clearBackgroundLibrary();
  await refresh();
}
</script>

<template>
  <header
    class="flex h-[52px] shrink-0 items-center justify-between border-b border-hairline bg-parchment px-8"
  >
    <h1 class="text-tagline font-semibold text-ink">数据与设置</h1>
  </header>

  <div class="scroll-thin flex-1 overflow-y-auto p-8">
    <div class="max-w-[720px] space-y-5">
      <!-- AI 模型方案 -->
      <AppCard>
        <div class="mb-1 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-body font-semibold text-ink">AI 模型</h3>
            <p class="mt-1 text-caption text-weak">
              保存多套模型方案，随时一键切换。密钥只保存在本机（混淆存放，不以明文躺在存储里），不出现在任何服务器。
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <!-- 当前模型快捷切换：与 AI 助手悬浮窗里的胶囊联动 -->
            <ModelSwitcher v-if="profiles.length" @manage="onSwitcherManage" />
            <AppButton variant="secondary" data-test="ai-profile-add" @click="openAdd">
              ＋ 添加模型
            </AppButton>
          </div>
        </div>

        <p v-if="switchError" data-test="ai-switch-error" class="mb-3 text-caption text-danger" role="alert">
          {{ switchError }}
        </p>

        <!-- 空态：还没有任何方案 -->
        <EmptyState
          v-if="!profiles.length"
          title="还没有模型方案"
          description="点右上角「添加模型」创建第一套方案，之后就能在这里和 AI 助手里一键切换。"
        />

        <div v-else ref="listEl" class="space-y-3" data-test="ai-profile-list">
          <article
            v-for="p in profiles"
            :key="p.id"
            data-test="ai-profile"
            class="flex items-center gap-4 rounded-lg p-4 transition-colors duration-150"
            :class="isActive(p) ? 'grad-border-soft' : 'border border-hairline'"
          >
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-body font-semibold text-ink">{{ p.name || "未命名方案" }}</span>
                <span
                  v-if="isActive(p)"
                  class="whitespace-nowrap rounded-pill bg-primary-soft px-2 py-0.5 text-fine text-primary"
                >
                  当前使用
                </span>
                <span
                  v-if="missingKey(p)"
                  class="whitespace-nowrap rounded-pill bg-danger-soft px-2 py-0.5 text-fine text-danger"
                >
                  缺密钥
                </span>
                <span
                  v-if="!providerOf(p).needsKey"
                  class="whitespace-nowrap rounded-pill bg-mint px-2 py-0.5 text-fine text-success"
                >
                  本地
                </span>
              </div>
              <p class="mt-0.5 truncate text-caption text-weak">{{ profileMeta(p) }}</p>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <AppButton
                v-if="!isActive(p)"
                :variant="missingKey(p) ? 'pearl' : 'secondary'"
                data-test="ai-profile-switch"
                @click="onSwitchProfile(p)"
              >
                设为当前
              </AppButton>
              <div class="relative" data-row-menu-root>
                <AppIconButton label="更多操作" data-test="ai-profile-menu" @click="toggleRowMenu(p.id)">
                  ⋯
                </AppIconButton>
                <div
                  v-if="rowMenuId === p.id"
                  class="absolute right-0 top-full z-30 mt-1.5 min-w-[112px] rounded-md border border-hairline bg-canvas p-1 shadow-window"
                >
                  <button
                    type="button"
                    data-test="ai-profile-edit"
                    class="w-full rounded-sm px-2.5 py-2 text-left text-caption text-ink transition-colors duration-150 hover:bg-pearl"
                    @click="openEdit(p)"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    data-test="ai-profile-delete"
                    class="w-full rounded-sm px-2.5 py-2 text-left text-caption text-danger transition-colors duration-150 hover:bg-danger-soft"
                    @click="onRequestDelete(p)"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>

        <p class="mt-4 border-t border-divider pt-3 text-fine text-faint" data-test="ai-status">
          当前状态：{{ profiles.length ? `${profiles.length} 套方案 · 当前「${activeProfile?.name || activeProfile?.model}」${aiReady ? "已配置 ✓" : "未配置"}` : "未配置" }}
          · 切换即时生效，无需重新保存 · 也支持「供应商::模型」写法（如 groq::llama-3.3-70b）
        </p>
      </AppCard>

      <!-- 添加 / 编辑方案弹窗：统一 AppDialog 壳（遮罩 / Esc / 焦点圈定由壳负责） -->
      <AppDialog
        :open="modalOpen"
        :title="editingId ? '编辑模型' : '添加模型'"
        width="md"
        data-test="ai-modal"
        class="scroll-thin max-h-[calc(100vh-64px)] overflow-y-auto"
        @close="closeModal"
      >
        <!-- 原弹窗标题行右上角的关闭入口：壳不自带，保留在面板右上角 -->
        <AppIconButton label="关闭" class="absolute right-4 top-4" @click="closeModal">
          <AppIcon name="close" :size="14" />
        </AppIconButton>
        <p class="mt-3 mb-4 text-caption text-weak">每个方案独立保存供应商、模型与密钥，互不影响。</p>

        <div class="space-y-4">
          <div>
            <label class="mb-1.5 block text-fine text-weak" for="ai-name">模型名称</label>
            <input
              id="ai-name"
              v-model="form.name"
              data-test="ai-name"
              autofocus
              class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors placeholder:text-weak focus:border-primary-focus"
              placeholder="如：DeepSeek 日常主力 / 本地 Ollama 离线备用"
            />
          </div>

            <div>
              <label class="mb-1.5 block text-fine text-weak" for="ai-provider">供应商</label>
              <select
                id="ai-provider"
                v-model="form.provider"
                data-test="ai-provider"
                class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
                @change="onProviderChange"
              >
                <option v-for="pr in AI_PROVIDERS" :key="pr.id" :value="pr.id">{{ pr.label }}</option>
              </select>
            </div>

            <div>
              <label class="mb-1.5 block text-fine text-weak" for="ai-model">模型 ID</label>
              <div class="flex items-center gap-2">
                <AppInput
                  id="ai-model"
                  v-model="form.model"
                  variant="field"
                  width="100%"
                  list="ai-model-options"
                  data-test="ai-model"
                  class="min-w-0 flex-1"
                  placeholder="如 deepseek-chat / glm-4-flash / qwen3:8b"
                />
                <AppButton
                  variant="pearl"
                  data-test="ai-models-fetch"
                  :disabled="modelsLoading || !isTauri()"
                  aria-label="拉取该供应商支持的模型列表"
                  @click="onFetchModels"
                >
                  {{ modelsLoading ? "拉取中…" : "拉取模型" }}
                </AppButton>
              </div>
              <!-- 候选列表：点「拉取模型」后填充，输入框聚焦 / 输入时原生弹出 -->
              <datalist id="ai-model-options">
                <option v-for="m in modelOptions" :key="m.id" :value="m.id">{{ m.name || m.id }}</option>
              </datalist>
              <p
                v-if="modelsMsg"
                class="mt-1 text-fine"
                :class="modelsMsg.startsWith('已拉取') ? 'text-success' : 'text-danger'"
              >
                {{ modelsMsg }}
              </p>
            </div>

            <div v-if="formProvider.needsKey">
              <label class="mb-1.5 block text-fine text-weak" for="ai-key">API 密钥</label>
              <div class="relative">
                <AppInput
                  id="ai-key"
                  v-model="form.apiKey"
                  :type="showApiKey ? 'text' : 'password'"
                  variant="field"
                  width="100%"
                  placeholder="sk-…"
                  autocomplete="off"
                  data-test="ai-key"
                  class="pr-11"
                />
                <!-- 密钥显隐眼睛：内联在输入栏最右，睁眼=可查看，闭眼=已隐藏 -->
                <button
                  type="button"
                  class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-sm text-weak transition-colors duration-150 hover:text-ink"
                  :aria-label="showApiKey ? '隐藏密钥' : '查看密钥'"
                  :aria-pressed="showApiKey"
                  data-test="ai-key-toggle"
                  @click="showApiKey = !showApiKey"
                >
                  <svg v-if="showApiKey" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M4 4l16 16"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                    <path
                      d="M10.7 5.7a10 10 0 0 1 1.3-.2c6 0 9.5 6.5 9.5 6.5a17.6 17.6 0 0 1-2.4 3.2M6.6 6.9C4 8.7 2.5 12 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <path
                      d="M9.9 9.9a2.8 2.8 0 0 0 4 4"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                  </svg>
                  <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linejoin="round"
                    />
                    <circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.6" />
                  </svg>
                </button>
              </div>
            </div>
            <p v-else class="text-fine text-faint">
              本地 Ollama 无需密钥，服务地址默认 http://localhost:11434。
            </p>

            <div>
              <label class="mb-1.5 block text-fine text-weak" for="ai-base-url">自定义 API 地址（可选）</label>
              <AppInput
                id="ai-base-url"
                v-model="form.baseUrl"
                variant="field"
                width="100%"
                placeholder="留空使用官方地址；填 OpenAI 兼容地址可接入中转或私有部署"
              />
            </div>

            <div>
              <label class="mb-1.5 block text-fine text-weak" for="ai-system">系统提示词（可选）</label>
              <textarea
                id="ai-system"
                v-model="form.systemPrompt"
                rows="3"
                class="w-full resize-none rounded-sm border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none transition-colors placeholder:text-weak focus:border-primary-focus"
                placeholder="告诉 AI 它是谁，比如：你是一位小学班主任的教学助手，回答简洁实用。"
              />
            </div>

            <div class="flex items-center gap-3">
              <AppButton
                variant="primary"
                data-test="ai-save"
                :disabled="aiValidating"
                @click="onSaveModal"
              >
                {{ aiValidating ? "校验中…" : "保存并校验" }}
              </AppButton>
              <AppButton variant="pearl" data-test="ai-modal-cancel" @click="closeModal">取消</AppButton>
            </div>
            <p v-if="aiSaveError" data-test="ai-save-error" class="text-caption text-danger">
              {{ aiSaveError }}
            </p>

            <p class="border-t border-divider pt-3 text-fine text-faint">
              密钥只保存在本机（混淆存放），不会上传。请求由本机 Rust 后端（rig-core）发出，
              {{ isTauri() ? "桌面端即刻可用。" : "浏览器演示态下不会真实联网。" }}
            </p>
          </div>
      </AppDialog>

      <AppCard>
        <h3 class="mb-1 text-body font-semibold text-ink">必应壁纸</h3>
        <p class="mb-4 text-caption text-weak">
          手动把必应近期壁纸拉取到本机图库，不会自动更换背景。首页大图与课表背景
          共用这套图库，在各自的「更换图片」弹窗里即可挑用。
        </p>

        <div class="space-y-3">
          <label class="flex items-center gap-2 text-caption text-ink">
            每次拉取
            <select
              v-model.number="wallpaper.count"
              data-test="wallpaper-count"
              class="h-7 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              @change="onCountChange"
            >
              <option :value="1">仅当天（1 张）</option>
              <option :value="3">近 3 天</option>
              <option :value="5">近 5 天</option>
              <option :value="7">近 7 天</option>
              <option :value="8">近 8 天（接口上限）</option>
            </select>
          </label>

          <div class="flex items-center gap-3">
            <AppButton
              variant="secondary"
              data-test="wallpaper-fetch"
              :disabled="wpUpdating || !isTauri()"
              @click="onFetchWallpapers"
            >
              {{ wpUpdating ? "拉取中…" : "拉取必应壁纸" }}
            </AppButton>
            <span
              v-if="wpMsg"
              class="text-caption"
              :class="wpMsg.startsWith('已入库') ? 'text-success' : 'text-danger'"
            >
              {{ wpMsg }}
            </span>
          </div>

          <div
            v-if="wpEntries.length"
            data-test="wallpaper-thumbs"
            class="border-t border-divider pt-3"
          >
            <p class="mb-2 text-fine text-weak">已入库的必应壁纸（点「更换图片」弹窗即可挑用）</p>
            <!-- 缩略图样式与选图弹窗的历史网格一致 -->
            <div class="grid grid-cols-4 gap-2">
              <div v-for="item in wpEntries" :key="item.id">
                <div
                  class="relative block h-16 w-full overflow-hidden rounded-sm border border-hairline bg-pearl bg-cover bg-center"
                  :style="{ backgroundImage: wpThumbSrc(item) ? `url(${wpThumbSrc(item)})` : undefined }"
                  :title="item.name || '必应壁纸'"
                  data-test="wallpaper-thumb"
                >
                  <span class="absolute left-1 top-1 rounded-pill bg-black/55 px-1.5 text-[10px] leading-4 text-white">必应</span>
                </div>
                <p class="mt-1 truncate text-[10px] text-weak">{{ item.name || "必应壁纸" }}</p>
              </div>
            </div>
          </div>

          <p class="border-t border-divider pt-3 text-fine text-faint">{{ wpStatus }}</p>
        </div>
      </AppCard>

      <AppCard>
        <h3 class="mb-4 text-body font-semibold text-ink">运行环境</h3>
        <dl class="space-y-3">
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="whitespace-nowrap text-fine text-weak">运行模式</dt>
            <dd class="whitespace-nowrap text-right text-caption text-ink">
              {{ isTauri() ? "Tauri 桌面端（本地 SQLite）" : "浏览器预览（内存示例数据）" }}
            </dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="whitespace-nowrap text-fine text-weak">数据库</dt>
            <dd class="whitespace-nowrap text-right text-caption text-ink">sqlite:aprilio.db</dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="whitespace-nowrap text-fine text-weak">学生 / 图片</dt>
            <dd class="whitespace-nowrap text-right text-caption text-ink">{{ stats.students }} 条 / {{ stats.photos }} 张</dd>
          </div>
          <div class="flex items-start justify-between">
            <dt class="whitespace-nowrap text-fine text-weak">图片目录</dt>
            <dd class="max-w-[420px] break-all text-right text-caption text-muted">
              {{ photosDir || "（仅 Tauri 外壳内可用）" }}
            </dd>
          </div>
        </dl>
      </AppCard>

      <AppCard>
        <h3 class="mb-1 text-body font-semibold text-ink">清空数据</h3>
        <p class="mb-4 text-caption text-weak">删除所有学生与图片记录，操作不可撤销。</p>
        <AppButton variant="danger" @click="onClear">清空全部数据</AppButton>
      </AppCard>
    </div>
  </div>
</template>
