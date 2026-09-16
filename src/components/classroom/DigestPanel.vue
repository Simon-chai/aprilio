<script setup lang="ts">
/**
 * 实时小结面板（digest 活动 UI，只读）。
 *
 * - 统计：computeLessonStats 纯函数（roster = 全班在册含缺勤、events = 事件流、沉默读模型来自 Context）
 * - 时间线：事件流倒序（点名 / 记表现 / 缺勤 / 小组分 / 调座）
 * - 「生成小结」：generateLessonDigest（AI 优先，未配置/演示态/失败 → 数据版），仅预览不落库；
 *   落库在下课编排 finishLesson 里完成
 */
import { computed, ref } from "vue";
import AppButton from "../ui/AppButton.vue";
import { useLessonContext } from "../../classroom/context";
import { computeLessonStats, generateLessonDigest } from "../../classroom/digest";
import { renderMarkdown } from "../../lib/markdown";
import { BEHAVIOR_POLARITY_LABEL } from "../../types";
import type { ClassroomStudent, LessonEvent } from "../../classroom/types";
import type { DigestActivityState } from "../../classroom/activities/digest.activity";

const props = defineProps<{
  state: DigestActivityState | null;
  config?: Record<string, unknown>;
}>();

const ctx = useLessonContext();

const events = computed(() => props.state?.events ?? []);

/** 全班在册（含缺勤）：ctx.students 是在班名单，缺勤学生从座位网格补齐 */
const roster = computed<ClassroomStudent[]>(() => {
  const map = new Map<number, ClassroomStudent>();
  for (const s of ctx.students) map.set(s.id, s);
  for (const row of ctx.seating.cells) {
    for (const stu of row) {
      if (stu && !map.has(stu.id)) map.set(stu.id, stu);
    }
  }
  return [...map.values()];
});

const stats = computed(() =>
  computeLessonStats({
    session: ctx.session,
    roster: roster.value,
    events: events.value,
    daysSincePicked: ctx.daysSincePicked,
  }),
);

const pickTotal = computed(() => stats.value.picks.reduce((sum, p) => sum + p.count, 0));
const coveragePercent = computed(() => `${Math.round(stats.value.pick_coverage * 100)}%`);
const leader = computed(() => {
  const top = stats.value.groups.reduce<{ group_no: number; score: number } | null>(
    (best, g) => (g.score > (best?.score ?? 0) ? g : best),
    null,
  );
  return top && top.score > 0 ? top : null;
});

/* ---------------- 时间线 ---------------- */

const nameOf = computed(() => new Map(roster.value.map((s) => [s.id, s.name])));

function describe(ev: LessonEvent): string {
  const name = ev.student_id != null ? (nameOf.value.get(ev.student_id) ?? `#${ev.student_id}`) : "";
  if (ev.kind === "pick") return `点名 · ${name}`;
  if (ev.kind === "behavior") {
    const type = typeof ev.payload?.type === "string" ? ev.payload.type : "neutral";
    const dimensionId = Number(ev.payload?.dimension_id);
    const dimension = ctx.dimensions.find((d) => d.id === dimensionId)?.name ?? "表现";
    return `${name} · ${dimension} · ${BEHAVIOR_POLARITY_LABEL[type as keyof typeof BEHAVIOR_POLARITY_LABEL] ?? "记录"}`;
  }
  if (ev.kind === "attendance") return `${name} · ${ev.payload?.absent === true ? "缺勤" : "归班"}`;
  if (ev.kind === "group_point") {
    const groupNo = Number(ev.payload?.group_no);
    const delta = Number(ev.payload?.delta);
    const reason = typeof ev.payload?.reason === "string" && ev.payload.reason ? ` · ${ev.payload.reason}` : "";
    return `第 ${groupNo} 组 ${delta >= 0 ? "+" : ""}${delta}${reason}`;
  }
  if (ev.kind === "seat_change") return `${name} · 调座`;
  // 未知 kind 安全展示，不崩溃（新活动零冲突接入）
  return `${name ? `${name} · ` : ""}${ev.kind}`;
}

const MAX_TIMELINE = 20;

const timeline = computed(() =>
  events.value
    .slice(-MAX_TIMELINE)
    .reverse()
    .map((ev) => ({
      id: ev.id,
      text: describe(ev),
      time: ev.occurred_at.slice(11, 16),
    })),
);

/* ---------------- 小结生成（预览） ---------------- */

const previewMd = ref("");
const previewSource = ref<"ai" | "data" | null>(null);
const generating = ref(false);

const previewHtml = computed(() => (previewMd.value ? renderMarkdown(previewMd.value) : ""));

async function onGenerate() {
  generating.value = true;
  try {
    const res = await generateLessonDigest({
      session: ctx.session,
      roster: roster.value,
      events: events.value,
      daysSincePicked: ctx.daysSincePicked,
    });
    previewMd.value = res.digest_md;
    previewSource.value = res.digest_source;
    ctx.ui.toast(res.digest_source === "ai" ? "已生成 AI 版小结" : "已生成数据版小结（未配置 AI）");
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), { tone: "error" });
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4" data-test="digest-panel">
    <div class="grid grid-cols-4 gap-3">
      <div class="rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-stat" data-test="digest-pick-count">{{ pickTotal }}</p>
        <p class="text-fine text-white/50">
          点名人次 · 覆盖 {{ stats.picks.length }} 人（{{ coveragePercent }}）
        </p>
      </div>
      <div class="rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-stat text-praise-on-dark" data-test="digest-praise-count">{{ stats.praise_count }}</p>
        <p class="text-fine text-white/50">表扬记录</p>
      </div>
      <div class="rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-stat text-improve-on-dark" data-test="digest-improve-count">
          {{ stats.improve_count }}
        </p>
        <p class="text-fine text-white/50">待改进记录</p>
      </div>
      <div class="rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-stat text-white" data-test="digest-leader">
          {{ leader ? `第 ${leader.group_no} 组` : "—" }}
        </p>
        <p class="text-fine text-white/50">小组领先 · {{ leader ? `${leader.score} 分` : "暂无加分" }}</p>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-2 gap-4">
      <div class="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/5 p-3">
        <p class="text-caption font-semibold text-white">
          本节课时间线 <span class="text-fine font-normal text-white/50">{{ events.length }} 条</span>
        </p>
        <div class="scroll-thin mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          <div
            v-for="row in timeline"
            :key="row.id"
            class="flex items-center gap-2 text-fine"
            data-test="digest-timeline-row"
          >
            <span class="min-w-0 flex-1 truncate text-white/70">{{ row.text }}</span>
            <span class="shrink-0 text-white/35">{{ row.time }}</span>
          </div>
          <p v-if="!timeline.length" class="text-fine text-white/50">本节课暂无记录</p>
        </div>
      </div>

      <div class="flex min-h-0 flex-col gap-3">
        <div class="rounded-lg border border-white/10 bg-white/5 p-3">
          <p class="text-caption font-semibold text-white">沉默预警</p>
          <p v-if="stats.silent.length" class="mt-2 flex flex-wrap gap-1.5" data-test="digest-silent">
            <span
              v-for="s in stats.silent"
              :key="s.student_id"
              class="rounded-pill bg-white/10 px-2 py-0.5 text-fine text-white/70"
            >
              {{ s.student_name }}
              <span class="text-white/50">
                {{ s.days === null ? "从未被点到" : `${s.days} 天未被点到` }}
              </span>
            </span>
          </p>
          <p v-else class="mt-2 text-fine text-praise-on-dark" data-test="digest-silent">
            本节课无沉默预警，参与度良好
          </p>
        </div>

        <div class="rounded-lg border border-white/10 bg-white/5 p-3">
          <p class="text-caption font-semibold text-white">缺勤与小组分</p>
          <p class="mt-2 text-fine text-white/50" data-test="digest-absent">
            缺勤：{{ stats.absent.length ? stats.absent.map((a) => a.student_name).join("、") : "无" }}
          </p>
          <div class="mt-2 flex flex-wrap gap-1.5" data-test="digest-groups">
            <span
              v-for="g in stats.groups"
              :key="g.group_no"
              class="rounded-pill bg-white/10 px-2 py-0.5 text-fine text-white/70"
            >
              第 {{ g.group_no }} 组 <span class="text-primary-on-dark">{{ g.score }}</span>
            </span>
            <span v-if="!stats.groups.length" class="text-fine text-white/50">暂无小组数据</span>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-white/5 p-3">
          <div class="flex items-center justify-between gap-2">
            <p class="text-caption font-semibold text-white">
              课堂小结
              <span v-if="previewSource" class="text-fine font-normal text-white/50">
                {{ previewSource === "ai" ? "AI 生成" : "数据版" }}
              </span>
            </p>
            <AppButton :disabled="generating" data-test="digest-generate" @click="onGenerate">
              {{ generating ? "生成中…" : "生成小结" }}
            </AppButton>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-if="previewHtml"
            class="scroll-thin prose-sm mt-2 min-h-0 flex-1 overflow-y-auto text-fine text-white"
            data-test="digest-preview"
            v-html="previewHtml"
          />
          <p v-else class="mt-2 text-fine text-white/50">
            点「生成小结」预览本节课小结；下课存档时自动写入（未配置 AI 时用数据版）。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>