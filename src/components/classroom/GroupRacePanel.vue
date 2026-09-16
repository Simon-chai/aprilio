<script setup lang="ts">
/**
 * 小组积分赛面板（group-race 活动的 UI）。
 *
 * 交互照原型「小组积分赛」：
 * - 每组一张积分卡（组名 / 成员首字 / 本节课分数 / 分数变化流水）
 * - 加减分按钮（delta 档位可经 config.deltaPresets 定制，默认 ＋1 / －1）→ emit group_point
 * - 理由胶囊「发言 / 纪律 / 合作 / 作业」+ 自定义理由输入（非空时优先）
 * - 领先组（最高分且 > 0，并列同标）高亮；加/减分后分数做一次弹跳反馈
 * - 「撤销刚才的加分」→ ctx.revoke(最近一条 group_point 事件 id)
 *
 * 分数永远是事件聚合值，本组件不持有任何独立分值态（不落独立分值表）。
 */
import { computed, onUnmounted, ref } from "vue";
import AppButton from "../ui/AppButton.vue";
import AppIcon from "../ui/AppIcon.vue";
import AppIconButton from "../ui/AppIconButton.vue";
import AppInput from "../ui/AppInput.vue";
import { useLessonContext } from "../../classroom/context";
import {
  emptyGroupRaceState,
  type GroupRaceGroup,
  type GroupRaceState,
} from "../../classroom/activities/group-race.activity";

const props = defineProps<{
  state: GroupRaceState | null;
  config: Record<string, unknown>;
}>();

const ctx = useLessonContext();

/** 加分理由胶囊（照原型的四类） */
const REASONS = ["发言", "纪律", "合作", "作业"];

/** 分数弹跳反馈时长（毫秒） */
const BUMP_MS = 320;

/** config 透传：deltaPresets 定制加减分档位（框架不解释 config 内容） */
function readDeltas(config: Record<string, unknown>): number[] {
  const raw = config?.deltaPresets;
  if (Array.isArray(raw)) {
    const list = raw.filter(
      (d): d is number => typeof d === "number" && Number.isFinite(d) && d !== 0,
    );
    if (list.length) return list;
  }
  return [1, -1];
}

const deltas = readDeltas(props.config);
const reason = ref(REASONS[0]);
const customReason = ref("");

/** 状态恒非空：零事件时用上下文推导空态（各组 0 分） */
const view = computed<GroupRaceState>(() => props.state ?? emptyGroupRaceState(ctx));

const bumped = ref<number[]>([]);
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
onUnmounted(() => {
  if (bumpTimer !== null) clearTimeout(bumpTimer);
});

const lastPoint = computed(() => view.value.points[view.value.points.length - 1] ?? null);

function isLeader(group: GroupRaceGroup): boolean {
  return group.score > 0 && group.score === view.value.leader_score;
}

/** 本次操作使用的理由：自定义非空则优先 */
function effectiveReason(): string {
  return customReason.value.trim() || reason.value;
}

/** 选理由胶囊：同时清空自定义理由（避免用户看不到自己选了哪类） */
function chooseReason(value: string) {
  reason.value = value;
  customReason.value = "";
}

function markBumped(groupNo: number) {
  bumped.value = [...bumped.value, groupNo];
  if (bumpTimer !== null) clearTimeout(bumpTimer);
  bumpTimer = setTimeout(() => {
    bumped.value = [];
  }, BUMP_MS);
}

/** 加减分：写事件（事件流唯一事实源），分数由重放产物回填 */
async function point(group: GroupRaceGroup, delta: number) {
  const text = effectiveReason();
  try {
    await ctx.emit({
      activity: "group-race",
      kind: "group_point",
      payload: { group_no: group.group_no, delta, reason: text },
    });
  } catch (e) {
    console.error("[group-race] 小组加分写入失败", e);
    ctx.ui.toast("加分未写入，请重试", { tone: "error" });
    return;
  }
  markBumped(group.group_no);
  ctx.ui.toast(`${group.name} ${delta > 0 ? `+${delta}` : delta} · ${text}`);
}

/** 撤销刚才一次加分：重放后分数回退 */
async function undo() {
  const target = view.value.last_event_id;
  if (target === null) return;
  try {
    await ctx.revoke(target);
  } catch (e) {
    console.error("[group-race] 撤销加分失败", e);
    ctx.ui.toast("撤销失败，请重试", { tone: "error" });
    return;
  }
  ctx.ui.toast("已撤销刚才一次小组加分");
}
</script>

<template>
  <div class="flex h-full min-h-0 w-full flex-col gap-3">
    <!-- 工具栏：理由 + 本节课总分 + 撤销 -->
    <div class="flex items-center gap-2 overflow-x-auto rounded-lg border border-white/10 bg-white/5 px-4 py-3 scrollbar-none">
      <span class="shrink-0 text-caption font-semibold text-white">加分理由</span>
      <button
        v-for="r in REASONS"
        :key="r"
        type="button"
        :data-test="`group-reason-${r}`"
        class="shrink-0 rounded-pill border px-2.5 py-1 text-fine transition-colors duration-150"
        :class="
          reason === r && !customReason.trim()
            ? 'bg-white/15 text-white'
            : 'border-white/10 bg-white/5 text-white/70 hover:border-white/40'
        "
        @click="chooseReason(r)"
      >
        {{ r }}
      </button>
      <div class="shrink-0">
        <AppInput v-model="customReason" data-test="group-reason-custom" variant="field" width="170px" placeholder="自定义理由（优先）" />
      </div>
      <span class="ml-auto shrink-0 text-fine text-white/50" data-test="group-total">
        本节课共 {{ view.total_points }} 分
      </span>
      <AppIconButton
        data-test="group-undo"
        label="撤销刚才的加分"
        tone="danger"
        size="sm"
        :disabled="view.last_event_id === null"
        @click="undo"
      >
        <AppIcon name="restore" :size="13" />
      </AppIconButton>
    </div>

    <!-- 小组积分卡 -->
    <div class="min-h-0 flex-1 overflow-y-auto scroll-thin">
      <div
        v-if="view.groups.length"
        class="grid grid-cols-2 gap-3 lg:grid-cols-3"
        data-test="group-board"
      >
        <article
          v-for="g in view.groups"
          :key="g.group_no"
          :data-test="`group-card-${g.group_no}`"
          class="flex flex-col gap-2 rounded-lg border p-4"
          :class="isLeader(g) ? 'border-improve-line bg-white/15' : 'border-white/10 bg-white/5'"
        >
          <header class="flex items-center gap-2 text-caption font-semibold text-white">
            <span>{{ g.name }}</span>
            <span v-if="isLeader(g)" class="text-fine text-improve-on-dark" data-test="group-lead-badge">领先</span>
            <span class="ml-auto text-fine font-normal text-white/50">{{ g.members.length }} 人</span>
          </header>

          <div class="flex flex-wrap gap-1">
            <span
              v-for="m in g.members"
              :key="m.id"
              class="inline-flex h-6 w-6 items-center justify-center rounded-pill bg-white/15 text-fine font-semibold text-white/70"
              :title="m.name"
            >
              {{ m.name.slice(0, 1) }}
            </span>
            <span v-if="!g.members.length" class="text-fine text-white/50">未入座</span>
          </div>

          <div
            :data-test="`group-score-${g.group_no}`"
            class="origin-left text-stat font-bold tabular-nums text-white transition-transform duration-150"
            :class="bumped.includes(g.group_no) ? 'scale-110' : 'scale-100'"
          >
            {{ g.score }}
          </div>

          <div class="flex flex-wrap gap-1.5">
            <AppButton
              v-for="d in deltas"
              :key="d"
              :data-test="`group-point-${g.group_no}-${d > 0 ? 'p' : 'm'}${Math.abs(d)}`"
              :variant="d > 0 ? 'pearl' : 'secondary'"
              @click="point(g, d)"
            >
              {{ d > 0 ? `＋${d}` : `－${-d}` }}
            </AppButton>
          </div>

          <p v-if="g.history.length" class="text-fine text-white/50" data-test="group-last-point">
            最近 {{ g.history[g.history.length - 1].delta > 0 ? "+" : "" }}{{ g.history[g.history.length - 1].delta }}
            · {{ g.history[g.history.length - 1].reason }}
          </p>
        </article>
      </div>

      <p v-else class="rounded-lg border border-white/10 bg-white/5 p-6 text-caption text-white/50">
        本班尚无座位分组，先排座位再开小组积分赛。
      </p>

      <!-- 本节课加减分流水（撤销目标可回看） -->
      <div v-if="lastPoint" class="mt-3 rounded-lg border border-white/10 bg-white/10 px-4 py-3">
        <span class="text-fine text-white/50">最近一条加减分：</span>
        <span class="text-fine text-white/70">
          第 {{ lastPoint.group_no }} 组 {{ lastPoint.delta > 0 ? `+${lastPoint.delta}` : lastPoint.delta }}
          · {{ lastPoint.reason }} · 该组累计 {{ lastPoint.score_after }} 分
        </span>
      </div>
    </div>
  </div>
</template>