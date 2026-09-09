<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppInput from "../components/ui/AppInput.vue";
import {
  AI_PROVIDERS,
  aiProviderById,
  isAiConfigured,
  loadAiConfig,
  maskApiKey,
  saveAiConfig,
  type AiConfig,
} from "../lib/ai";
import { clearAll, getStats, isTauri } from "../lib/db";
import { getPhotosDir } from "../lib/photos";
import { clearBackgroundLibrary } from "../lib/backgrounds";
import {
  importBingWallpapers,
  loadWallpaperConfig,
  saveWallpaperConfig,
} from "../lib/wallpaper";
import type { Stats } from "../types";

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

/* ---- AI 模型配置 ---- */
const ai = ref<AiConfig>(loadAiConfig());
const aiSaved = ref(false);
/* 密钥默认脱敏显示（password），点「查看」一键明文展示，再点收起 */
const showApiKey = ref(false);

const aiProvider = computed(
  () => aiProviderById(ai.value.provider) ?? AI_PROVIDERS[0]
);
const aiReady = computed(() => isAiConfigured(ai.value));

function onProviderChange() {
  if (aiProvider.value.defaultModel) {
    ai.value.model = aiProvider.value.defaultModel;
  }
}

function onSaveAi() {
  saveAiConfig({ ...ai.value });
  // 存完即收起明文，避免密钥长时间暴露在界面上
  showApiKey.value = false;
  aiSaved.value = true;
  window.setTimeout(() => (aiSaved.value = false), 2000);
}

async function refresh() {
  photosDir.value = await getPhotosDir();
  stats.value = await getStats();
}

onMounted(refresh);

async function onClear() {
  const ok = window.confirm("将清空全部学生与图片记录，且无法撤销。确认继续？");
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
      <AppCard>
        <h3 class="mb-1 text-body font-semibold text-ink">AI 模型</h3>
        <p class="mb-4 text-caption text-weak">
          接入主流大模型，用于首页的 AI 助手。密钥只保存在本机（混淆存放，不以明文躺在存储里），不出现在任何服务器。
        </p>

        <div class="space-y-4">
          <div>
            <label class="mb-1.5 block text-fine text-weak" for="ai-provider">供应商</label>
            <select
              id="ai-provider"
              v-model="ai.provider"
              class="h-9 w-full rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink outline-none transition-colors focus:border-primary-focus"
              @change="onProviderChange"
            >
              <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>

          <div>
            <label class="mb-1.5 block text-fine text-weak" for="ai-model">模型名称</label>
            <AppInput
              id="ai-model"
              v-model="ai.model"
              variant="field"
              width="100%"
              placeholder="如 gpt-4o-mini / deepseek-chat / qwen3:8b"
            />
            <p class="mt-1 text-fine text-faint">
              也支持「供应商::模型」写法（如 groq::llama-3.3-70b）。
            </p>
          </div>

          <div v-if="aiProvider.needsKey">
            <label class="mb-1.5 block text-fine text-weak" for="ai-key">API 密钥</label>
            <div class="flex items-center gap-2">
              <AppInput
                id="ai-key"
                v-model="ai.apiKey"
                :type="showApiKey ? 'text' : 'password'"
                variant="field"
                width="100%"
                placeholder="sk-…"
                autocomplete="off"
              />
              <AppButton
                variant="pearl"
                data-test="ai-key-toggle"
                :aria-label="showApiKey ? '隐藏密钥' : '查看密钥'"
                @click="showApiKey = !showApiKey"
              >
                {{ showApiKey ? "隐藏" : "查看" }}
              </AppButton>
            </div>
            <p v-if="ai.apiKey && !showApiKey" class="mt-1 text-fine text-faint">
              已保存：{{ maskApiKey(ai.apiKey) }}（点「查看」显示完整密钥）
            </p>
          </div>

          <div>
            <label class="mb-1.5 block text-fine text-weak" for="ai-base-url">自定义 API 地址（可选）</label>
            <AppInput
              id="ai-base-url"
              v-model="ai.baseUrl"
              variant="field"
              width="100%"
              placeholder="留空使用官方地址；填 OpenAI 兼容地址可接入中转或私有部署"
            />
          </div>

          <div>
            <label class="mb-1.5 block text-fine text-weak" for="ai-system">系统提示词（可选）</label>
            <textarea
              id="ai-system"
              v-model="ai.systemPrompt"
              rows="3"
              class="w-full resize-none rounded-sm border border-hairline bg-canvas px-3 py-2 text-caption leading-relaxed text-ink outline-none transition-colors placeholder:text-weak focus:border-primary-focus"
              placeholder="告诉 AI 它是谁，比如：你是一位小学班主任的教学助手，回答简洁实用。"
            />
          </div>

          <div class="flex items-center gap-3">
            <AppButton variant="primary" @click="onSaveAi">保存设置</AppButton>
            <span v-if="aiSaved" class="text-caption text-success">已保存</span>
          </div>

          <p class="border-t border-divider pt-3 text-fine text-faint">
            当前状态：{{ aiReady ? "已配置 ✓" : "未配置" }} · 请求由本机 Rust 后端（rig-core）发出，
            {{ isTauri() ? "桌面端即刻可用。" : "浏览器演示态下不会真实联网。" }}
          </p>
        </div>
      </AppCard>

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

          <p class="border-t border-divider pt-3 text-fine text-faint">{{ wpStatus }}</p>
        </div>
      </AppCard>

      <AppCard>
        <h3 class="mb-4 text-body font-semibold text-ink">运行环境</h3>
        <dl class="space-y-3">
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">运行模式</dt>
            <dd class="text-caption text-ink">
              {{ isTauri() ? "Tauri 桌面端（本地 SQLite）" : "浏览器预览（内存示例数据）" }}
            </dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">数据库</dt>
            <dd class="text-caption text-ink">sqlite:aprilio.db</dd>
          </div>
          <div class="flex items-center justify-between border-b border-divider pb-3">
            <dt class="text-fine text-weak">学生 / 图片</dt>
            <dd class="text-caption text-ink">{{ stats.students }} 条 / {{ stats.photos }} 张</dd>
          </div>
          <div class="flex items-start justify-between">
            <dt class="text-fine text-weak">图片目录</dt>
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
