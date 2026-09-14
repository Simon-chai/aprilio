<script setup lang="ts">
/**
 * 我的万年历（教师维度）：跨班聚合的「我的课」+ 教师日程在月历上的投影。
 *
 * - light（/timetable「日历」tab）：月历 + 右侧日详情，可速记 / 勾选 / 删除日程
 * - dark（首页课表面板「日历」）：紧凑月历 + 选中日详情，只读
 *
 * 数据与周课表同源：课程 = buildMyDays（周课表套当天调课例外、按「我的科目」过滤，
 * 跨班聚合，纯投影不落库）；日程 = listTeacherEventsInRange（班级事件 + 个人事件自动合并）。
 * 日历只做「看」与「记日程」，不写课表与调课例外。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppLink from "./ui/AppLink.vue";
import EventTypeSelect from "./EventTypeSelect.vue";
import MemoTitle from "./MemoTitle.vue";
import {
  addCalendarEvent,
  deleteCalendarEvent,
  listTeacherEventsInRange,
  listTimetableExceptionsWithClass,
  setCalendarEventDone,
  setCalendarEventTitle,
} from "../lib/db";
import {
  CALENDAR_WEEKDAY_LABELS,
  buildMonthGrid,
  fromDateStr,
  gridRange,
  monthTitle,
  shiftMonth,
  toDateStr,
  type CalendarCell,
} from "../lib/calendar";
import { summarizeMemoTitle } from "../lib/memo-ai";
import {
  CALENDAR_EVENT_META,
  CALENDAR_EVENT_TYPES,
  EXCEPTION_STATE_LABELS,
  buildMyDays,
  currentSemester,
  eventPeriodLabel,
  subjectChipClass,
  subjectGlassBlockClass,
  type MineOfClass,
  type MyDaySession,
} from "../lib/timetable";
import type {
  CalendarEvent,
  CalendarEventType,
  TimetableExceptionWithClass,
  TimetableSlotWithClass,
} from "../types";

const props = withDefaults(
  defineProps<{
    /** 当前学期全部班级的课表格子（父级已加载，跨班） */
    rows: TimetableSlotWithClass[];
    /** 「我的科目」判定器（班级三态标记 + 全局任教学科） */
    mineOf: MineOfClass;
    /** light = 页面卡片（/timetable）；dark = 首页毛玻璃面板内的紧凑深色版 */
    variant?: "light" | "dark";
    /** light：是否可速记 / 勾选 / 删除日程（首页 dark 恒只读） */
    editable?: boolean;
    /** light：课表背景图样式（与周课表卡同款，铺在月历卡表面） */
    surfaceClass?: string;
    surfaceStyle?: Record<string, string>;
  }>(),
  { variant: "light", editable: false, surfaceClass: "", surfaceStyle: undefined }
);

const emit = defineEmits<{ changed: [] }>();

const router = useRouter();
const isDark = computed(() => props.variant === "dark");
const editable = computed(() => props.editable && !isDark.value);

const SEMESTER = currentSemester();
const now = new Date();
const today = toDateStr(now);
const viewYear = ref(now.getFullYear());
const viewMonth = ref(now.getMonth() + 1);
const selectedDate = ref(today);

const grid = computed(() => buildMonthGrid(viewYear.value, viewMonth.value));
const flatGrid = computed(() => grid.value.flat());
const title = computed(() => monthTitle(viewYear.value, viewMonth.value));

/* ---------------- 课程：周课表 + 调课例外 → 每天的实际行程（我的课） ---------------- */

const exceptions = ref<TimetableExceptionWithClass[]>([]);
const events = ref<CalendarEvent[]>([]);

const myDays = computed(() =>
  buildMyDays(
    props.rows,
    exceptions.value,
    props.mineOf,
    flatGrid.value.map((c) => c.date)
  )
);

/** 某天的全部课程（按节次升序） */
function sessionsOn(date: string): MyDaySession[] {
  return myDays.value.get(date) ?? [];
}

/* ---------------- 日程：班级事件 + 个人事件（教师维度自动合并） ---------------- */

const eventsByDate = computed<Map<string, CalendarEvent[]>>(() => {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events.value) {
    const list = map.get(e.event_date) ?? [];
    list.push(e);
    map.set(e.event_date, list);
  }
  return map;
});

/** 某天日程：节次升序、全天沉底（与班级日历同口径） */
function eventsOn(date: string): CalendarEvent[] {
  return [...(eventsByDate.value.get(date) ?? [])].sort(
    (a, b) => (a.period ?? 99) - (b.period ?? 99) || a.id - b.id
  );
}

async function reloadMonth() {
  const { start, end } = gridRange(grid.value);
  try {
    exceptions.value = await listTimetableExceptionsWithClass(SEMESTER, start, end);
  } catch {
    exceptions.value = [];
  }
  try {
    events.value = await listTeacherEventsInRange(start, end);
  } catch {
    events.value = [];
  }
}

/* ---------------- 月份导航 ---------------- */

function shift(delta: number) {
  const next = shiftMonth(viewYear.value, viewMonth.value, delta);
  viewYear.value = next.year;
  viewMonth.value = next.month;
}

function backToToday() {
  viewYear.value = now.getFullYear();
  viewMonth.value = now.getMonth() + 1;
  selectedDate.value = today;
}

watch([viewYear, viewMonth], () => {
  // 翻页后选中日不在当前网格里 → 落到该月 1 号，右侧详情不悬空
  if (!flatGrid.value.some((c) => c.date === selectedDate.value)) {
    selectedDate.value = toDateStr(new Date(viewYear.value, viewMonth.value - 1, 1));
  }
  void reloadMonth();
});

onMounted(reloadMonth);

/* ---------------- 选中日详情 ---------------- */

const selectedTitle = computed(() => {
  const d = fromDateStr(selectedDate.value);
  const weekday = ((d.getDay() + 6) % 7) + 1;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${CALENDAR_WEEKDAY_LABELS[weekday - 1]}`;
});

const selectedSessions = computed(() => sessionsOn(selectedDate.value));
const selectedEvents = computed(() => eventsOn(selectedDate.value));

function goClass(className: string) {
  router.push({ name: "class-detail", params: { name: className } });
}

/* ---------------- 日程速记 / 勾选 / 删除（仅 light + editable） ---------------- */

const newEventType = ref<CalendarEventType>("todo");
const draft = ref("");
const eventSaving = ref(false);

async function addEvent() {
  const content = draft.value.trim();
  if (!content || eventSaving.value) return;
  eventSaving.value = true;
  let savedId = 0;
  try {
    // 日历速记的是全天个人事件（不绑节次）；绑「日期 × 节次」的备忘在周课表格子里记
    savedId = await addCalendarEvent(null, selectedDate.value, content, newEventType.value);
    draft.value = "";
    await reloadMonth();
    emit("changed");
  } finally {
    eventSaving.value = false;
  }
  // AI 快速浏览标题后台生成：已配置模型才生成并回写（与周课表格内速记同口径）
  void summarizeMemoTitle(content).then(async (title) => {
    if (!title || !savedId) return;
    try {
      await setCalendarEventTitle(savedId, title);
      await reloadMonth();
      emit("changed");
    } catch {
      /* 标题回写失败不影响备忘本身 */
    }
  });
}

async function toggleEvent(event: CalendarEvent) {
  await setCalendarEventDone(event.id, event.done !== 1);
  await reloadMonth();
  emit("changed");
}

async function removeEvent(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  await reloadMonth();
  emit("changed");
}

/* ---------------- 类型筛选（dark 只读详情：点胶囊置灰未命中类型，与首页今日日程一致） ---------------- */

const typeFilter = ref<CalendarEventType | null>(null);

function toggleTypeFilter(type: CalendarEventType) {
  typeFilter.value = typeFilter.value === type ? null : type;
}

function isEventDimmed(event: CalendarEvent): boolean {
  return isDark.value && typeFilter.value !== null && event.type !== typeFilter.value;
}

/* ---------------- 格子样式：light / dark 两套皮肤集中在这里 ---------------- */

function cellClass(cell: CalendarCell): string[] {
  const base = isDark.value
    ? "group relative flex min-h-[50px] w-full cursor-pointer flex-col items-stretch gap-0.5 rounded-md border p-1 text-left transition-colors"
    : "group relative flex min-h-[84px] w-full cursor-pointer flex-col items-stretch gap-1 rounded-sm border p-1.5 text-left transition-colors";
  const state = isDark.value
    ? selectedDate.value === cell.date
      ? "border-primary-on-dark/60 bg-primary-on-dark/15"
      : cell.inMonth
        ? "border-white/10 bg-white/[0.04] hover:border-white/30 hover:bg-white/10"
        : "border-white/[0.05] bg-white/[0.02] hover:border-white/20"
    : selectedDate.value === cell.date
      ? "border-primary bg-primary-soft"
      : cell.inMonth
        ? "border-hairline bg-canvas hover:border-primary hover:bg-primary-soft/30"
        : "border-divider bg-pearl/40 hover:border-primary/40";
  return [base, state];
}

function dayNumClass(cell: CalendarCell): string[] {
  const base = "text-fine tnum";
  if (isDark.value) {
    return [
      base,
      today === cell.date
        ? "flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-primary-on-dark font-semibold text-white"
        : cell.inMonth
          ? cell.isWeekend
            ? "text-white/40"
            : "text-white/80"
          : "text-white/25",
    ];
  }
  return [
    base,
    today === cell.date
      ? "inline-flex h-5 w-5 items-center justify-center rounded-pill bg-primary font-medium text-white"
      : cell.inMonth
        ? cell.isWeekend
          ? "text-weak"
          : "text-muted"
        : "text-faint",
  ];
}

/** 格子里的课程条：深色用玻璃彩块，浅色用科目色胶囊；停课划线 */
function courseChipClass(session: MyDaySession): string[] {
  return [
    isDark.value
      ? "flex min-w-0 items-center overflow-hidden rounded-md px-1 py-px"
      : "flex items-center gap-1 overflow-hidden rounded-sm border px-1 py-px",
    isDark.value ? subjectGlassBlockClass(session.subject) : subjectChipClass(session.subject),
    session.state === "cancelled" ? "line-through opacity-60" : "",
  ];
}

/** 格子的悬浮提示：N 节课 · M 条日程 */
function cellTitle(cell: CalendarCell): string {
  const lessons = sessionsOn(cell.date).length;
  const memos = eventsOn(cell.date).length;
  const parts: string[] = [];
  if (lessons) parts.push(`${lessons} 节课`);
  if (memos) parts.push(`${memos} 条日程`);
  return parts.length ? `${cell.date} · ${parts.join(" · ")}` : `${cell.date} · 无安排`;
}
</script>

<template>
  <div
    data-test="my-calendar"
    :class="isDark ? 'mt-2.5' : 'grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]'"
  >
    <!-- ══════ 月历 ══════ -->
    <div
      data-test="my-calendar-card"
      :class="[isDark ? '' : 'rounded-lg border border-hairline bg-canvas p-4', isDark ? '' : props.surfaceClass]"
      :style="isDark ? undefined : props.surfaceStyle"
    >
      <!-- 月份导航 -->
      <div :class="isDark ? 'flex items-center justify-between' : 'mb-3 flex items-center justify-between'">
        <div class="flex items-center gap-1">
          <button
            type="button"
            :class="isDark
              ? 'flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/15 hover:text-white'
              : 'flex h-8 w-8 items-center justify-center rounded-md text-weak transition-colors hover:bg-pearl hover:text-ink'"
            aria-label="上一月"
            @click="shift(-1)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <h3
            data-test="my-calendar-title"
            :class="isDark
              ? 'min-w-[92px] text-center text-fine font-medium text-white/85'
              : 'min-w-[96px] text-center text-body font-semibold text-ink'"
          >
            {{ title }}
          </h3>
          <button
            type="button"
            :class="isDark
              ? 'flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition-colors hover:bg-white/15 hover:text-white'
              : 'flex h-8 w-8 items-center justify-center rounded-md text-weak transition-colors hover:bg-pearl hover:text-ink'"
            aria-label="下一月"
            @click="shift(1)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <AppLink
          variant="action"
          :tone="isDark ? 'onDark' : 'primary'"
          :class="isDark ? 'text-fine' : 'text-caption'"
          @click="backToToday"
        >
          回到今天
        </AppLink>
      </div>

      <!-- 星期表头（周一起始） -->
      <div class="mt-2 grid grid-cols-7 gap-px">
        <div
          v-for="(label, i) in CALENDAR_WEEKDAY_LABELS"
          :key="label"
          class="flex items-center justify-center text-fine"
          :class="isDark
            ? ['h-6', i >= 5 ? 'text-white/30' : 'text-white/50']
            : ['h-7', i >= 5 ? 'text-weak' : 'text-muted']"
        >
          {{ label }}
        </div>
      </div>

      <!-- 日期网格：课程（我的课实际行程）+ 日程 -->
      <div class="grid grid-cols-7 gap-px">
        <button
          v-for="cell in flatGrid"
          :key="cell.date"
          type="button"
          data-test="my-calendar-cell"
          :data-date="cell.date"
          :class="cellClass(cell)"
          :title="cellTitle(cell)"
          @click="selectedDate = cell.date"
        >
          <!-- 日期行：深色面板把课程溢出数放这一行右端，科目条就能独占一行不挤 -->
          <span class="flex items-center justify-between gap-1">
            <span :class="dayNumClass(cell)">{{ cell.day }}</span>
            <span
              v-if="isDark && sessionsOn(cell.date).length > 1"
              class="tnum shrink-0 text-fine text-white/40"
            >
              +{{ sessionsOn(cell.date).length - 1 }}
            </span>
          </span>

          <!-- 课程：深色面板 1 条（科目名优先读全）；浅色 2 条 + 溢出（可带调课徽标） -->
          <template v-if="isDark">
            <span
              v-if="sessionsOn(cell.date).length"
              data-test="my-calendar-course"
              :class="courseChipClass(sessionsOn(cell.date)[0]!)"
            >
              <span class="min-w-0 truncate">{{ sessionsOn(cell.date)[0]!.subject }}</span>
            </span>
          </template>
          <template v-else>
            <span
              v-for="s in sessionsOn(cell.date).slice(0, 2)"
              :key="`${s.period}-${s.class_name}`"
              data-test="my-calendar-course"
              :class="courseChipClass(s)"
            >
              <span class="truncate">{{ s.subject }}</span>
              <span
                v-if="s.state !== 'normal'"
                class="shrink-0 rounded-pill bg-primary-soft px-1 text-fine leading-4 text-primary"
              >
                {{ EXCEPTION_STATE_LABELS[s.state] }}
              </span>
            </span>
            <span v-if="sessionsOn(cell.date).length > 2" class="text-fine text-faint tnum">
              +{{ sessionsOn(cell.date).length - 2 }}
            </span>
          </template>

          <!-- 日程：深色只显示类型色点（悬浮看格子弹层提示）；浅色显示 1 条 + 溢出 -->
          <template v-if="isDark">
            <span v-if="eventsOn(cell.date).length" class="flex items-center gap-0.5" data-test="my-calendar-event-dots">
              <span
                v-for="e in eventsOn(cell.date).slice(0, 4)"
                :key="e.id"
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
              />
              <span v-if="eventsOn(cell.date).length > 4" class="text-fine leading-3 text-white/45 tnum">
                +{{ eventsOn(cell.date).length - 4 }}
              </span>
            </span>
          </template>
          <template v-else>
            <span
              v-for="e in eventsOn(cell.date).slice(0, 1)"
              :key="e.id"
              data-test="my-calendar-event"
              class="flex items-center gap-1 text-fine"
              :class="e.done ? 'text-faint line-through' : 'text-muted'"
            >
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
              />
              <MemoTitle :event="e" class="min-w-0" />
            </span>
            <span v-if="eventsOn(cell.date).length > 1" class="text-fine text-faint tnum">
              +{{ eventsOn(cell.date).length - 1 }}
            </span>
          </template>
        </button>
      </div>

      <p v-if="!isDark" class="mt-2 text-fine text-weak">
        {{
          editable
            ? "点任意一天：看当天实际课程（含调课），在右侧日详情里速记日程"
            : "点任意一天看当天课程与日程"
        }}
      </p>
    </div>

    <!-- ══════ 日详情 ══════ -->
    <div :class="isDark ? 'mt-3 border-t border-white/10 pt-2.5' : 'space-y-4'">
      <div data-test="my-calendar-day-panel" :class="isDark ? '' : 'rounded-lg border border-hairline bg-canvas p-4'">
        <div class="flex items-center justify-between gap-2">
          <h3
            data-test="my-calendar-selected-title"
            class="shrink-0 whitespace-nowrap"
            :class="isDark ? 'text-fine font-semibold text-white/85' : 'text-body font-semibold text-ink'"
          >
            {{ selectedTitle }}
            <span
              v-if="selectedDate === today"
              :class="isDark
                ? 'ml-1 rounded-pill bg-primary-on-dark/25 px-1.5 py-px text-fine font-normal text-primary-on-dark'
                : 'ml-1 rounded-pill bg-primary-soft px-2 py-0.5 text-fine font-normal text-primary'"
            >
              今天
            </span>
          </h3>
          <!-- dark 只读面板：日程类型筛选（点胶囊置灰未命中类型，再点取消） -->
          <div v-if="isDark" class="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <button
              v-for="t in CALENDAR_EVENT_TYPES"
              :key="t"
              type="button"
              data-test="event-type-pill"
              :title="`点按「${CALENDAR_EVENT_META[t].label}」筛选当天日程，再点取消`"
              :aria-pressed="typeFilter === t"
              class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border px-2 py-0.5 text-fine transition-colors"
              :class="typeFilter === t ? 'border-white bg-white font-medium text-ink' : 'border-white/25 text-white/60 hover:border-white/60'"
              @click="toggleTypeFilter(t)"
            >
              <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
              {{ CALENDAR_EVENT_META[t].label }}
            </button>
          </div>
        </div>

        <!-- 课程 -->
        <p :class="isDark ? 'mt-2 text-fine font-medium text-white/55' : 'mt-3 text-fine font-medium text-weak'">
          课程
        </p>
        <p v-if="!selectedSessions.length" :class="isDark ? 'mt-1 text-caption text-white/45' : 'mt-1.5 text-caption text-weak'">
          这一天没有课
        </p>
        <ul v-else class="mt-1.5 space-y-1">
          <li
            v-for="c in selectedSessions"
            :key="`${c.period}-${c.class_name}`"
            data-test="my-calendar-day-course"
            class="group/course flex items-center gap-1.5 rounded-sm"
            :class="isDark ? '' : 'bg-pearl px-2 py-1.5'"
          >
            <span class="tnum shrink-0 text-caption" :class="isDark ? 'text-white/50' : 'text-weak'">第{{ c.period }}节</span>
            <span
              class="shrink-0 rounded-pill border px-1.5 py-px text-fine leading-4"
              :class="[subjectChipClass(c.subject), c.state === 'cancelled' ? 'line-through opacity-60' : '']"
            >
              {{ c.subject }}
            </span>
            <span
              v-if="c.state !== 'normal'"
              class="shrink-0 rounded-pill bg-primary-soft px-1.5 py-px text-fine leading-4 text-primary"
              :title="c.state === 'cancelled' ? '这节停课' : '这天这一节被调过课'"
            >
              {{ EXCEPTION_STATE_LABELS[c.state] }}
            </span>
            <span
              v-if="c.class_name"
              class="min-w-0 truncate text-fine"
              :class="isDark ? 'text-white/45' : 'text-weak'"
              :title="c.class_name"
            >
              {{ c.class_name }}
            </span>
            <AppLink
              v-if="!isDark"
              size="sm"
              class="ml-auto shrink-0 opacity-0 transition-opacity group-hover/course:opacity-100"
              @click="goClass(c.class_name)"
            >
              去班级
            </AppLink>
          </li>
        </ul>

        <!-- 日程 -->
        <p :class="isDark ? 'mt-2.5 text-fine font-medium text-white/55' : 'mt-4 text-fine font-medium text-weak'">
          日程
        </p>
        <p
          v-if="!selectedEvents.length"
          :class="isDark ? 'mt-1 text-caption text-white/45' : 'mt-1.5 text-caption text-weak'"
          data-test="my-calendar-events-empty"
        >
          {{ isDark ? "这一天没有日程" : editable ? "还没有日程，记一条吧（如：收回执单、单元测验）" : "这一天没有日程" }}
        </p>
        <ul v-else class="mt-1.5 space-y-0.5">
          <li
            v-for="e in selectedEvents"
            :key="e.id"
            data-test="my-calendar-event-item"
            class="group flex items-center gap-2 rounded-sm px-1 py-1"
            :class="[isDark ? 'hover:bg-white/5' : 'hover:bg-pearl', isEventDimmed(e) ? 'opacity-40' : '']"
          >
            <button
              v-if="editable"
              type="button"
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
              :class="e.done ? 'border-primary bg-primary' : 'border-weak hover:border-primary'"
              :aria-label="e.done ? '标记为待办' : '标记为已完成'"
              @click="toggleEvent(e)"
            >
              <svg v-if="e.done" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8.5l3.5 3.5L13 4.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
              :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
            />
            <span
              data-test="event-period-label"
              class="shrink-0 rounded-pill px-1.5 py-px text-fine leading-4 tnum"
              :class="isDark ? 'bg-white/10 text-white/55' : 'bg-pearl text-weak'"
            >
              {{ eventPeriodLabel(e) }}
            </span>
            <span
              v-if="isDark"
              class="min-w-0 flex-1 truncate text-fine"
              :class="e.done ? 'text-white/35 line-through' : 'text-white/85'"
              :title="e.content"
            >
              {{ e.content }}
            </span>
            <MemoTitle
              v-else
              :event="e"
              class="min-w-0 flex-1"
              :class="e.done ? 'text-faint line-through' : 'text-ink'"
            />
            <span v-if="!isDark && e.class_name" class="shrink-0 text-fine text-faint">{{ e.class_name }}</span>
            <button
              v-if="editable"
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
              aria-label="删除日程"
              @click="removeEvent(e)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </li>
        </ul>

        <!-- 速记：全天个人事件（绑节次的备忘在周课表格子里记） -->
        <div v-if="editable" class="mt-3 flex items-center gap-1.5">
          <EventTypeSelect v-model="newEventType" />
          <input
            v-model="draft"
            data-test="my-calendar-event-input"
            :placeholder="`记${CALENDAR_EVENT_META[newEventType].label}，回车`"
            class="h-7 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            @keydown.enter.prevent="addEvent"
          />
          <button
            type="button"
            data-test="my-calendar-event-add"
            class="h-7 shrink-0 rounded-sm bg-primary px-2.5 text-fine text-white transition-colors hover:bg-primary-focus disabled:pointer-events-none disabled:opacity-40"
            :disabled="!draft.trim() || eventSaving"
            @click="addEvent"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
