<script setup lang="ts">
/**
 * 班级万年历：课程表 Tab 的主视图（日历优先）。
 *
 * - 没有课表也照常显示当月万年历，可点某天记日程（calendar_events，绑班级）
 * - 有课表后，课程按「周几 → 节次」映射到日历每一天，随月份自动重复
 * - 调课在日历上维护：日详情面板里对某天某节换课 / 停课 / 恢复 / 加课
 *   （timetable_exceptions，只覆盖单日，周课表仍是唯一事实源）
 * - 日程事件分类型（备忘 / 待办 / 考试 / 作业），色点区分，可勾选完成
 * 设计说明见 docs/TIMETABLE.md「万年历」与「调课」一节。
 */
import { computed, onMounted, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppLink from "./ui/AppLink.vue";
import {
  addCalendarEvent,
  clearTimetableException,
  deleteCalendarEvent,
  listClassEventsInRange,
  listTimetableExceptionsInRange,
  saveTimetableException,
  setCalendarEventDone,
} from "../lib/db";
import {
  CALENDAR_WEEKDAY_LABELS,
  buildMonthGrid,
  fromDateStr,
  gridRange,
  monthTitle,
  shiftMonth,
  toDateStr,
} from "../lib/calendar";
import {
  CALENDAR_EVENT_META,
  CALENDAR_EVENT_TYPES,
  EXCEPTION_STATE_LABELS,
  SUBJECT_PRESETS,
  WEEKDAY_LABELS,
  defaultPeriods,
  eventPeriodLabel,
  resolveDaySlots,
  subjectChipClass,
  type EffectiveSlot,
} from "../lib/timetable";
import type { CalendarEvent, CalendarEventType, Timetable, TimetableException, TimetableSlot } from "../types";

const props = defineProps<{
  className: string;
  timetable: (Timetable & { slots: TimetableSlot[] }) | null;
  /** 课表背景图样式（个人资料里设置的课表背景），铺在万年历卡片表面；未设置不传 */
  surfaceStyle?: Record<string, string>;
  /** 与 surfaceStyle 配套的比例约束（有背景图时统一 16:9）；未设置不传 */
  surfaceClass?: string;
}>();

const emit = defineEmits<{ edit: [] }>();

const now = new Date();
const viewYear = ref(now.getFullYear());
const viewMonth = ref(now.getMonth() + 1);
const selectedDate = ref(toDateStr(now));
const today = toDateStr(now);

const grid = computed(() => buildMonthGrid(viewYear.value, viewMonth.value));
const title = computed(() => monthTitle(viewYear.value, viewMonth.value));

/* ---------------- 课程：周几 → 科目（周课表在日历上按月重复） ---------------- */

const slotsByDay = computed<Map<number, TimetableSlot[]>>(() => {
  const map = new Map<number, TimetableSlot[]>();
  for (const slot of props.timetable?.slots ?? []) {
    const list = map.get(slot.day_of_week) ?? [];
    list.push(slot);
    map.set(slot.day_of_week, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.period - b.period);
  }
  return map;
});

/** 周几（1=周一 … 7=周日） */
function weekdayOf(date: string): number {
  return ((fromDateStr(date).getDay() + 6) % 7) + 1;
}

/* ---------------- 调课例外 + 日程事件：按网格日期区间加载 ---------------- */

const exceptions = ref<TimetableException[]>([]);
const events = ref<CalendarEvent[]>([]);

const exceptionsByDate = computed<Map<string, TimetableException[]>>(() => {
  const map = new Map<string, TimetableException[]>();
  for (const e of exceptions.value) {
    const list = map.get(e.exception_date) ?? [];
    list.push(e);
    map.set(e.exception_date, list);
  }
  return map;
});

const eventsByDate = computed<Map<string, CalendarEvent[]>>(() => {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events.value) {
    const list = map.get(e.event_date) ?? [];
    list.push(e);
    map.set(e.event_date, list);
  }
  return map;
});

/** 某天的日程：按节次升序，全天（period 为空，含记在列头的备忘）沉到末尾 */
function eventsAt(date: string): CalendarEvent[] {
  return [...(eventsByDate.value.get(date) ?? [])].sort(
    (a, b) => (a.period ?? 99) - (b.period ?? 99) || a.id - b.id
  );
}

async function reloadMonth() {
  const { start, end } = gridRange(grid.value);
  try {
    events.value = await listClassEventsInRange(props.className, start, end);
  } catch {
    events.value = [];
  }
  if (props.timetable) {
    try {
      exceptions.value = await listTimetableExceptionsInRange(props.timetable.id, start, end);
    } catch {
      exceptions.value = [];
    }
  } else {
    exceptions.value = [];
  }
}

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

watch([viewYear, viewMonth], reloadMonth);
watch(
  () => props.className,
  () => {
    // 切班级后回到本月并重新拉该班的日程与调课（组件被复用时不会走 onMounted）
    backToToday();
    void reloadMonth();
  }
);

onMounted(reloadMonth);

/* ---------------- 某天的实际课程（周课表 + 调课例外） ---------------- */

/** 某天逐节的实际课程：套用该天的调课例外 */
function effectiveSlotsOf(date: string): EffectiveSlot[] {
  if (!props.timetable) return [];
  const weekday = weekdayOf(date);
  const base = (slotsByDay.value.get(weekday) ?? []).filter((s) => s.day_of_week === weekday);
  return resolveDaySlots(base, exceptionsByDate.value.get(date) ?? []);
}

/* ---------------- 日详情面板 ---------------- */

const selectedTitle = computed(() => {
  const d = fromDateStr(selectedDate.value);
  const weekday = weekdayOf(selectedDate.value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_LABELS[weekday - 1] ?? CALENDAR_WEEKDAY_LABELS[weekday - 1] ?? ""}`;
});

const selectedCourses = computed(() => effectiveSlotsOf(selectedDate.value));
const selectedEvents = computed(() => eventsAt(selectedDate.value));
const hasException = (course: EffectiveSlot) => course.state !== "normal";

async function afterExceptionChange() {
  await reloadMonth();
}

/* ---------------- 换课（含停课 / 恢复） ---------------- */

const swapPeriod = ref<number | null>(null);
const swapSubject = ref("");

function openSwap(course: EffectiveSlot) {
  swapPeriod.value = course.period;
  swapSubject.value = "";
}

function closeSwap() {
  swapPeriod.value = null;
  swapSubject.value = "";
}

async function confirmSwap() {
  if (!props.timetable || swapPeriod.value === null) return;
  const subject = swapSubject.value.trim();
  if (!subject) return;
  await saveTimetableException(props.timetable.id, selectedDate.value, swapPeriod.value, subject);
  closeSwap();
  await afterExceptionChange();
}

async function cancelCourse(course: EffectiveSlot) {
  if (!props.timetable) return;
  await saveTimetableException(props.timetable.id, selectedDate.value, course.period, "");
  await afterExceptionChange();
}

async function restoreCourse(course: EffectiveSlot) {
  if (!props.timetable) return;
  await clearTimetableException(props.timetable.id, selectedDate.value, course.period);
  await afterExceptionChange();
}

/* ---------------- 加课（原课表该节为空，临时加一节） ---------------- */

const addPeriodOpen = ref(false);
const addPeriodValue = ref<number | null>(null);
const addSubject = ref("");

/** 可加课的节次 = 节次配置里当天还没有课的节 */
const addablePeriods = computed<number[]>(() => {
  const config = (props.timetable?.periods ?? defaultPeriods()).map((p) => p.period);
  const used = new Set(selectedCourses.value.map((c) => c.period));
  return config.filter((p) => !used.has(p));
});

function openAddPeriod() {
  addSubject.value = "";
  addPeriodValue.value = addablePeriods.value[0] ?? null;
  addPeriodOpen.value = true;
}

async function confirmAddPeriod() {
  if (!props.timetable || addPeriodValue.value === null) return;
  const subject = addSubject.value.trim();
  if (!subject) return;
  await saveTimetableException(props.timetable.id, selectedDate.value, addPeriodValue.value, subject);
  addPeriodOpen.value = false;
  await afterExceptionChange();
}

/* ---------------- 日程事件（备忘 / 待办 / 考试 / 作业） ---------------- */

const newEventType = ref<CalendarEventType>("memo");
const newEvent = ref("");
const eventSaving = ref(false);

async function addEvent() {
  const content = newEvent.value.trim();
  if (!content || eventSaving.value) return;
  eventSaving.value = true;
  try {
    await addCalendarEvent(props.className, selectedDate.value, content, newEventType.value);
    newEvent.value = "";
    await reloadMonth();
  } finally {
    eventSaving.value = false;
  }
}

async function toggleEvent(event: CalendarEvent) {
  await setCalendarEventDone(event.id, event.done !== 1);
  await reloadMonth();
}

async function removeEvent(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  await reloadMonth();
}

/** 月格子里最多展示的条目数，其余收进 +n */
const MAX_CELL_ITEMS = 3;
</script>

<template>
  <div class="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
    <!-- 万年历网格 -->
    <div class="rounded-lg border border-hairline bg-canvas p-4" :class="props.surfaceClass" :style="props.surfaceStyle">
      <!-- 月份导航：右上角为「编辑课表」唯一入口 -->
      <div class="mb-3 flex items-center justify-between">
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-md text-weak hover:bg-pearl hover:text-ink transition-colors"
            aria-label="上一月"
            @click="shift(-1)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <h3 class="min-w-[96px] text-center text-body font-semibold text-ink" data-test="calendar-title">
            {{ title }}
          </h3>
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-md text-weak hover:bg-pearl hover:text-ink transition-colors"
            aria-label="下一月"
            @click="shift(1)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
        <div class="flex items-center gap-3">
          <AppLink
            variant="action"
            class="text-caption"
            @click="backToToday"
          >
            回到今天
          </AppLink>
          <button
            type="button"
            data-test="edit-timetable-btn"
            class="flex h-8 items-center gap-1.5 rounded-sm border border-hairline bg-pearl px-3 text-caption text-muted transition-colors hover:border-ink hover:text-ink"
            @click="emit('edit')"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            编辑课表
          </button>
        </div>
      </div>

      <!-- 星期表头（周一起始） -->
      <div class="grid grid-cols-7 gap-px">
        <div
          v-for="label in CALENDAR_WEEKDAY_LABELS"
          :key="label"
          class="flex h-7 items-center justify-center text-fine"
          :class="label === '周六' || label === '周日' ? 'text-weak' : 'text-muted'"
        >
          {{ label }}
        </div>

        <!-- 日期格子 -->
        <template v-for="(week, wi) in grid" :key="wi">
          <button
            v-for="cell in week"
            :key="cell.date"
            type="button"
            data-test="calendar-cell"
            :data-date="cell.date"
            class="group relative flex min-h-[80px] w-full cursor-pointer flex-col items-stretch gap-1 rounded-sm border p-1.5 text-left transition-colors"
            :class="
              selectedDate === cell.date
                ? 'border-primary bg-primary-soft'
                : cell.inMonth
                  ? 'border-hairline bg-canvas hover:border-primary hover:bg-primary-soft/30'
                  : 'border-divider bg-pearl/40 hover:border-primary/40'
            "
            @click="selectedDate = cell.date"
          >
            <!-- 悬浮提示：这个格子可以点、可以记 -->
            <span
              class="pointer-events-none absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-[4px] text-fine leading-none text-primary opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            >
              ＋
            </span>
            <span
              class="text-fine tnum"
              :class="
                today === cell.date
                  ? 'inline-flex h-5 w-5 items-center justify-center rounded-pill bg-primary font-medium text-white'
                  : cell.inMonth
                    ? cell.isWeekend
                      ? 'text-weak'
                      : 'text-muted'
                    : 'text-faint'
              "
            >
              {{ cell.day }}
            </span>

            <!-- 日程事件：类型色点 + 内容（格子里只显示备忘，课程改为悬浮预览） -->
            <template v-for="e in eventsAt(cell.date).slice(0, MAX_CELL_ITEMS)" :key="e.id">
              <span
                data-test="calendar-cell-memo"
                class="flex items-center gap-1 text-fine"
                :class="e.done ? 'text-faint line-through' : 'text-muted'"
              >
                <span
                  class="h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                />
                <span class="shrink-0 text-faint tnum" data-test="calendar-cell-memo-period">
                  {{ eventPeriodLabel(e) }}
                </span>
                <span class="truncate">{{ e.content }}</span>
              </span>
            </template>
            <span
              v-if="eventsAt(cell.date).length > MAX_CELL_ITEMS"
              class="text-fine text-faint"
            >
              +{{ eventsAt(cell.date).length - MAX_CELL_ITEMS }}
            </span>

            <!-- 悬浮预览：当天课程缩略图（逐节列出，套用当天调课例外；停课划线、调/加带徽标） -->
            <span
              v-if="effectiveSlotsOf(cell.date).length"
              data-test="calendar-cell-courses"
              class="pointer-events-none absolute left-1/2 z-20 w-40 -translate-x-1/2 rounded-md border border-hairline bg-canvas p-2 text-left opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
              :class="wi === grid.length - 1 ? 'bottom-full mb-1' : 'top-full mt-1'"
            >
              <span class="mb-1 flex items-center justify-between text-fine font-medium text-ink">
                <span>当天课程</span>
                <span class="tnum text-faint">{{ effectiveSlotsOf(cell.date).length }} 节</span>
              </span>
              <span
                v-for="c in effectiveSlotsOf(cell.date)"
                :key="c.period"
                class="flex items-center gap-1 text-fine leading-5"
              >
                <span class="tnum shrink-0 text-faint">第{{ c.period }}节</span>
                <span
                  class="truncate"
                  :class="c.state === 'cancelled' ? 'text-faint line-through' : 'text-muted'"
                  :title="c.note ?? c.subject"
                >
                  {{ c.subject }}
                </span>
                <span v-if="c.state !== 'normal'" class="shrink-0 text-primary">
                  {{ EXCEPTION_STATE_LABELS[c.state] }}
                </span>
              </span>
            </span>
          </button>
        </template>
      </div>
      <p class="mt-2 text-fine text-weak">
        {{ props.timetable ? "点任意一天：看当天实际课程、换课/停课/加课、记日程；悬浮日期格可预览当天课程" : "点任意一天记日程；课程排好后会自动出现在日历上" }}
      </p>
    </div>

    <!-- 日详情面板 -->
    <div class="space-y-4">
      <div class="rounded-lg border border-hairline bg-canvas p-4">
        <div class="flex items-center justify-between">
          <h3 class="text-body font-semibold text-ink" data-test="selected-title">
            {{ selectedTitle }}
            <span v-if="selectedDate === today" class="ml-1 rounded-pill bg-primary-soft px-2 py-0.5 text-fine text-primary">今天</span>
          </h3>
        </div>

        <!-- 当天实际课程（含调课） -->
        <p class="mt-3 text-fine font-medium text-weak">课程</p>
        <div v-if="!props.timetable" class="mt-1.5 text-caption text-weak">
          暂无课表，点右上角「编辑课表」开始排课
        </div>
        <p v-else-if="!selectedCourses.length" class="mt-1.5 text-caption text-weak">
          {{ slotsByDay.size ? "这一天没有课" : "课表还是空的，点右上角「编辑课表」排课" }}
        </p>
        <ul v-else class="mt-1.5 space-y-1">
          <li
            v-for="c in selectedCourses"
            :key="c.period"
            data-test="day-course"
            class="group/course flex items-center justify-between gap-2 rounded-sm bg-pearl px-2 py-1.5 transition-colors"
          >
            <span class="flex min-w-0 items-baseline gap-1.5">
              <span class="tnum shrink-0 text-caption text-weak">第{{ c.period }}节</span>
              <span
                class="rounded-pill border px-1.5 py-px text-fine leading-4"
                :class="[subjectChipClass(c.subject), c.state === 'cancelled' ? 'line-through opacity-60' : '']"
              >
                {{ c.subject }}
              </span>
              <span
                v-if="hasException(c)"
                class="shrink-0 rounded-pill bg-primary-soft px-1.5 py-px text-fine leading-4 text-primary"
                :title="c.state === 'cancelled' ? '这节停课' : '这天这一节被调过课'"
              >
                {{ EXCEPTION_STATE_LABELS[c.state] }}
              </span>
              <span v-if="c.note" class="truncate text-fine text-weak" :title="c.note">{{ c.note }}</span>
            </span>
            <!-- 调课操作：悬浮出现；有例外时可恢复默认 -->
            <span class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/course:opacity-100">
              <template v-if="!hasException(c)">
                <AppLink
                  data-test="course-swap-btn"
                  variant="action"
                  class="text-fine"
                  @click="openSwap(c)"
                >
                  换课
                </AppLink>
                <AppLink
                  data-test="course-cancel-btn"
                  tone="danger"
                  variant="action"
                  class="text-fine"
                  @click="cancelCourse(c)"
                >
                  停课
                </AppLink>
              </template>
              <AppLink
                v-else
                data-test="course-restore-btn"
                tone="muted"
                variant="action"
                class="text-fine"
                @click="restoreCourse(c)"
              >
                恢复默认
              </AppLink>
            </span>
          </li>
          <!-- 换课内联编辑器 -->
          <li v-if="swapPeriod !== null" data-test="swap-editor" class="rounded-sm border border-hairline bg-canvas p-2">
            <p class="text-fine font-medium text-muted">第{{ swapPeriod }}节 换成 ——</p>
            <div class="mt-1.5 flex flex-wrap gap-1">
              <button
                v-for="s in SUBJECT_PRESETS"
                :key="s"
                type="button"
                class="rounded-pill border px-2 py-0.5 text-fine transition-colors"
                :class="swapSubject === s ? 'border-ink bg-ink font-medium text-canvas' : 'border-hairline text-muted hover:border-ink'"
                @click="swapSubject = s"
              >
                {{ s }}
              </button>
            </div>
            <input
              v-model="swapSubject"
              data-test="swap-subject-input"
              placeholder="或输入自定义科目"
              class="mt-1.5 h-7 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
              @keydown.enter.prevent="confirmSwap"
            />
            <div class="mt-2 flex justify-end gap-2">
              <AppButton variant="pearl" @click="closeSwap">取消</AppButton>
              <AppButton :disabled="!swapSubject.trim()" @click="confirmSwap">确定</AppButton>
            </div>
          </li>
          <!-- 加课 -->
          <li v-if="!addPeriodOpen && props.timetable" class="pt-0.5">
            <AppLink
              data-test="add-course-btn"
              variant="action"
              class="text-fine"
              @click="openAddPeriod"
            >
              ＋ 加一节
            </AppLink>
          </li>
          <li v-if="addPeriodOpen" data-test="add-course-editor" class="rounded-sm border border-hairline bg-canvas p-2">
            <div class="flex items-center gap-2">
              <span class="text-fine text-muted">第</span>
              <select
                v-model.number="addPeriodValue"
                data-test="add-course-period"
                class="h-7 rounded-sm border border-hairline bg-canvas px-1 text-caption text-ink outline-none focus:border-primary-focus"
              >
                <option v-for="p in addablePeriods" :key="p" :value="p">{{ p }}</option>
              </select>
              <span class="text-fine text-muted">节加课</span>
            </div>
            <div class="mt-1.5 flex flex-wrap gap-1">
              <button
                v-for="s in SUBJECT_PRESETS"
                :key="s"
                type="button"
                class="rounded-pill border px-2 py-0.5 text-fine transition-colors"
                :class="addSubject === s ? 'border-ink bg-ink font-medium text-canvas' : 'border-hairline text-muted hover:border-ink'"
                @click="addSubject = s"
              >
                {{ s }}
              </button>
            </div>
            <input
              v-model="addSubject"
              data-test="add-course-subject-input"
              placeholder="或输入自定义科目"
              class="mt-1.5 h-7 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
              @keydown.enter.prevent="confirmAddPeriod"
            />
            <div class="mt-2 flex justify-end gap-2">
              <AppButton variant="pearl" @click="addPeriodOpen = false">取消</AppButton>
              <AppButton :disabled="!addSubject.trim() || addPeriodValue === null" @click="confirmAddPeriod">确定</AppButton>
            </div>
          </li>
        </ul>
        <p v-if="props.timetable && selectedCourses.length" class="mt-2 text-fine text-faint">
          换课 / 停课只对「{{ selectedTitle.split(" ")[0] }}」这一天生效，周课表不变
        </p>
      </div>

      <!-- 日程事件 -->
      <div class="rounded-lg border border-hairline bg-canvas p-4">
        <p class="text-fine font-medium text-weak">日程</p>
        <p v-if="!selectedEvents.length" class="mt-1.5 text-caption text-weak">
          还没有日程，记一条吧（如：收回执单、单元测验、布置作业）
        </p>
        <ul v-else class="mt-1.5 space-y-1">
          <li
            v-for="e in selectedEvents"
            :key="e.id"
            data-test="event-item"
            class="group flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-pearl"
          >
            <button
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
              class="shrink-0 rounded-pill bg-pearl px-1.5 py-px text-fine leading-4 text-weak tnum"
            >
              {{ eventPeriodLabel(e) }}
            </span>
            <span class="min-w-0 flex-1 truncate text-caption" :class="e.done ? 'text-faint line-through' : 'text-ink'">
              {{ e.content }}
            </span>
            <button
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
        <div class="mt-3 flex flex-wrap gap-1">
          <button
            v-for="t in CALENDAR_EVENT_TYPES"
            :key="t"
            type="button"
            data-test="event-type-pill"
            class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine transition-colors"
            :class="newEventType === t ? 'border-ink bg-ink font-medium text-canvas' : 'border-hairline text-muted hover:border-ink'"
            @click="newEventType = t"
          >
            <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
            {{ CALENDAR_EVENT_META[t].label }}
          </button>
        </div>
        <div class="mt-2 flex items-center gap-2">
          <input
            v-model="newEvent"
            data-test="event-input"
            placeholder="添加日程，回车确认"
            class="h-8 flex-1 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
            @keydown.enter.prevent="addEvent"
          />
          <AppButton variant="pearl" :disabled="!newEvent.trim() || eventSaving" @click="addEvent">添加</AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
