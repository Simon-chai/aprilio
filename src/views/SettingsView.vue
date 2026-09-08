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
  saveAiConfig,
  type AiConfig,
} from "../lib/ai";
import { clearAll, getStats, isTauri } from "../lib/db";
import { getPhotosDir } from "../lib/photos";
import { clearBackgroundLibrary } from "../lib/backgrounds";
import type { Stats } from "../types";

const photosDir = ref("");
const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });

/* ---- AI 模型配置 ---- */
const ai = ref<AiConfig>(loadAiConfig());
const aiSaved = ref(false);

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
          接入主流大模型，用于首页的 AI 助手。密钥只保存在本机，不出现在任何服务器。
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
            <AppInput
              id="ai-key"
              v-model="ai.apiKey"
              type="password"
              variant="field"
              width="100%"
              placeholder="sk-…"
            />
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
