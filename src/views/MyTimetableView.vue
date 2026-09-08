<script setup lang="ts">
/**
 * 我的课表：按「任教学科」（profile.my_subjects）聚合全部班级课表格子的纯视图。
 *
 * - 周课表（默认）：完整节次 × 周一至周五网格，套用调课例外（停课划线 / 换课加课打标）
 * - 点击课表格子直接展开格内编辑器：记 / 管「日期 × 节次」绑定的备忘，备忘就显示在该格子里；
 *   全天 / 日报事件（period 为空）显示在列头、从列头编辑
 * - 类型绑定在编辑器内完成：输入框前的色点下拉（悬浮出类型文案）；右上类型胶囊只做筛选——
 *   点选后未选中类型的备忘置灰，只高亮命中该类型的格子，再点取消
 * - 备忘格子 / 列表显示快速浏览标题：已配置 AI 模型时显示 AI 总结标题（编辑完成后后台生成），
 *   未配置则显示全文前几个字；悬浮标题看全文，点击弹悬浮卡片展示全文
 * - 按科目分块：每科一张完整表格，列出 周几 · 第几节 · 哪个班
 * - 跨班撞课（同一时间出现在多个班）页顶横幅告警
 * 数据经 lib/timetable 从班级课表推导，本页不落课表；日程事件写 calendar_events。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ImportTimetableDialog from "../components/ImportTimetableDialog.vue";
import AppButton from "../components/ui/AppButton.vue";
import AppCard from "../components/ui/AppCard.vue";
import AppLink from "../components/ui/AppLink.vue";
import EventTypeSelect from "../components/EventTypeSelect.vue";
import MemoTitle from "../components/MemoTitle.vue";
import {
  addCalendarEvent,
  deleteCalendarEvent,
  listTeacherEventsInRange,
  listTimetableExceptionsWithClass,
  listTimetablePeriodsByClass,
  listTimetableSlotsWithClass,
  setCalendarEventDone,
  setCalendarEventTitle,
} from "../lib/db";
import { fromDateStr, mondayOf, toDateStr } from "../lib/calendar";
import { summarizeMemoTitle } from "../lib/memo-ai";
import { ensureProfile, profile, timetableBgSurfaceClass, timetableBgSurfaceStyle } from "../lib/profile";
import {
  CALENDAR_EVENT_META,
  CALENDAR_EVENT_TYPES,
  EXCEPTION_STATE_LABELS,
  WEEKDAY_LABELS,
  buildMyDays,
  buildMySchedule,
  currentSemester,
  defaultPeriods,
  mineOfClassResolver,
  periodsUnion,
  semesterLabel,
  subjectChipClass,
  type MyDaySession,
  type MySchedule,
} from "../lib/timetable";
import type {
  CalendarEvent,
  CalendarEventType,
  TimetablePeriod,
  TimetableExceptionWithClass,
  TimetableSlotWithClass,
} from "../types";

const router = useRouter();

const SEMESTER = currentSemester();
const TODAY = weekdayToday();

function weekdayToday(): number | null {
  const day = new Date().getDay();
  return day >= 1 && day <= 5 ? day : null;
}

const loading = ref(true);
const rows = ref<TimetableSlotWithClass[]>([]);
const exceptions = ref<TimetableExceptionWithClass[]>([]);
const events = ref<CalendarEvent[]>([]);
const view = ref<"blocks" | "week">("week");
const importOpen = ref(false);
const allPeriods = ref<TimetablePeriod[]>(defaultPeriods());

const mySubjects = computed(() => profile.value.my_subjects ?? []);
/** 每班生效的「我的科目」判定器：班级标记过按标记，未标记回退全局任教学科 */
const mineOf = computed(() => mineOfClassResolver(rows.value, mySubjects.value));
const schedule = computed(() => buildMySchedule(rows.value, mineOf.value));
const showGuide = computed(
  () => !loading.value && (!mySubjects.value.length || !schedule.value.weekly_total),
);

/** 本周周一~周五的实际日期（列头带 M/D） */
const weekDates = computed<string[]>(() => {
  const monday = mondayOf();
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return toDateStr(d);
  });
});

/** 本周逐日实际行程（周课表 + 调课例外，按每班生效的我的科目过滤） */
const myDays = computed<Map<string, MyDaySession[]>>(() =>
  buildMyDays(rows.value, exceptions.value, mineOf.value, weekDates.value)
);

function sessionsAt(date: string, period: number): MyDaySession[] {
  return (myDays.value.get(date) ?? []).filter((s) => s.period === period);
}

/** 日期头：9/8 周一 */
function dateHeader(date: string): string {
  const d = fromDateStr(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------------- 格子内速记（教师维度事件：班级事件 + 个人事件） ---------------- */

const newEventType = ref<CalendarEventType>("todo");
const eventSaving = ref(false);

/** v-focus：格子编辑器的输入框挂载即聚焦 */
const vFocus = { mounted: (el: HTMLInputElement) => el.focus() };

/* ---------------- 类型筛选：右上胶囊点选后，只高亮命中类型的格子 ---------------- */

/** 当前筛选的备忘类型；null = 未筛选（全部正常显示） */
const typeFilter = ref<CalendarEventType | null>(null);

/** 点同胶囊再点一次取消筛选 */
function toggleTypeFilter(type: CalendarEventType) {
  typeFilter.value = typeFilter.value === type ? null : type;
}

/** 该条备忘是否被筛选置灰：筛选中且类型不符 */
function isEventDimmed(event: CalendarEvent): boolean {
  return typeFilter.value !== null && event.type !== typeFilter.value;
}

/** 该格（日期 × 节次，period = null 为全天列头）是否有选中类型的备忘 → 高亮格子 */
function filterHitAt(date: string, period: number | null): boolean {
  if (typeFilter.value === null) return false;
  return events.value.some(
    (e) => e.event_date === date && (e.period ?? null) === period && e.type === typeFilter.value
  );
}

async function reloadEvents() {
  const [start, end] = [weekDates.value[0], weekDates.value[4]];
  try {
    events.value = await listTeacherEventsInRange(start, end);
  } catch {
    events.value = [];
  }
}

/** 编辑器打开的格子：date + period（period = null 表示该天的全天/日报事件，从列头打开） */
const editingCell = ref<{ date: string; period: number | null } | null>(null);
/** 各格输入草稿（key = `${date}|${period ?? "day"}`），收起后保留以便续写 */
const draftByCell = ref<Record<string, string>>({});

const cellKey = (date: string, period: number | null) => `${date}|${period ?? "day"}`;

function openEditor(date: string, period: number | null) {
  editingCell.value = { date, period };
}

function closeEditor() {
  editingCell.value = null;
}

function isEditing(date: string, period: number | null): boolean {
  const c = editingCell.value;
  return !!c && c.date === date && c.period === period;
}

/** 某格（日期 × 节次）绑定的日程事件；period = null 取该天全天事件 */
function eventsAt(date: string, period: number | null): CalendarEvent[] {
  return events.value
    .filter((e) => e.event_date === date && (e.period ?? null) === period)
    .sort((a, b) => a.id - b.id);
}

/** 列头展示的全天/日报事件（period 为空的事件不落在具体格子） */
function dayEvents(date: string): CalendarEvent[] {
  return eventsAt(date, null);
}

async function addEvent() {
  const cell = editingCell.value;
  if (!cell) return;
  const key = cellKey(cell.date, cell.period);
  const content = (draftByCell.value[key] ?? "").trim();
  if (!content || eventSaving.value) return;
  eventSaving.value = true;
  let savedId = 0;
  try {
    // 格子里速记的是教师个人事件（不绑班级）；班级事件在班级万年历里记
    savedId = await addCalendarEvent(null, cell.date, content, newEventType.value, cell.period);
    draftByCell.value = { ...draftByCell.value, [key]: "" };
    await reloadEvents();
  } finally {
    eventSaving.value = false;
  }
  // AI 快速浏览标题后台生成：已配置模型才生成并回写（未配置 → null，界面显示全文前几个字）
  void summarizeMemoTitle(content).then(async (title) => {
    if (!title || !savedId) return;
    try {
      await setCalendarEventTitle(savedId, title);
      await reloadEvents();
    } catch {
      /* 标题回写失败不影响备忘本身 */
    }
  });
}

async function toggleEvent(event: CalendarEvent) {
  await setCalendarEventDone(event.id, event.done !== 1);
  await reloadEvents();
}

async function removeEvent(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  await reloadEvents();
}

/** 点击课表滚动区以外的地方收起编辑器（格子间切换由 openEditor 处理） */
const scrollEl = ref<HTMLElement | null>(null);

function onDocMouseDown(e: MouseEvent) {
  if (!editingCell.value || !scrollEl.value) return;
  if (!scrollEl.value.contains(e.target as Node)) closeEditor();
}

function sessionsAtBlock(block: MySchedule["bySubject"][number], day: number, period: number) {
  return block.sessions.filter((s) => s.day_of_week === day && s.period === period);
}

function goClass(className: string) {
  router.push({ name: "class-detail", params: { name: className } });
}

async function reloadSlots(): Promise<void> {
  try {
    rows.value = await listTimetableSlotsWithClass(SEMESTER);
  } catch {
    rows.value = [];
  }

  const [start, end] = [weekDates.value[0], weekDates.value[4]];
  try {
    exceptions.value = await listTimetableExceptionsWithClass(SEMESTER, start, end);
  } catch {
    exceptions.value = [];
  }

  try {
    const timetablePeriods = await listTimetablePeriodsByClass(SEMESTER);
    allPeriods.value = periodsUnion(timetablePeriods.map((item) => item.periods));
  } catch {
    allPeriods.value = defaultPeriods();
  }
}

async function handleTimetableImported(): Promise<void> {
  importOpen.value = false;
  await reloadSlots();
}

onMounted(async () => {
  document.addEventListener("mousedown", onDocMouseDown);
  await ensureProfile().catch(() => undefined);
  await reloadSlots();
  await reloadEvents();
  loading.value = false;
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocMouseDown);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-parchment">
    <!-- Header -->
    <header class="border-b border-divider bg-canvas px-8 py-4 shrink-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <AppLink to="/home" icon="back" class="font-medium shrink-0">首页</AppLink>
          <span class="text-hairline shrink-0">|</span>
          <h1 class="text-display font-semibold text-ink truncate">我的课表</h1>
          <span class="rounded-pill bg-primary-soft px-2.5 py-1 text-fine text-primary shrink-0">
            {{ semesterLabel(SEMESTER) }}
          </span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <AppButton
            variant="pearl"
            data-test="import-timetable-btn"
            @click="importOpen = true"
          >
            导入课表
          </AppButton>
          <button
            type="button"
            class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
            :class="view === 'blocks' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
            @click="view = 'blocks'"
          >
            按科目
          </button>
          <button
            type="button"
            class="rounded-sm px-4 py-2 text-caption font-medium transition-colors"
            :class="view === 'week' ? 'bg-ink text-canvas' : 'text-weak hover:text-ink hover:bg-pearl'"
            @click="view = 'week'"
          >
            周课表
          </button>
        </div>
      </div>
    </header>

    <div ref="scrollEl" class="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6 space-y-5">
      <!-- 任教学科条 -->
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-caption text-weak">任教学科</span>
        <template v-if="mySubjects.length">
          <span
            v-for="s in mySubjects"
            :key="s"
            class="rounded-pill bg-ink px-3 py-1 text-fine font-medium text-canvas"
          >
            {{ s }}
          </span>
        </template>
        <span v-else class="text-caption text-weak">未登记</span>
        <AppLink to="/profile" size="sm">去个人资料调整</AppLink>
        <span class="ml-auto text-fine text-weak">
          每周共 {{ schedule.weekly_total }} 节 · 来自各班课表的自动聚合
        </span>
      </div>

      <!-- 未登记任教学科：轻提示，不拦截——周课表与日程管理照常可用 -->
      <div
        v-if="!loading && !mySubjects.length"
        data-test="subjects-missing-banner"
        class="rounded-md border border-primary/30 bg-primary-soft px-4 py-3 text-caption text-muted"
      >
        未登记任教学科，暂时无法确定「你的课」。
        <AppLink to="/profile" size="sm" class="font-medium">去个人资料登记</AppLink>
        ；周课表与日程管理不受影响。
      </div>

      <!-- 撞课告警 -->
      <div
        v-if="schedule.conflicts.length"
        data-test="conflict-banner"
        class="rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-caption text-danger"
      >
        <p class="font-medium">发现撞课（同一时间被排进多个班）：</p>
        <p v-for="c in schedule.conflicts" :key="`${c.day_of_week}:${c.period}`" class="mt-1">
          {{ WEEKDAY_LABELS[c.day_of_week - 1] }} 第{{ c.period }}节：
          {{ c.entries.map((e) => `${e.subject}在${e.class_name}`).join(" 与 ") }}
          <AppLink
            v-for="(e, i) in [...new Set(c.entries.map((x) => x.class_name))]"
            :key="i"
            size="sm"
            class="ml-1"
            @click="goClass(e)"
          >
            去{{ e }}
          </AppLink>
        </p>
      </div>

      <div
        v-if="showGuide"
        data-test="timetable-guide"
        class="rounded-lg border border-hairline bg-canvas p-5"
      >
        <h2 class="text-body font-semibold text-ink">三步把课表装进来</h2>
        <ol class="mt-3 space-y-2 text-caption text-muted">
          <li class="flex flex-wrap items-center gap-2">
            <span class="rounded-pill bg-pearl px-2 text-fine">1</span>
            登记任教学科，确定「哪些课是你的」
            <AppLink to="/profile">去登记</AppLink>
          </li>
          <li class="flex flex-wrap items-center gap-2">
            <span class="rounded-pill bg-pearl px-2 text-fine">2</span>
            导入 Excel / CSV 课表，自动识别星期与节次
            <AppLink
              data-test="guide-import"
              @click="importOpen = true"
            >
              导入课表
            </AppLink>
          </li>
          <li class="flex flex-wrap items-center gap-2">
            <span class="rounded-pill bg-pearl px-2 text-fine">3</span>
            或到班级里手工排课
            <AppLink to="/classes">去班级排课</AppLink>
          </li>
        </ol>
      </div>

      <!-- 按科目分块：每个科目仍然是一张完整的节次 × 工作日表 -->
      <template v-if="view === 'blocks'">
        <div v-if="schedule.bySubject.length" class="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <AppCard v-for="block in schedule.bySubject" :key="block.subject" :class="timetableBgSurfaceClass" :style="timetableBgSurfaceStyle">
            <div class="mb-3 flex items-baseline justify-between">
              <h2 class="text-body font-semibold text-ink">{{ block.subject }}</h2>
              <span class="text-fine text-weak">每周 {{ block.weekly_count }} 节</span>
            </div>
            <div
              data-test="subject-block-grid"
              class="grid grid-cols-[56px_repeat(5,minmax(0,1fr))] gap-px"
            >
              <div class="flex h-7 items-center justify-center text-fine text-weak">节次</div>
              <div
                v-for="(label, i) in WEEKDAY_LABELS"
                :key="label"
                class="flex h-7 items-center justify-center rounded-sm text-fine"
                :class="TODAY === i + 1 ? 'bg-primary-soft font-medium text-primary' : 'text-muted'"
              >
                {{ label }}
              </div>
              <template v-for="p in allPeriods" :key="p.period">
                <div
                  data-test="block-period-cell"
                  class="flex h-11 items-center justify-center rounded-sm bg-pearl text-fine text-muted"
                >
                  {{ p.period }}
                </div>
                <div v-for="day in 5" :key="day" class="relative">
                  <button
                    v-for="session in sessionsAtBlock(block, day, p.period)"
                    :key="session.class_name"
                    type="button"
                    class="mb-px flex h-11 w-full flex-col items-start justify-center overflow-hidden rounded-sm border border-hairline bg-canvas px-2 text-left transition-colors hover:border-primary"
                    :title="`${block.subject} · ${session.class_name}`"
                    @click="goClass(session.class_name)"
                  >
                    <span class="truncate text-fine font-medium text-ink">{{ session.class_name }}</span>
                  </button>
                  <div
                    v-if="!sessionsAtBlock(block, day, p.period).length"
                    class="h-11 rounded-sm border border-dashed border-divider bg-pearl/40"
                  />
                </div>
              </template>
            </div>
          </AppCard>
        </div>
      </template>

      <!-- 周课表：带日期的完整节次网格（调课生效）+ 按天日程 -->
      <div v-else class="space-y-5">
        <div class="rounded-lg border border-hairline bg-canvas p-4" :class="timetableBgSurfaceClass" :style="timetableBgSurfaceStyle" data-test="week-timetable-surface">
          <!-- 类型胶囊：备忘类型筛选器——点选后未选中类型的备忘置灰，只高亮命中的格子，再点取消 -->
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p class="text-fine text-weak">
              点课表格子直接记备忘；课程展示调课后的实际行程，换课 / 停课 / 加课在对应班级的「课程表」日历里操作；右上胶囊按类型筛选备忘
            </p>
            <div class="flex items-center gap-1.5">
              <button
                v-for="t in CALENDAR_EVENT_TYPES"
                :key="t"
                type="button"
                data-test="event-type-pill"
                :title="`点按「${CALENDAR_EVENT_META[t].label}」筛选课表备忘，再点取消`"
                :aria-pressed="typeFilter === t"
                class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine transition-colors"
                :class="typeFilter === t ? 'border-ink bg-ink font-medium text-canvas' : 'border-hairline text-weak hover:border-ink'"
                @click="toggleTypeFilter(t)"
              >
                <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
                {{ CALENDAR_EVENT_META[t].label }}
              </button>
            </div>
          </div>
          <div class="grid grid-cols-[56px_repeat(5,minmax(0,1fr))] gap-px">
            <div class="flex h-9 items-center justify-center text-fine text-weak">节次</div>
            <div
              v-for="(date, i) in weekDates"
              :key="date"
              data-test="week-day-header"
              class="relative flex min-h-9 cursor-pointer flex-col items-center justify-center rounded-sm px-1 py-1 text-center text-fine transition-colors"
              :class="[
                toDateStr(new Date()) === date
                  ? 'bg-primary-soft font-medium text-primary'
                  : filterHitAt(date, null)
                    ? 'bg-primary-soft/60 font-medium text-primary ring-1 ring-inset ring-primary/50'
                    : 'text-muted hover:bg-pearl',
              ]"
              :title="`${dateHeader(date)} ${WEEKDAY_LABELS[i]} · 点击记全天日程`"
              @click="openEditor(date, null)"
            >
              <span>{{ dateHeader(date) }} {{ WEEKDAY_LABELS[i] }}</span>
              <!-- 全天 / 日报事件（不绑节次）：最多展示 2 条，溢出收数 -->
              <span
                v-for="e in dayEvents(date).slice(0, 2)"
                :key="e.id"
                class="mt-0.5 flex w-full items-center justify-center gap-1 font-normal text-faint"
                :class="isEventDimmed(e) ? 'opacity-40' : ''"
              >
                <span class="h-1 w-1 shrink-0 rounded-full" :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'" />
                <MemoTitle :event="e" :align="i >= 3 ? 'right' : 'left'" class="min-w-0" />
              </span>
              <span v-if="dayEvents(date).length > 2" class="font-normal text-faint">+{{ dayEvents(date).length - 2 }}</span>
              <!-- 全天日程编辑器（从列头打开） -->
              <div
                v-if="isEditing(date, null)"
                data-test="week-cell-editor"
                class="absolute top-full z-20 mt-1 flex w-[230px] flex-col gap-1.5 rounded-md border border-hairline bg-canvas p-2.5"
                :class="i === 0 ? 'left-0' : i === weekDates.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'"
                @click.stop
              >
                <div class="flex items-center justify-between">
                  <p class="text-fine font-medium text-ink">全天 · {{ dateHeader(date) }} {{ WEEKDAY_LABELS[i] }}</p>
                  <button
                    type="button"
                    class="flex h-4 w-4 items-center justify-center rounded-md text-faint hover:bg-pearl hover:text-ink"
                    aria-label="收起"
                    @click="closeEditor()"
                  >
                    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    </svg>
                  </button>
                </div>
                <p v-if="!dayEvents(date).length" class="text-fine text-faint">这天还没有全天日程</p>
                <ul v-else class="space-y-px">
                  <li
                    v-for="e in dayEvents(date)"
                    :key="e.id"
                    data-test="week-cell-memo-row"
                    class="group flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-pearl"
                    :class="isEventDimmed(e) ? 'opacity-40' : ''"
                  >
                    <button
                      type="button"
                      class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors"
                      :class="e.done ? 'border-primary bg-primary' : 'border-weak hover:border-primary'"
                      :aria-label="e.done ? '标记为待办' : '标记为已完成'"
                      @click="toggleEvent(e)"
                    >
                      <svg v-if="e.done" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M3 8.5l3.5 3.5L13 4.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <span
                      class="h-1.5 w-1.5 shrink-0 rounded-full"
                      :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                      :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
                    />
                    <MemoTitle
                      :event="e"
                      align="right"
                      class="min-w-0 flex-1"
                      :class="e.done ? 'text-faint line-through' : 'text-ink'"
                    />
                    <span v-if="e.class_name" class="shrink-0 text-fine text-faint">{{ e.class_name }}</span>
                    <button
                      type="button"
                      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                      aria-label="删除日程"
                      @click="removeEvent(e)"
                    >
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                      </svg>
                    </button>
                  </li>
                </ul>
                <div class="flex items-center gap-1.5">
                  <EventTypeSelect v-model="newEventType" />
                  <input
                    v-focus
                    v-model="draftByCell[cellKey(date, null)]"
                    data-test="week-cell-input"
                    :placeholder="`记${CALENDAR_EVENT_META[newEventType].label}，回车`"
                    class="h-7 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-1.5 text-fine text-ink outline-none focus:border-primary-focus"
                    @keydown.enter.prevent="addEvent()"
                    @keydown.esc.prevent="closeEditor()"
                  />
                </div>
                <p class="text-fine text-faint">色点下拉选类型 · 回车保存</p>
              </div>
            </div>
            <template v-for="(p, pi) in allPeriods" :key="p.period">
              <div data-test="week-period-cell" class="flex min-h-[52px] items-center justify-center rounded-sm bg-pearl text-fine font-medium text-muted">
                {{ p.period }}
              </div>
              <div
                v-for="(date, ci) in weekDates"
                :key="`${p.period}-${date}`"
                data-test="week-cell"
                class="relative flex min-h-[52px] cursor-pointer flex-col gap-px rounded-sm transition-colors"
                :class="[
                  isEditing(date, p.period)
                    ? 'bg-primary-soft/50'
                    : filterHitAt(date, p.period)
                      ? 'bg-primary-soft/60 ring-1 ring-inset ring-primary/50'
                      : 'hover:bg-pearl/50',
                ]"
                :title="`第${p.period}节 · 点击看课 / 记备忘`"
                @click="openEditor(date, p.period)"
              >
                <!-- 课程（各班课表的投影，只读；在编辑器里可跳班级） -->
                <div
                  v-for="s in sessionsAt(date, p.period)"
                  :key="`${s.class_name}-${s.subject}`"
                  class="flex flex-1 flex-col items-start justify-center overflow-hidden rounded-sm border px-2 py-1 text-left"
                  :class="[subjectChipClass(s.subject), s.state === 'cancelled' ? 'line-through opacity-60' : '']"
                  :title="`${s.subject} · ${s.class_name}${s.note ? `（${s.note}）` : ''}`"
                >
                  <span class="flex w-full items-center gap-1">
                    <span class="truncate text-fine font-medium">{{ s.subject }}</span>
                    <span
                      v-if="s.state !== 'normal'"
                      class="ml-auto shrink-0 rounded-pill bg-primary-soft px-1.5 text-fine leading-4 text-primary"
                    >
                      {{ s.state === "cancelled" ? "停" : EXCEPTION_STATE_LABELS[s.state] }}
                    </span>
                  </span>
                  <span class="truncate text-fine opacity-75">{{ s.class_name }}</span>
                </div>
                <!-- 绑定到该格子的备忘（日期 × 节次）：快速浏览标题 + 类型筛选置灰；班级事件附班级名 -->
                <span
                  v-for="e in eventsAt(date, p.period)"
                  :key="e.id"
                  data-test="week-cell-memo"
                  class="flex items-center gap-1 rounded-sm bg-canvas px-1.5 py-0.5 text-fine"
                  :class="[e.done ? 'text-faint line-through' : 'text-ink', isEventDimmed(e) ? 'opacity-40' : '']"
                >
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                    :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
                  />
                  <MemoTitle :event="e" :align="ci >= 3 ? 'right' : 'left'" class="min-w-0" />
                  <span v-if="e.class_name" class="shrink-0 text-fine text-faint">{{ e.class_name }}</span>
                </span>
                <div
                  v-if="!sessionsAt(date, p.period).length && !eventsAt(date, p.period).length"
                  data-test="week-empty-cell"
                  class="flex-1 rounded-sm border border-dashed border-divider bg-pearl/40"
                />
                <!-- 格内编辑器：点格子即展开，记 / 管「日期 × 节次」绑定的备忘 -->
                <div
                  v-if="isEditing(date, p.period)"
                  data-test="week-cell-editor"
                  class="absolute z-20 flex w-[230px] flex-col gap-1.5 rounded-md border border-hairline bg-canvas p-2.5"
                  :class="[
                    ci >= 3 ? 'right-0' : 'left-0',
                    pi >= allPeriods.length - 1 ? 'bottom-full mb-1' : 'top-full mt-1',
                  ]"
                  @click.stop
                >
                  <div class="flex items-center justify-between">
                    <p class="text-fine font-medium text-ink">第{{ p.period }}节 · {{ dateHeader(date) }} {{ WEEKDAY_LABELS[ci] }}</p>
                    <button
                      type="button"
                      class="flex h-4 w-4 items-center justify-center rounded-md text-faint hover:bg-pearl hover:text-ink"
                      aria-label="收起"
                      @click="closeEditor()"
                    >
                      <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                      </svg>
                    </button>
                  </div>
                  <p
                    v-for="s in sessionsAt(date, p.period)"
                    :key="`ed-${s.class_name}`"
                    class="flex items-center gap-1 text-fine text-muted"
                  >
                    <span class="min-w-0 truncate">{{ s.subject }} · {{ s.class_name }}</span>
                    <AppLink
                      size="sm"
                      class="ml-auto shrink-0"
                      @click="goClass(s.class_name)"
                    >
                      去班级
                    </AppLink>
                  </p>
                  <p v-if="!eventsAt(date, p.period).length" class="text-fine text-faint">这格还没有备忘</p>
                  <ul v-else class="space-y-px">
                    <li
                      v-for="e in eventsAt(date, p.period)"
                      :key="e.id"
                      data-test="week-cell-memo-row"
                      class="group flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-pearl"
                      :class="isEventDimmed(e) ? 'opacity-40' : ''"
                    >
                      <button
                        type="button"
                        class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors"
                        :class="e.done ? 'border-primary bg-primary' : 'border-weak hover:border-primary'"
                        :aria-label="e.done ? '标记为待办' : '标记为已完成'"
                        @click="toggleEvent(e)"
                      >
                        <svg v-if="e.done" width="8" height="8" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3 8.5l3.5 3.5L13 4.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                      <span
                        class="h-1.5 w-1.5 shrink-0 rounded-full"
                        :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                        :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
                      />
                      <MemoTitle
                        :event="e"
                        align="right"
                        class="min-w-0 flex-1"
                        :class="e.done ? 'text-faint line-through' : 'text-ink'"
                      />
                      <span v-if="e.class_name" class="shrink-0 text-fine text-faint">{{ e.class_name }}</span>
                      <button
                        type="button"
                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                        aria-label="删除日程"
                        @click="removeEvent(e)"
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                        </svg>
                      </button>
                    </li>
                  </ul>
                  <div class="flex items-center gap-1.5">
                    <EventTypeSelect v-model="newEventType" />
                    <input
                      v-focus
                      v-model="draftByCell[cellKey(date, p.period)]"
                      data-test="week-cell-input"
                      :placeholder="`记${CALENDAR_EVENT_META[newEventType].label}，回车`"
                      class="h-7 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-1.5 text-fine text-ink outline-none focus:border-primary-focus"
                      @keydown.enter.prevent="addEvent()"
                      @keydown.esc.prevent="closeEditor()"
                    />
                  </div>
                  <p class="text-fine text-faint">色点下拉选类型 · 回车保存</p>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
  <ImportTimetableDialog
    :open="importOpen"
    @close="importOpen = false"
    @imported="handleTimetableImported"
  />
</template>
