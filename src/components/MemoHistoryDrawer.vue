<script setup lang="ts">
/**
 * 历史备忘抽屉：课表里记的备忘按日期倒序列出来，解决「过去日期的备忘看不到」。
 *
 * - 入口在「我的课表」页顶（不新增路由，保留课表上下文）
 * - 每条备忘还原「当时那节课」的背景（决策：实时推导、零迁移）：
 *   按 event_date 定位学期课表 + 当天调课例外 → 科目与班级；
 *   个人事件（不绑班级）取「我的科目」命中的班，班级事件取该班事实
 * - 筛选：类型胶囊 / 只看未完成 / 关键词 / 时间范围（全部 / 近 90 天）
 * - 勾选完成与删除即时落库；数据源仍是 calendar_events 一张表
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MemoTitle from "./MemoTitle.vue";
import {
  deleteCalendarEvent,
  listTeacherEventsInRange,
  listTimetableExceptionsWithClass,
  listTimetableSlotsWithClass,
  setCalendarEventDone,
} from "../lib/db";
import { fromDateStr, toDateStr } from "../lib/calendar";
import { ensureProfile, profile } from "../lib/profile";
import {
  CALENDAR_EVENT_META,
  CALENDAR_EVENT_TYPES,
  EXCEPTION_STATE_LABELS,
  currentSemester,
  eventPeriodLabel,
  mineOfClassResolver,
  resolveEventContexts,
  type EventContext,
} from "../lib/timetable";
import type {
  CalendarEvent,
  CalendarEventType,
  TimetableExceptionWithClass,
  TimetableSlotWithClass,
} from "../types";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

/** 时间范围：全部（默认）/ 近 90 天 */
const RANGE_DAYS = 90;
/** 查询哨兵区间：覆盖全部历史与未来（本地库事件量小，一次拉全量再前端过滤） */
const RANGE_START = "1970-01-01";
const RANGE_END = "2999-12-31";

const loading = ref(false);
const events = ref<CalendarEvent[]>([]);
const rows = ref<TimetableSlotWithClass[]>([]);
const exceptions = ref<TimetableExceptionWithClass[]>([]);

const typeFilter = ref<CalendarEventType | null>(null);
const onlyUndone = ref(false);
const keyword = ref("");
const range = ref<"all" | "recent">("all");

const todayStr = computed(() => toDateStr(new Date()));

/** 每班生效的「我的科目」判定器（口径与我的课表一致） */
const mineOf = computed(() => mineOfClassResolver(rows.value, profile.value.my_subjects ?? []));

/** 事件 → 当时那节课的背景（科目 / 班级，可能多班） */
const contexts = computed<Map<number, EventContext>>(() =>
  resolveEventContexts(events.value, rows.value, exceptions.value, mineOf.value)
);

async function load() {
  loading.value = true;
  try {
    await ensureProfile().catch(() => undefined);
    const all = await listTeacherEventsInRange(RANGE_START, RANGE_END);
    events.value = all;
    // 事件可能跨学期：按日期推导涉及的学期，逐学期取课表与调课例外
    const semesters = [
      ...new Set(all.map((e) => currentSemester(fromDateStr(e.event_date)))),
    ];
    const slots: TimetableSlotWithClass[] = [];
    const excs: TimetableExceptionWithClass[] = [];
    for (const semester of semesters) {
      const [slotList, excList] = await Promise.all([
        listTimetableSlotsWithClass(semester),
        listTimetableExceptionsWithClass(semester, RANGE_START, RANGE_END),
      ]);
      slots.push(...slotList);
      excs.push(...excList);
    }
    rows.value = slots;
    exceptions.value = excs;
  } catch {
    events.value = [];
    rows.value = [];
    exceptions.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  }
);

/* ---------------- 筛选与分组 ---------------- */

const filtered = computed(() => {
  const cutoff = toDateStr(
    new Date(Date.now() - RANGE_DAYS * 24 * 60 * 60 * 1000)
  );
  const kw = keyword.value.trim().toLowerCase();
  return events.value.filter((e) => {
    if (onlyUndone.value && e.done === 1) return false;
    if (typeFilter.value && e.type !== typeFilter.value) return false;
    if (range.value === "recent" && e.event_date < cutoff) return false;
    if (kw && !`${e.title ?? ""}${e.content}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});

const WEEKDAY_TEXT = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function dateLabel(date: string): string {
  const d = fromDateStr(date);
  const weekday = WEEKDAY_TEXT[(d.getDay() + 6) % 7];
  const text = `${d.getMonth() + 1}/${d.getDate()} ${weekday}`;
  return date === todayStr.value ? `${text}（今天）` : text;
}

/** 按日期倒序分组；组内按节次升序，全天事件沉到组尾 */
const groups = computed(() => {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of filtered.value) {
    const list = byDate.get(e.event_date) ?? [];
    list.push(e);
    byDate.set(e.event_date, list);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({
      date,
      label: dateLabel(date),
      events: [...list].sort(
        (a, b) => (a.period ?? 99) - (b.period ?? 99) || a.id - b.id
      ),
    }));
});

/** 「当时那节课」文本：第 N 节 / 全天 · 科目（调/停/加）· 班级 · 等 N 个班 */
function contextText(event: CalendarEvent): string {
  const parts = [eventPeriodLabel(event)];
  if (event.period == null) return parts[0];
  const ctx = contexts.value.get(event.id);
  const first = ctx?.sessions[0];
  if (first) {
    const stateLabel = EXCEPTION_STATE_LABELS[first.state];
    parts.push(`${first.subject}${stateLabel ? `（${stateLabel}）` : ""}`);
    parts.push(first.class_name);
    if (ctx && ctx.sessions.length > 1) parts.push(`等 ${ctx.sessions.length} 个班`);
  }
  return parts.join(" · ");
}

function toggleTypeFilter(type: CalendarEventType) {
  typeFilter.value = typeFilter.value === type ? null : type;
}

/* ---------------- 勾选 / 删除 ---------------- */

async function toggleEvent(event: CalendarEvent) {
  const next = event.done !== 1;
  await setCalendarEventDone(event.id, next);
  const target = events.value.find((e) => e.id === event.id);
  if (target) target.done = next ? 1 : 0;
}

async function removeEvent(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  events.value = events.value.filter((e) => e.id !== event.id);
}

/* ---------------- Esc 关闭 ---------------- */

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.open) emit("close");
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    v-if="props.open"
    data-test="memo-history-drawer"
    class="fixed inset-0 z-50 flex justify-end bg-black/30"
    @click.self="emit('close')"
  >
    <aside class="flex h-full w-[440px] max-w-full flex-col bg-canvas shadow-window">
      <!-- 头部 -->
      <header class="flex shrink-0 items-center justify-between border-b border-divider px-5 py-4">
        <div class="min-w-0">
          <h2 class="text-tagline font-semibold text-ink">历史备忘</h2>
          <p class="mt-0.5 text-fine text-weak">课表里记过的备忘都在这里，按日期倒序</p>
        </div>
        <button
          type="button"
          data-test="memo-history-close"
          class="shrink-0 text-caption text-weak hover:text-ink"
          @click="emit('close')"
        >
          关闭
        </button>
      </header>

      <!-- 筛选 -->
      <div class="shrink-0 space-y-2 border-b border-divider px-5 py-3">
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="t in CALENDAR_EVENT_TYPES"
            :key="t"
            type="button"
            data-test="memo-history-type"
            :aria-pressed="typeFilter === t"
            class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine transition-colors"
            :class="typeFilter === t ? 'border-ink bg-ink font-medium text-canvas' : 'border-hairline text-weak hover:border-ink'"
            @click="toggleTypeFilter(t)"
          >
            <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
            {{ CALENDAR_EVENT_META[t].label }}
          </button>
        </div>
        <div class="flex items-center gap-2">
          <input
            v-model="keyword"
            data-test="memo-history-search"
            type="search"
            placeholder="搜索备忘内容"
            class="h-7 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-2 text-fine text-ink outline-none focus:border-primary-focus"
          />
          <label class="flex shrink-0 items-center gap-1 text-fine text-muted">
            <input v-model="onlyUndone" data-test="memo-history-undone" type="checkbox" />
            只看未完成
          </label>
        </div>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            data-test="memo-history-range-all"
            class="rounded-pill px-2 py-0.5 text-fine transition-colors"
            :class="range === 'all' ? 'bg-pearl font-medium text-ink' : 'text-weak hover:text-ink'"
            @click="range = 'all'"
          >
            全部
          </button>
          <button
            type="button"
            data-test="memo-history-range-recent"
            class="rounded-pill px-2 py-0.5 text-fine transition-colors"
            :class="range === 'recent' ? 'bg-pearl font-medium text-ink' : 'text-weak hover:text-ink'"
            @click="range = 'recent'"
          >
            近 {{ RANGE_DAYS }} 天
          </button>
          <span class="ml-auto text-fine text-faint">共 {{ filtered.length }} 条</span>
        </div>
      </div>

      <!-- 列表 -->
      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <p v-if="loading" class="py-10 text-center text-caption text-weak">加载中…</p>
        <p v-else-if="!groups.length" class="py-10 text-center text-caption text-weak">
          没有符合条件的备忘
        </p>
        <div v-else class="space-y-4">
          <section v-for="group in groups" :key="group.date" data-test="memo-history-group">
            <h3 class="mb-1.5 text-fine font-medium text-weak">{{ group.label }}</h3>
            <ul class="space-y-px">
              <li
                v-for="e in group.events"
                :key="e.id"
                data-test="memo-history-item"
                class="group flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-pearl"
              >
                <button
                  type="button"
                  class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors"
                  :class="e.done ? 'border-primary bg-primary' : 'border-weak hover:border-primary'"
                  :aria-label="e.done ? '标记为待办' : '标记为已完成'"
                  @click="toggleEvent(e)"
                >
                  <svg v-if="e.done" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3 8.5l3.5 3.5L13 4.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <span
                  class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                  :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
                />
                <div class="min-w-0 flex-1">
                  <MemoTitle
                    :event="e"
                    class="min-w-0"
                    :class="e.done ? 'text-faint line-through' : 'text-ink'"
                  />
                  <p data-test="memo-history-context" class="mt-0.5 truncate text-fine text-faint">
                    {{ contextText(e) }}
                  </p>
                </div>
                <button
                  type="button"
                  class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                  aria-label="删除备忘"
                  @click="removeEvent(e)"
                >
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </aside>
  </div>
</template>
