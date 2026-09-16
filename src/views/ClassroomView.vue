<script setup lang="ts">
/**
 * 课堂模式（全屏沉浸路由 /classroom）。
 *
 * 三态一页：
 * - 启动页：崩溃恢复横幅（live 会话逐个恢复）→ 节次感知命中卡（一键开课）→ 手动选班开临时课堂
 * - 课堂舞台：按会话活动组合快照渲染 Tab + 活动组件（LessonContextProvider 注入 LessonContext）
 * - 下课小结：confirmAction 确认门 → finishLesson（AI 优先/数据版兜底）→ 弹层展示并返回来源页
 *
 * 入口：首页课表面板「上课了」、我的课表、Agent（navigate classroom / ui_action classroom/start），
 * 带 query.session 时直达既有会话（恢复由 openLessonSession 槽位幂等保证）。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppButton from "../components/ui/AppButton.vue";
import AppDialog from "../components/ui/AppDialog.vue";
import AppIcon from "../components/ui/AppIcon.vue";
import LessonContextProvider from "../components/classroom/LessonContextProvider.vue";
import { useToast } from "../composables/useToast";
import { confirmAction } from "../composables/useConfirm";
import { getLessonSession, listClasses } from "../lib/db";
import { localDateStr } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { onPageAction } from "../agent/page-action-bus";
import { buildLessonContext } from "../classroom/context";
import { finishLesson } from "../classroom/digest";
import { detectCurrentLesson, listResumableSessions, startLesson } from "../classroom/session";
import type { DetectedLesson } from "../classroom/session";
import type { LessonDigestResult } from "../classroom/digest";
import type { LessonContext, LessonSession, LessonStats } from "../classroom/types";
import type { ClassSummary } from "../types";

const route = useRoute();
const router = useRouter();
const toast = useToast();

type Phase = "start" | "stage";
const phase = ref<Phase>("start");
const loading = ref(false);
const ending = ref(false);

const session = ref<LessonSession | null>(null);
/** 用 shallowRef：LessonContext 内部已用 reactive 组织读模型/状态表，
    深度代理会把活动组件（def.component）也 reactive 化（Vue 性能告警） */
const ctx = shallowRef<LessonContext | null>(null);
const activeType = ref("");

/** 启动页素材：课表命中 / 可恢复的 live 会话 / 班级下拉 */
const detected = ref<DetectedLesson | null>(null);
const resumable = ref<LessonSession[]>([]);
const classes = ref<ClassSummary[]>([]);
const manualClass = ref("");
const manualSubject = ref("");

/** 下课小结（finishLesson 产物；由本页或 Agent 页面动作触发） */
const ended = ref<LessonDigestResult | null>(null);
const endOpen = ref(false);

/* ---------------- 启动页装配 ---------------- */

async function loadStartup() {
  try {
    const [hit, live, list] = await Promise.all([
      detectCurrentLesson(),
      listResumableSessions(),
      listClasses(),
    ]);
    detected.value = hit;
    resumable.value = live;
    classes.value = list.filter((c) => !c.archived_at);
    if (!manualClass.value && classes.value.length) manualClass.value = classes.value[0].name;
  } catch (e) {
    console.error("[classroom] 启动页素材加载失败", e);
  }
}

/** 进入舞台：装配容器（重放事件重建活动状态）；未注册活动 toast 不阻断 */
async function openSession(target: LessonSession) {
  loading.value = true;
  try {
    const built = await buildLessonContext({ session: target });
    if (built.skipped.length) {
      toast(`以下活动未安装，已跳过：${built.skipped.join("、")}`, { tone: "error" });
    }
    session.value = built.ctx.session;
    ctx.value = built.ctx;
    activeType.value = built.ctx.activities[0]?.def.type ?? "";
    phase.value = "stage";
  } catch (e) {
    console.error("[classroom] 课堂装配失败", e);
    toast(e instanceof Error ? e.message : "课堂装配失败，请重试", { tone: "error" });
  } finally {
    loading.value = false;
  }
}

/** 开课（节次命中或手动临时课堂；槽位幂等：同班同日同节已开 = 恢复） */
async function begin(input: {
  class_name: string;
  subject: string;
  lesson_date: string;
  period: number | null;
}) {
  loading.value = true;
  try {
    const res = await startLesson(input);
    await openSession(res.session);
    if (res.created) toast(`已开始「${res.session.class_name}」的课堂`);
  } catch (e) {
    console.error("[classroom] 开课失败", e);
    toast(e instanceof Error ? e.message : "开课失败，请重试", { tone: "error" });
  } finally {
    loading.value = false;
  }
}

function startDetected() {
  const hit = detected.value;
  if (!hit) return;
  void begin({
    class_name: hit.class_name,
    subject: hit.subject,
    lesson_date: hit.lesson_date,
    period: hit.period,
  });
}

function startManual() {
  if (!manualClass.value) {
    toast("请先选择班级", { tone: "error" });
    return;
  }
  void begin({
    class_name: manualClass.value,
    subject: manualSubject.value.trim(),
    lesson_date: localDateStr(),
    period: null,
  });
}

/* ---------------- 下课与退出 ---------------- */

async function endLesson() {
  const target = session.value;
  if (!target || ending.value) return;
  const head = [target.class_name, target.subject].filter(Boolean).join(" · ");
  const ok = await confirmAction({
    title: "下课",
    message: `结束「${head}」这节课？将聚合本课事件生成课堂小结并归档。`,
    confirmText: "下课",
  });
  if (!ok) return;

  ending.value = true;
  try {
    const res = await finishLesson(target);
    ended.value = res;
    endOpen.value = true;
    session.value = { ...target, status: "ended", stats: res.stats };
  } catch (e) {
    console.error("[classroom] 下课失败", e);
    toast(e instanceof Error ? e.message : "下课失败，请重试", { tone: "error" });
  } finally {
    ending.value = false;
  }
}

/** 离开课堂模式：回来源页（无历史则回首页）；未下课的课堂留在恢复横幅里 */
function leave() {
  endOpen.value = false;
  if (session.value?.status === "live") {
    toast("课堂仍在进行，可从课堂模式的恢复横幅继续");
  }
  if (window.history.length > 1) router.back();
  else void router.push({ name: "home" });
}

/* ---------------- Agent 页面动作接住（classroom/end-lesson） ---------------- */

const offEndAction = onPageAction<{
  session_id?: number;
  digest_md?: string;
  digest_source?: "ai" | "data";
  stats?: LessonStats;
}>("classroom/end-lesson", (payload) => {
  // 只处理当前这场课；Agent 结束别的会话时本页不动作
  if (!payload?.session_id || payload.session_id !== session.value?.id) return;
  if (payload.digest_md && payload.stats) {
    ended.value = {
      stats: payload.stats,
      digest_md: payload.digest_md,
      digest_source: payload.digest_source ?? "data",
    };
  }
  endOpen.value = true;
});

/* ---------------- 计时（started_at 实时推导，不持久化） ---------------- */

const nowMs = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  tick = setInterval(() => (nowMs.value = Date.now()), 1000);
  await loadStartup();
  const sid = Number(route.query.session);
  if (Number.isInteger(sid) && sid > 0) {
    const target = await getLessonSession(sid);
    if (target) await openSession(target);
  }
});

onBeforeUnmount(() => {
  if (tick) clearInterval(tick);
  offEndAction();
});

/** query.session 变化（Agent 在本页发起 classroom/start 时同路由换参）→ 直达该会话 */
watch(
  () => route.query.session,
  async (raw) => {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) return;
    if (phase.value === "stage" && session.value?.id === sid) return;
    const target = await getLessonSession(sid);
    if (target) await openSession(target);
  },
);

/** "YYYY-MM-DD HH:MM:SS" → 毫秒（解析失败返回 null） */
function tsMs(ts: string | null): number | null {
  if (!ts) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(ts);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  ).getTime();
}

const elapsedText = computed(() => {
  const start = tsMs(session.value?.started_at ?? null);
  if (start === null) return "";
  const sec = Math.max(0, Math.round((nowMs.value - start) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm} 分 ${String(ss).padStart(2, "0")} 秒`;
});

/* ---------------- 舞台渲染 ---------------- */

const activeEntry = computed(
  () => ctx.value?.activities.find((a) => a.def.type === activeType.value) ?? null,
);

/** 活动降级提示（如无座位表按学号临时排座）：不拦截，只在舞台顶部挂一条说明 */
const fallbackText = computed(() => {
  const c = ctx.value;
  const entry = activeEntry.value;
  if (!c || !entry?.def.fallback) return "";
  try {
    return entry.def.fallback(c) ?? "";
  } catch {
    return "";
  }
});

const headText = computed(() => {
  const s = session.value;
  if (!s) return "";
  return [s.class_name, s.subject].filter(Boolean).join(" · ");
});

const periodText = computed(() => {
  const s = session.value;
  if (!s) return "";
  return s.period === null ? "临时课堂" : `第 ${s.period} 节`;
});

const endHeadline = computed(() => {
  const stats = ended.value?.stats;
  if (!stats) return "";
  const pickTotal = stats.picks.reduce((sum, p) => sum + p.count, 0);
  return `点名 ${pickTotal} 人次 · 表扬 ${stats.praise_count} 条 · 待改进 ${stats.improve_count} 条 · 缺勤 ${stats.absent.length} 人`;
});

const endHtml = computed(() => (ended.value ? renderMarkdown(ended.value.digest_md) : ""));
</script>

<template>
  <div class="classroom-immersive flex h-full min-h-0 flex-col" data-test="classroom-view">
    <!-- 启动页：恢复横幅 → 节次命中 → 手动选班 -->
    <div
      v-if="phase === 'start'"
      class="scroll-thin flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-8 py-12"
      data-test="classroom-start"
    >
      <div class="w-full max-w-[560px] space-y-4">
        <header class="flex items-center justify-between gap-3">
          <div>
            <h1 class="text-display font-semibold text-white">课堂模式</h1>
            <p class="mt-1 text-caption text-white/60">节课 = 会话容器 × 可组合活动 × 统一事件流</p>
          </div>
          <AppButton variant="pearl" data-test="classroom-start-exit" @click="leave">返回</AppButton>
        </header>

        <!-- 崩溃恢复横幅：全部 live 会话逐个恢复（重放事件重建） -->
        <section
          v-if="resumable.length"
          data-test="resume-banner"
          class="rounded-lg border border-white/15 bg-white/10 px-4 py-3"
        >
          <p class="text-caption font-semibold text-white">
            有 {{ resumable.length }} 节课尚未下课
          </p>
          <ul class="mt-2 space-y-1.5">
            <li
              v-for="s in resumable"
              :key="s.id"
              data-test="resume-item"
              class="flex items-center gap-2"
            >
              <span class="text-caption text-white/70">
                {{ s.class_name }}<template v-if="s.subject"> · {{ s.subject }}</template>
                · {{ s.period === null ? "临时课堂" : `第 ${s.period} 节` }} · {{ s.lesson_date }}
              </span>
              <AppButton
                variant="secondary"
                data-test="resume-btn"
                :disabled="loading"
                @click="openSession(s)"
              >
                恢复
              </AppButton>
            </li>
          </ul>
        </section>

        <!-- 节次感知命中：按当前时间自动命中的一节课 -->
        <section
          v-if="detected"
          data-test="detected-card"
          class="rounded-lg border border-white/15 bg-white/10 px-4 py-3"
        >
          <p class="text-caption font-semibold text-white">现在有你的课</p>
          <p class="mt-1 text-body text-white/70">
            {{ detected.class_name }} · {{ detected.subject }} · 第 {{ detected.period }} 节
            <span class="tnum text-white/50">（{{ detected.start }}–{{ detected.end }}）</span>
          </p>
          <AppButton class="mt-3" data-test="start-detected" :disabled="loading" @click="startDetected">
            开始上课
          </AppButton>
        </section>
        <section v-else class="rounded-lg border border-white/15 bg-white/10 px-4 py-3">
          <p class="text-caption text-white/60">当前时间不在你的课表时段内，可手动开一节课（课表外的早读、自习等）。</p>
        </section>

        <!-- 手动选班：开临时课堂（period NULL，同日可开多次） -->
        <section class="rounded-lg border border-white/15 bg-white/10 px-4 py-3">
          <p class="text-caption font-semibold text-white">手动开课</p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <select
              v-model="manualClass"
              data-test="manual-class"
              class="h-9 rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink"
            >
              <option v-if="!classes.length" value="">（暂无班级，先导入花名册）</option>
              <option v-for="c in classes" :key="c.name" :value="c.name">{{ c.name }}</option>
            </select>
            <input
              v-model="manualSubject"
              data-test="manual-subject"
              type="text"
              placeholder="科目（可空）"
              class="h-9 w-[160px] rounded-sm border border-hairline bg-canvas px-3 text-caption text-ink placeholder:text-weak"
            />
            <AppButton data-test="start-manual" :disabled="loading || !classes.length" @click="startManual">
              开临时课堂
            </AppButton>
          </div>
        </section>
      </div>
    </div>

    <!-- 课堂舞台：活动 Tab 按会话快照渲染 -->
    <LessonContextProvider v-else-if="ctx" :ctx="ctx">
      <div class="flex min-h-0 flex-1 flex-col" data-test="classroom-stage">
        <header class="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-white/5 px-6 py-3">
          <div class="flex min-w-0 items-center gap-3">
            <h1 class="truncate text-tagline font-semibold text-white">{{ headText }}</h1>
            <span class="shrink-0 whitespace-nowrap rounded-pill bg-white/15 px-2.5 py-1 text-fine text-white">
              {{ periodText }}
            </span>
            <span v-if="elapsedText" class="tnum shrink-0 whitespace-nowrap text-fine text-white/50" data-test="classroom-elapsed">
              已上课 {{ elapsedText }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <AppButton variant="pearl" data-test="classroom-exit" @click="leave">退出</AppButton>
            <AppButton
              variant="primary"
              data-test="classroom-end"
              :disabled="ending || session?.status === 'ended'"
              @click="endLesson"
            >
              {{ ending ? "结算中…" : "下课" }}
            </AppButton>
          </div>
        </header>

        <!-- 活动 Tab：来自本次会话快照（顺序即组合顺序） -->
        <nav class="flex shrink-0 items-center gap-1.5 border-b border-white/10 bg-white/5 px-6 py-2" data-test="activity-tabs">
          <button
            v-for="entry in ctx.activities"
            :key="entry.def.type"
            type="button"
            :data-test="`activity-tab-${entry.def.type}`"
            :aria-pressed="activeType === entry.def.type"
            class="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3 py-1.5 text-caption transition-colors duration-150"
            :class="activeType === entry.def.type ? 'bg-white/15 font-medium text-white' : 'text-white/60 hover:text-white'"
            @click="activeType = entry.def.type"
          >
            <AppIcon v-if="entry.def.icon" :name="entry.def.icon" :size="13" />
            {{ entry.def.title }}
          </button>
          <span v-if="!ctx.activities.length" class="text-caption text-white/60">本次课堂没有可用活动</span>
        </nav>

        <p
          v-if="fallbackText"
          data-test="activity-fallback"
          class="shrink-0 border-b border-divider bg-improve-soft px-6 py-1.5 text-fine text-improve"
        >
          {{ fallbackText }}
        </p>

        <!-- 活动面板：state 为 reduce 全量重放产物（null = 零事件，组件自行兜底空态） -->
        <div class="min-h-0 flex-1 overflow-hidden p-4" data-test="activity-panel">
          <component
            :is="activeEntry.def.component"
            v-if="activeEntry"
            :key="activeEntry.def.type"
            :state="ctx.activityState(activeEntry.def.type)"
            :config="ctx.activityConfig(activeEntry.def.type)"
          />
        </div>
      </div>
    </LessonContextProvider>

    <!-- 下课小结：数据版/AI 版（finishLesson 落库结果） -->
    <AppDialog
      :open="endOpen"
      title="下课小结"
      :description="endHeadline"
      width="lg"
      @close="leave"
    >
      <div data-test="end-dialog" class="max-h-[60vh] overflow-y-auto scroll-thin">
        <p v-if="ended" class="mb-2 text-fine text-weak">
          小结来源：{{ ended.digest_source === "ai" ? "AI 版" : "数据版" }}
        </p>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="endHtml" class="prose-sm text-caption text-muted" v-html="endHtml" />
      </div>
      <div class="mt-4 flex justify-end gap-2">
        <AppButton variant="pearl" data-test="end-stay" @click="endOpen = false">留在本页</AppButton>
        <AppButton data-test="end-return" @click="leave">返回</AppButton>
      </div>
    </AppDialog>
  </div>
</template>