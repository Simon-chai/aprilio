<script setup lang="ts">
/**
 * 点名台面板（picker 活动的 UI）。
 *
 * 交互照原型「点名台」：
 * - 抽取模式：均匀随机 / 关注沉默（按未点天数平方加权，利用 ctx.daysSincePicked 跨会话读模型）
 * - 大名字滚动动画 → 落定高亮 → emit pick 事件（事件流是唯一事实源）
 * - 已点名单（含每人次数）可逐条撤销（找到该 pick 事件 id → ctx.revoke）
 * - 点名池列出未点学生，点名字 = 手动点名（mode: hand）
 *
 * 状态来自框架重放产物（props.state）；为 null（本节课零事件）时用 emptyPickerState 渲染空态。
 */
import { computed, onUnmounted, ref } from "vue";
import AppButton from "../ui/AppButton.vue";
import AppIcon from "../ui/AppIcon.vue";
import AppIconButton from "../ui/AppIconButton.vue";
import { useLessonContext } from "../../classroom/context";
import {
  emptyPickerState,
  SILENCE_CAP_DAYS,
  silenceWeight,
  weightedIndex,
} from "../../classroom/activities/picker.activity";
import type { PickerMode, PickerPick, PickerState } from "../../classroom/activities/picker.activity";
import type { ClassroomStudent } from "../../classroom/types";

const props = defineProps<{
  state: PickerState | null;
  config: Record<string, unknown>;
}>();

const ctx = useLessonContext();

/** 滚动动画时长 / 名字跳帧间隔（毫秒） */
const ROLL_MS = 700;
const FLICKER_MS = 60;

const MODE_OPTIONS: Array<{ value: PickerMode; label: string; tip: string }> = [
  { value: "random", label: "均匀随机", tip: "点名池内每位同学等概率被抽中" },
  {
    value: "weighted",
    label: "关注沉默",
    tip: `权重 = min(未点天数, ${SILENCE_CAP_DAYS}) 的平方 · 最久未被点的优先`,
  },
];

const MODE_LABEL: Record<PickerMode, string> = {
  random: "均匀随机",
  weighted: "关注沉默",
  hand: "手动点名",
};

/** config 透传：可给 picker 指定默认抽取模式（框架不解释 config 内容） */
function readDefaultMode(config: Record<string, unknown>): PickerMode {
  const mode = config?.mode;
  return mode === "weighted" || mode === "hand" ? mode : "random";
}

const mode = ref<PickerMode>(readDefaultMode(props.config));

/** 状态恒非空：零事件时用上下文推导空态（点名池 = 全班在班学生） */
const view = computed<PickerState>(() => props.state ?? emptyPickerState(ctx));

const inClassCount = computed(() => ctx.students.length);
const coveredCount = computed(() => Math.round(view.value.coverage * inClassCount.value));
const coveragePct = computed(() => `${Math.min(100, Math.round(view.value.coverage * 100))}%`);
/** 拆解「点名池」，点到全员后自动重开一轮（轮询语义，照原型） */
const pool = computed(() => (view.value.pool.length ? view.value.pool : ctx.students));
const roundRestarted = computed(() => view.value.pool.length === 0 && ctx.students.length > 0);

const displayName = ref("准备好了吗？");
const rolling = ref(false);
const hint = ref("");
const lastPick = ref<PickerPick | null>(null);

let flickerTimer: ReturnType<typeof setInterval> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function stopTimers() {
  if (flickerTimer !== null) clearInterval(flickerTimer);
  if (settleTimer !== null) clearTimeout(settleTimer);
  flickerTimer = null;
  settleTimer = null;
}

onUnmounted(stopTimers);

/** 「距上次被点」文案 */
function daysText(days: number | null): string {
  if (days === null) return "从未被点到";
  if (days <= 0) return "今天被点到";
  return `${days} 天未点`;
}

/** 当前模式的抽样权重：沉默模式按未点天数平方加权，其余等权 */
function weightsOf(candidates: ClassroomStudent[]): number[] {
  if (mode.value !== "weighted") return candidates.map(() => 1);
  return candidates.map((s) => silenceWeight(ctx.daysSincePicked(s.id)));
}

/** 抽取（target 传入 = 手动点名，mode: hand） */
function roll(target?: ClassroomStudent) {
  if (rolling.value) return;
  if (!ctx.students.length) {
    ctx.ui.toast("本班当前无在班学生，无法点名", { tone: "error" });
    return;
  }
  const candidates = pool.value;
  if (!candidates.length) return;
  if (roundRestarted.value) ctx.ui.toast("全员已点完 · 轮询重新开始");

  const winner = target ?? candidates[weightedIndex(weightsOf(candidates), Math.random())];
  const pickedMode: PickerMode = target ? "hand" : mode.value;

  rolling.value = true;
  hint.value = "";
  lastPick.value = null;
  displayName.value = candidates[0]?.name ?? winner.name;
  stopTimers();
  flickerTimer = setInterval(() => {
    const random = candidates[Math.floor(Math.random() * candidates.length)];
    if (random) displayName.value = random.name;
  }, FLICKER_MS);
  settleTimer = setTimeout(() => void settle(winner, pickedMode), ROLL_MS);
}

/** 落定：写事件（框架统一入流并广播）→ 高亮展示 + 沉默提示 */
async function settle(winner: ClassroomStudent, pickedMode: PickerMode) {
  stopTimers();
  rolling.value = false;
  displayName.value = winner.name;
  const days = ctx.daysSincePicked(winner.id);
  // payload.weight = 本次抽样权重：均匀随机恒为 1；沉默模式为未点天数权重；手动点名不带权重
  const weight =
    pickedMode === "weighted"
      ? Math.round(silenceWeight(days) * 100) / 100
      : pickedMode === "random"
        ? 1
        : undefined;
  try {
    const saved = await ctx.emit({
      activity: "picker",
      kind: "pick",
      student_id: winner.id,
      payload: weight === undefined ? { mode: pickedMode } : { mode: pickedMode, weight },
    });
    lastPick.value = {
      event_id: saved.id,
      student_id: winner.id,
      student_name: winner.name,
      occurred_at: saved.occurred_at,
      mode: pickedMode,
      weight,
    };
  } catch (e) {
    console.error("[picker] 点名事件写入失败", e);
    ctx.ui.toast("点名未写入，请重试", { tone: "error" });
    return;
  }
  hint.value =
    days === null || days >= 7
      ? `${daysText(days)} · 建议优先关注`
      : `${daysText(days)} · 本节课已点 ${view.value.stats.find((s) => s.student_id === winner.id)?.count ?? 1} 次`;
  ctx.ui.toast(`${winner.name} · 已点名`);
}

/** 撤销一次点名：框架标记 revoked 后全量重放，池与覆盖率随之回滚 */
async function undo(pick: PickerPick) {
  try {
    await ctx.revoke(pick.event_id);
  } catch (e) {
    console.error("[picker] 撤销点名失败", e);
    ctx.ui.toast("撤销失败，请重试", { tone: "error" });
    return;
  }
  if (lastPick.value?.event_id === pick.event_id) lastPick.value = null;
  ctx.ui.toast(`已撤销 ${pick.student_name} 的点名`);
}

/** 每人被点次数（名单 chip 上的 ×N） */
function countOf(studentId: number): number {
  return view.value.stats.find((s) => s.student_id === studentId)?.count ?? 1;
}
</script>

<template>
  <div class="flex h-full min-h-0 w-full gap-4">
    <!-- 左栏：抽取模式 + 覆盖率 + 已点名单 + 沉默预警 -->
    <aside class="flex w-[260px] shrink-0 flex-col overflow-y-auto rounded-lg border border-white/10 bg-white/5 scroll-thin">
      <div class="px-4 pt-3.5 pb-2 text-caption font-semibold text-white">抽取模式</div>
      <div class="flex flex-col gap-1.5 px-4">
        <button
          v-for="opt in MODE_OPTIONS"
          :key="opt.value"
          type="button"
          :title="opt.tip"
          :data-test="`pick-mode-${opt.value}`"
          class="rounded-sm border px-3 py-1.5 text-left text-fine transition-colors duration-150"
          :class="
            mode === opt.value
              ? 'bg-white/15 text-white'
              : 'border-white/10 bg-white/5 text-white/70 hover:border-white/40'
          "
          @click="mode = opt.value"
        >
          {{ opt.label }}
        </button>
      </div>

      <div class="flex items-center justify-between px-4 pt-4 pb-1.5 text-caption">
        <span class="font-semibold text-white">本节课点名</span>
        <span class="text-fine text-white/50" data-test="pick-coverage">
          已覆盖 {{ coveredCount }} / {{ inClassCount }} 人
        </span>
      </div>
      <div class="mx-4 h-1.5 overflow-hidden rounded-pill bg-white/15">
        <span class="block h-full rounded-pill bg-primary-on-dark transition-[width] duration-300" :style="{ width: coveragePct }" />
      </div>

      <div class="px-4 pt-4 pb-2 text-caption font-semibold text-white">已点名单</div>
      <div class="flex flex-wrap gap-1.5 px-4 pb-3" data-test="pick-called-list">
        <span
          v-for="pick in view.called"
          :key="pick.event_id"
          data-test="pick-called-chip"
          class="inline-flex items-center gap-1 rounded-pill border border-white/10 bg-white/10 py-0.5 pr-0.5 pl-2.5 text-fine text-white/70"
        >
          {{ pick.student_name }}
          <b v-if="countOf(pick.student_id) > 1" class="font-semibold text-primary-on-dark">×{{ countOf(pick.student_id) }}</b>
          <AppIconButton label="撤销这次点名" size="sm" tone="danger" @click="undo(pick)">
            <AppIcon name="close" :size="12" />
          </AppIconButton>
        </span>
        <p v-if="!view.called.length" class="text-fine text-white/50" data-test="pick-called-empty">
          还没点过，抽一个试试
        </p>
      </div>

      <div class="flex items-center gap-2 border-t border-white/10 px-4 pt-3 pb-2 text-caption font-semibold text-white">
        沉默预警 <span class="text-fine font-normal text-white/50">最久未点</span>
      </div>
      <div class="px-4 pb-4" data-test="pick-silent-list">
        <div
          v-for="s in view.silent.slice(0, 6)"
          :key="s.student_id"
          data-test="pick-silent-row"
          class="flex items-center gap-2 border-b border-white/10 py-1.5 text-fine last:border-b-0"
        >
          <b class="font-medium text-white/70">{{ s.student_name }}</b>
          <span
            class="ml-auto tabular-nums"
            :class="s.days === null || s.days >= 10 ? 'font-semibold text-improve-on-dark' : 'text-white/50'"
          >
            {{ daysText(s.days) }}
          </span>
        </div>
        <p v-if="!view.silent.length" class="text-fine text-white/50">暂无在班学生</p>
      </div>
    </aside>

    <!-- 中栏：大名字抽取台 -->
    <div class="flex min-w-0 flex-1 flex-col rounded-lg border border-white/10 bg-white/5">
      <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-8">
        <span
          class="rounded-pill bg-primary-soft px-3 py-1 text-fine font-semibold text-primary"
          data-test="pick-mode-chip"
        >
          {{ MODE_LABEL[mode] }}
        </span>
        <div
          class="text-hero font-bold"
          :class="rolling ? 'text-white' : lastPick ? 'text-primary-on-dark' : 'text-white/70'"
          data-test="pick-name"
        >
          {{ displayName }}
        </div>
        <p v-if="hint" class="rounded-pill bg-ai-soft px-3 py-1 text-fine text-ai" data-test="pick-hint">
          {{ hint }}
        </p>
        <div class="flex flex-col items-center gap-2">
          <AppButton data-test="pick-roll" :disabled="rolling || !inClassCount" @click="roll()">
            {{ rolling ? "抽取中…" : lastPick ? "再抽一个" : "开始抽取" }}
          </AppButton>
          <p class="text-fine text-white/50">点名落定后，可在座位台为这位同学记表现</p>
        </div>
      </div>

      <!-- 点名池：点名字 = 手动点名 -->
      <div class="border-t border-white/10 px-4 py-3">
        <div class="flex items-center gap-2 text-caption font-semibold text-white">
          点名池
          <span class="text-fine font-normal text-white/50" data-test="pick-pool-hint">
            未点 {{ view.pool.length }} 人 · 点名字可直接点他（手动）
          </span>
        </div>
        <div class="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto scroll-thin" data-test="pick-pool">
          <button
            v-for="s in pool"
            :key="s.id"
            type="button"
            data-test="pick-pool-item"
            class="rounded-pill border border-white/10 bg-white/5 px-2.5 py-1 text-fine text-white/70 transition-colors duration-150 hover:border-white/40 hover:text-white"
            @click="roll(s)"
          >
            {{ s.name }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>