<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import FeatureIcon from "../components/FeatureIcon.vue";
import { useClock } from "../composables/useClock";
import { usePagedScroll } from "../composables/usePagedScroll";
import {
  addCalendarEvent,
  deleteCalendarEvent,
  getStats,
  listStudents,
  listTimetableExceptionsWithClass,
  listTimetablePeriodsByClass,
  listTimetableSlotsWithClass,
  listTeacherEventsInRange,
  setCalendarEventDone,
} from "../lib/db";
import {
  CALENDAR_EVENT_META,
  CALENDAR_EVENT_TYPES,
  EXCEPTION_STATE_LABELS,
  WEEKDAY_LABELS,
  buildMyDays,
  buildMySchedule,
  currentSemester,
  defaultPeriods,
  periodsUnion,
  semesterLabel,
  sessionIsNow,
  subjectChipClass,
  subjectDotClass,
  type MyDaySession,
} from "../lib/timetable";
import { fromDateStr, toDateStr } from "../lib/calendar";
import { avatarSrc, ensureProfile, heroSrc, profile } from "../lib/profile";
import type { CalendarEvent, CalendarEventType, Stats, TimetablePeriod } from "../types";

const router = useRouter();
const PAGES = 2;

const viewport = ref<HTMLElement | null>(null);
const { index, heroProgress, goTo, next } = usePagedScroll(PAGES, viewport);
const { hhmm, dateText, yearText, greeting, now } = useClock();

/* 今日课程条 + 展开面板：我的课表取当天（跨班聚合、套用调课例外），
   无命中回退任教学科，未登记不占位；点胶囊带展开毛玻璃面板（轻灵，复杂管理去课表页） */
const todaySessions = ref<MyDaySession[]>([]);
const todayEvents = ref<CalendarEvent[]>([]);
const panelOpen = ref(false);
const mySubjects = computed(() => profile.value.my_subjects ?? []);
/** 每周总课时（第二屏「课程表」常驻卡的描述数据，与今日课程条同一份投影） */
const weeklyTotal = ref(0);

/* ---------------- 首页半透明周课表（一键展开/收起） ---------------- */

/** 本周一~周五的实际日期（列头带 M/D） */
const weekDates = ref<string[]>([]);
/** 本周逐日实际行程（周课表 + 调课例外，按任教学科过滤） */
const weekMyDays = ref<Map<string, MyDaySession[]>>(new Map());
const weekPeriods = ref<TimetablePeriod[]>(defaultPeriods());
/** 今天的日期串（列高亮判断） */
const todayStr = ref(toDateStr(new Date()));

function sessionsAt(date: string, period: number): MyDaySession[] {
  return (weekMyDays.value.get(date) ?? []).filter((s) => s.period === period);
}

function shortDate(date: string): string {
  const d = fromDateStr(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 本周一（YYYY-MM-DD）；周日起算仍归本周 */
function mondayOfThisWeek(): string {
  const d = new Date();
  const weekday = ((d.getDay() + 6) % 7) + 1;
  return toDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (weekday - 1)));
}

/** 第二屏「课程表」卡的描述文案：短句，不做长说明 */
const timetableEntryDesc = computed(() => {
  if (weeklyTotal.value) return `每周 ${weeklyTotal.value} 节 · 今天 ${todaySessions.value.length} 节`;
  if (mySubjects.value.length) return mySubjects.value.join("、");
  return "排课 · 调课 · 日程";
});

function goTimetable() {
  router.push({ name: "timetable" });
}

async function loadTodayTimetable() {
  todayStr.value = toDateStr(new Date());
  const semester = currentSemester();
  const monday = fromDateStr(mondayOfThisWeek());
  const dates = Array.from({ length: 5 }, (_, i) =>
    toDateStr(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
  );
  weekDates.value = dates;
  try {
    const [rows, exceptions, timetablePeriods] = await Promise.all([
      listTimetableSlotsWithClass(semester),
      listTimetableExceptionsWithClass(semester, dates[0], dates[4]),
      listTimetablePeriodsByClass(semester),
    ]);
    const subjects = profile.value.my_subjects ?? [];
    const map = buildMyDays(rows, exceptions, subjects, dates);
    weekMyDays.value = map;
    weekPeriods.value = periodsUnion(timetablePeriods.map((item) => item.periods));
    todaySessions.value = map.get(todayStr.value) ?? [];
    weeklyTotal.value = subjects.length ? buildMySchedule(rows, subjects).weekly_total : 0;
  } catch {
    weekMyDays.value = new Map();
    weekPeriods.value = defaultPeriods();
    todaySessions.value = [];
    weeklyTotal.value = 0;
  }
  try {
    todayEvents.value = await listTeacherEventsInRange(todayStr.value, todayStr.value);
  } catch {
    todayEvents.value = [];
  }
}

/* ---------------- 面板里的日程增删改（教师个人事件，记在今天） ---------------- */

const newEventType = ref<CalendarEventType>("memo");
const newEvent = ref("");
const eventSaving = ref(false);

async function reloadTodayEvents() {
  const todayStr = toDateStr(new Date());
  try {
    todayEvents.value = await listTeacherEventsInRange(todayStr, todayStr);
  } catch {
    todayEvents.value = [];
  }
}

async function addTodayEvent() {
  const content = newEvent.value.trim();
  if (!content || eventSaving.value) return;
  eventSaving.value = true;
  try {
    await addCalendarEvent(null, toDateStr(new Date()), content, newEventType.value);
    newEvent.value = "";
    await reloadTodayEvents();
  } finally {
    eventSaving.value = false;
  }
}

async function toggleTodayEvent(event: CalendarEvent) {
  await setCalendarEventDone(event.id, event.done !== 1);
  await reloadTodayEvents();
}

async function removeTodayEvent(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  await reloadTodayEvents();
}

const stats = ref<Stats>({ students: 0, photos: 0, month_new: 0 });
const classCount = ref(0);
const heroReady = ref(false);
const reducedMotion = ref(false);
let motionQuery: MediaQueryList | null = null;

const updateReducedMotion = () => {
  reducedMotion.value = motionQuery?.matches === true;
};

onMounted(() => {
  if (typeof window === "undefined" || !window.matchMedia) return;
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  updateReducedMotion();
  motionQuery.addEventListener("change", updateReducedMotion);
});

onBeforeUnmount(() => {
  motionQuery?.removeEventListener("change", updateReducedMotion);
  motionQuery = null;
});

// 换图后重新淡入，避免硬切
watch(heroSrc, () => {
  heroReady.value = false;
});

onMounted(async () => {
  await ensureProfile();
  void loadTodayTimetable();
  try {
    const [rows, s] = await Promise.all([listStudents(), getStats()]);
    stats.value = s;
    classCount.value = new Set(rows.map((r) => r.grade_class).filter(Boolean)).size;
  } catch {
    /* 浏览器演示或数据库为空时保持 0，界面仍可用 */
  }
});

const features = computed(() => [
  {
    to: "/classes",
    icon: "classes" as const,
    title: "班级管理",
    desc: `${classCount.value} 个班级 · ${stats.value.students} 名学生`,
  },
  {
    to: "/students",
    icon: "students" as const,
    title: "学生档案",
    desc: `${stats.value.students} 名学生 · 本月新增 ${stats.value.month_new}`,
  },
  {
    to: "/photos",
    icon: "photos" as const,
    title: "图片记录",
    desc: `${stats.value.photos} 张照片 · 全部留在本机`,
  },
  {
    to: "/settings",
    icon: "settings" as const,
    title: "数据与设置",
    desc: "本地 SQLite · 不联网",
  },
]);

/** 首屏文字随滚动上浮淡出，大图同向下沉，做出纵深 */
const heroTextStyle = computed(() => {
  if (reducedMotion.value) return {};
  const p = heroProgress.value;
  return {
    transform: `translate3d(0, ${-p * 72}px, 0)`,
    opacity: String(Math.max(0, 1 - p * 1.5)),
  };
});

const heroImageStyle = computed(() => {
  if (reducedMotion.value) return {};
  const h = viewport.value?.clientHeight ?? 0;
  return { transform: `translate3d(0, ${heroProgress.value * 0.3 * h}px, 0)` };
});

/** 向下箭头只在第 1 屏可见、可点 */
const cueStyle = computed(() => {
  const p = heroProgress.value;
  if (reducedMotion.value) {
    return {
      opacity: String(p > 0.02 ? 0 : 1),
      transform: "translate3d(-50%, 0px, 0)",
      pointerEvents: (p > 0.02 ? "none" : "auto") as "none" | "auto",
    };
  }
  return {
    opacity: String(Math.max(0, 1 - p * 3)),
    transform: `translate3d(-50%, ${p * 24}px, 0)`,
    pointerEvents: (p > 0.02 ? "none" : "auto") as "none" | "auto",
  };
});

/** 页码指示器要跟着底色反转：第 1 屏深色底用白，第 2 屏浅色底用墨 */
const dotClass = (i: number) => {
  const onDark = index.value === 0;
  if (index.value === i) return `h-6 w-2 ${onDark ? "bg-white" : "bg-ink"}`;
  return `h-2 w-2 ${onDark ? "bg-white/35 hover:bg-white/60" : "bg-faint hover:bg-weak"}`;
};
</script>

<template>
  <div class="relative h-full overflow-hidden">
    <!-- 翻页层与悬浮层分开：聊天区里的滚轮/按键不会触发翻页，悬浮层也不随内容滚动 -->
    <div
      ref="viewport"
      class="relative h-full snap-y snap-mandatory overflow-y-auto scrollbar-none"
    >
    <!-- ══════════════ 第 1 屏：全屏大图 + 实时时间 ══════════════ -->
    <section
      data-page="0"
      class="relative h-full w-full shrink-0 snap-start overflow-hidden bg-tile"
    >
      <!-- 用户设置的大图：缓慢 Ken Burns + 滚动视差 -->
      <div class="absolute inset-0 will-change-transform" :style="heroImageStyle">
        <img
          :key="heroSrc"
          :src="heroSrc"
          alt=""
          class="hero-ken h-full w-full object-cover transition-opacity duration-700"
          :class="heroReady ? 'opacity-100' : 'opacity-0'"
          draggable="false"
          @load="heroReady = true"
        />
      </div>

      <!-- 上下双向压暗，只为保证白字可读 -->
      <div class="absolute inset-0 bg-gradient-to-b from-black/45 via-transparent to-black/75" />

      <!-- 顶栏浮在大图上 -->
      <header
        class="absolute inset-x-0 top-0 flex h-[76px] items-center justify-between px-12"
        :style="heroTextStyle"
      >
        <span class="text-tagline font-semibold -tracking-[0.3px] text-white">aprilio</span>

        <div class="flex items-center gap-3">
          <RouterLink
            to="/settings"
            class="flex h-9 w-9 items-center justify-center rounded-pill bg-white/15 text-white backdrop-blur transition-[transform,background-color] hover:bg-white/25 active:scale-[0.95]"
            title="数据与设置"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
              <circle cx="9" cy="7" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
              <circle cx="15" cy="12" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
              <circle cx="8" cy="17" r="2.3" fill="none" stroke="currentColor" stroke-width="1.8" />
            </svg>
          </RouterLink>

          <!-- 点头像进资料编辑 -->
          <RouterLink
            to="/profile"
            class="group relative block h-11 w-11 shrink-0 rounded-pill ring-1 ring-white/40 transition-transform duration-200 hover:scale-[1.06] active:scale-[0.95]"
            title="编辑个人资料"
          >
            <img
              :src="avatarSrc"
              :alt="profile.name"
              class="h-full w-full rounded-pill object-cover"
              draggable="false"
            />
            <span
              class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-pill bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M4 20h4l10-10a2.4 2.4 0 0 0-3.4-3.4L4.6 16.6 4 20Z"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </RouterLink>
        </div>
      </header>

      <!-- 主信息区：时间信息收在左下角 -->
      <div class="absolute bottom-9 left-12 max-w-[760px]" :style="heroTextStyle">
        <p class="text-caption tracking-[0.6px] text-white/55">
          {{ yearText }} · {{ semesterLabel(currentSemester(now)) }}
        </p>

        <!-- 实时时钟：分钟更新，避免频繁变化造成视觉抖动 -->
        <time
          class="mt-3 block tnum text-[72px] font-semibold leading-none -tracking-[2px] text-white"
          aria-live="polite"
        >
          {{ hhmm }}
        </time>

        <p class="mt-3 text-body text-white/70">{{ dateText }}</p>

        <h1 class="mt-7 text-display font-semibold -tracking-[0.37px] text-white">
          {{ greeting }}，{{ profile.name }}
        </h1>
        <p v-if="profile.motto" class="mt-1.5 text-airy font-light text-white/65">
          {{ profile.motto }}
        </p>

      </div>

      <!-- 课程表入口：常驻左侧中间，一键展开/收起（面板打开时高亮，再点即收） -->
      <button
        type="button"
        data-test="timetable-toggle"
        class="absolute left-12 top-1/2 z-40 flex -translate-y-1/2 items-center gap-2 rounded-pill px-4 py-2 text-caption backdrop-blur transition-colors"
        :class="panelOpen ? 'bg-white/90 font-medium text-ink' : 'bg-white/15 text-white/85 hover:bg-white/25'"
        :aria-expanded="panelOpen"
        aria-label="展开或收起课程表"
        @click="panelOpen = !panelOpen"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4.6 5.4h14.8a1.6 1.6 0 0 1 1.6 1.6v11.6a1.6 1.6 0 0 1-1.6 1.6H4.6a1.6 1.6 0 0 1-1.6-1.6V7a1.6 1.6 0 0 1 1.6-1.6ZM8.2 3v4M15.8 3v4M3.4 10.2h17.2"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        课表
        <span
          v-if="todaySessions.length && !panelOpen"
          class="tnum rounded-pill bg-primary px-1.5 py-px text-fine leading-4 text-white"
        >
          {{ todaySessions.length }}
        </span>
      </button>

      <!-- 展开遮罩：压暗背景文案，点空白处收起 -->
      <div
        v-if="panelOpen"
        data-test="panel-scrim"
        class="absolute inset-0 z-20 bg-black/40"
        @click="panelOpen = false"
      />

      <!-- 展开面板：首页居中的半透明周课表（调课生效、今天列高亮）+ 今日日程 -->
      <div
        v-if="panelOpen"
        data-test="today-panel"
        class="glass-dark absolute left-1/2 top-1/2 z-30 max-h-[76vh] w-[min(880px,calc(100vw-96px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto scroll-thin rounded-lg p-5"
      >
            <div class="flex items-center justify-between gap-3">
              <p class="text-caption font-semibold tracking-[0.5px] text-white/85">课程表 · 本周</p>
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="text-caption text-primary-on-dark hover:underline"
                  @click="goTimetable"
                >
                  完整课表 →
                </button>
                <button
                  type="button"
                  data-test="panel-close"
                  class="flex h-7 w-7 items-center justify-center rounded-pill text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                  aria-label="收起面板"
                  @click="panelOpen = false"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- 半透明周课表：列 = 周一~周五（带日期），行 = 节次；格子 = 我的课（调课后实际形态） -->
            <div data-test="panel-week-grid" class="mt-3 grid grid-cols-[36px_repeat(5,minmax(0,1fr))] gap-1">
              <div></div>
              <div
                v-for="(date, i) in weekDates"
                :key="date"
                class="flex h-7 items-center justify-center gap-1.5 rounded-sm text-fine"
                :class="date === todayStr ? 'bg-white/20 font-medium text-white' : 'text-white/50'"
              >
                {{ WEEKDAY_LABELS[i] }}
                <span class="tnum opacity-70">{{ shortDate(date) }}</span>
              </div>
              <template v-for="p in weekPeriods" :key="p.period">
                <div data-test="panel-period-cell" class="flex items-center justify-center rounded-sm bg-white/[0.06] tnum text-fine text-white/40">
                  {{ p.period }}
                </div>
                <div
                  v-for="date in weekDates"
                  :key="`${p.period}-${date}`"
                  class="flex min-h-[44px] flex-col gap-1 rounded-sm p-px"
                  :class="date === todayStr ? 'bg-white/[0.07]' : ''"
                >
                  <div
                    v-for="s in sessionsAt(date, p.period)"
                    :key="`${s.class_name}-${s.subject}`"
                    data-test="panel-grid-session"
                    class="rounded-md border border-white/10 bg-white/5 px-2 py-1"
                    :class="date === todayStr && sessionIsNow(s, now) ? 'border-primary-on-dark/70 bg-white/15' : ''"
                  >
                    <div class="flex items-center gap-1.5">
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="subjectDotClass(s.subject)" />
                      <span
                        class="truncate text-fine font-medium"
                        :class="s.state === 'cancelled' ? 'text-white/50 line-through' : 'text-white/90'"
                      >{{ s.subject }}</span>
                      <span
                        v-if="s.state !== 'normal'"
                        class="ml-auto shrink-0 rounded-pill px-1.5 text-fine leading-4"
                        :class="s.state === 'cancelled' ? 'bg-white/10 text-white/60' : 'bg-primary-on-dark/25 text-primary-on-dark'"
                      >
                        {{ s.state === "cancelled" ? "停" : EXCEPTION_STATE_LABELS[s.state] }}
                      </span>
                    </div>
                    <p class="truncate text-fine text-white/40">{{ s.class_name }}</p>
                  </div>
                </div>
              </template>
            </div>
            <p v-if="!mySubjects.length" class="mt-2 text-fine text-white/40">
              登记任教学科后，这里显示你跨班的课；日程不受影响
            </p>

            <!-- 今日日程：班级事件 + 个人事件，可勾选完成、速记一条 -->
            <div class="mt-4 border-t border-white/10 pt-3">
              <p class="text-fine font-medium tracking-[0.5px] text-white/60">今日日程</p>
              <p v-if="!todayEvents.length" class="mt-2 px-3 text-caption text-white/45">
                今天还没有日程，随手记一条（待办 / 考试 / 作业 / 备忘）
              </p>
              <ul v-else class="mt-2 space-y-0.5">
                <li
                  v-for="e in todayEvents"
                  :key="e.id"
                  data-test="panel-event"
                  class="group flex items-center gap-2.5 rounded-md px-3 py-1.5 hover:bg-white/10"
                >
                  <button
                    type="button"
                    class="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors"
                    :class="e.done ? 'border-primary-on-dark bg-primary-on-dark' : 'border-white/40 hover:border-white'"
                    :aria-label="e.done ? '标记为待办' : '标记为已完成'"
                    @click="toggleTodayEvent(e)"
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
                  <span class="min-w-0 flex-1 truncate text-caption" :class="e.done ? 'text-white/35 line-through' : 'text-white/85'">
                    <span v-if="e.period" class="mr-1 text-white/50">第{{ e.period }}节</span>{{ e.content }}
                  </span>
                  <span v-if="e.class_name" class="shrink-0 text-fine text-white/40">{{ e.class_name }}</span>
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/40 opacity-0 transition-opacity hover:bg-white/15 hover:text-white group-hover:opacity-100"
                    aria-label="删除日程"
                    @click="removeTodayEvent(e)"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    </svg>
                  </button>
                </li>
              </ul>
              <div class="mt-3 flex flex-wrap items-center gap-1.5 px-1">
                <button
                  v-for="t in CALENDAR_EVENT_TYPES"
                  :key="t"
                  type="button"
                  class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine transition-colors"
                  :class="newEventType === t ? 'border-white bg-white font-medium text-ink' : 'border-white/25 text-white/60 hover:border-white/60'"
                  @click="newEventType = t"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
                  {{ CALENDAR_EVENT_META[t].label }}
                </button>
                <input
                  v-model="newEvent"
                  data-test="panel-event-input"
                  :placeholder="`记一条${CALENDAR_EVENT_META[newEventType].label}，回车确认`"
                  class="h-8 min-w-[160px] flex-1 rounded-sm border border-white/20 bg-white/10 px-2.5 text-caption text-white outline-none placeholder:text-white/35 focus:border-white/50"
                  @keydown.enter.prevent="addTodayEvent"
                />
              </div>
            </div>
          </div>

      <!-- 向下提示：会弹动，点了就翻页 -->
      <button
        type="button"
        class="absolute bottom-9 left-1/2 flex flex-col items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-4"
        :style="cueStyle"
        aria-label="向下滚动到功能页"
        @click="next()"
      >
        <span class="text-fine tracking-[1.4px] text-white/55">向下</span>
        <span
          class="flex h-11 w-11 items-center justify-center rounded-pill border border-white/30 bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 active:scale-[0.95]"
        >
          <svg
            class="arrow-bounce"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M6 9.5l6 6 6-6"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </button>
    </section>

    <!-- ══════════════ 第 2 屏：功能入口 ══════════════ -->
    <section
      data-page="1"
      class="relative flex h-full w-full shrink-0 snap-start flex-col bg-canvas px-12 pb-9 pt-14"
    >
      <div class="flex w-full flex-1 items-center justify-center">
        <div class="w-full max-w-[1000px]" data-page-scroll>
        <div class="flex items-baseline justify-between">
          <h2 class="text-display font-semibold -tracking-[0.37px] text-ink">从哪里开始</h2>
          <RouterLink to="/profile" class="text-caption text-primary hover:underline">
            编辑个人资料 →
          </RouterLink>
        </div>
        <p class="mt-2 text-body text-weak">所有数据都留在这台电脑上，不联网、不上传。</p>

        <div class="mt-9 grid grid-cols-2 gap-4">
          <!-- 课程表：教师工作高频入口，常驻第一张（占满整行），右侧带今天课程速览 -->
          <RouterLink
            to="/timetable"
            data-test="timetable-entry"
            class="group col-span-2 flex items-center gap-5 rounded-lg border border-hairline bg-canvas p-6 transition-[background-color,border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-faint hover:bg-pearl active:scale-[0.99]"
          >
            <div
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-parchment text-primary transition-colors group-hover:bg-primary-soft"
            >
              <FeatureIcon name="timetable" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-tagline font-semibold -tracking-[0.3px] text-ink">课程表</p>
              <p class="mt-1 truncate text-caption text-weak">{{ timetableEntryDesc }}</p>
            </div>
            <div v-if="todaySessions.length" class="hidden items-center gap-1.5 lg:flex" data-test="entry-today-chips">
              <span
                v-for="s in todaySessions.slice(0, 4)"
                :key="`${s.period}-${s.subject}-${s.class_name}`"
                class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine"
                :class="[subjectChipClass(s.subject), s.state === 'cancelled' ? 'line-through opacity-60' : '']"
              >
                <span class="tnum opacity-60">第{{ s.period }}节</span>{{ s.subject }}
              </span>
              <span v-if="todaySessions.length > 4" class="text-fine text-faint">
                +{{ todaySessions.length - 4 }}
              </span>
            </div>
            <svg
              class="shrink-0 text-faint transition-[transform,color] duration-150 group-hover:translate-x-0.5 group-hover:text-weak"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M9 5l7 7-7 7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </RouterLink>

          <RouterLink
            v-for="f in features"
            :key="f.to"
            :to="f.to"
            class="group flex items-center gap-5 rounded-lg border border-hairline bg-canvas p-6 transition-[background-color,border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-faint hover:bg-pearl active:scale-[0.99]"
          >
            <div
              class="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-parchment text-primary transition-colors group-hover:bg-primary-soft"
            >
              <FeatureIcon :name="f.icon" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-tagline font-semibold -tracking-[0.3px] text-ink">{{ f.title }}</p>
              <p class="mt-1 truncate text-caption text-weak">{{ f.desc }}</p>
            </div>
            <svg
              class="shrink-0 text-faint transition-[transform,color] duration-150 group-hover:translate-x-0.5 group-hover:text-weak"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M9 5l7 7-7 7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </RouterLink>
        </div>

        <div class="mt-7 flex items-center justify-between">
          <p class="text-fine text-faint">滚轮、↓ 键、空格都能翻页 · 点头像可编辑资料和首页大图</p>
          <RouterLink to="/design" class="text-fine text-faint hover:text-weak">设计系统</RouterLink>
        </div>
        </div>
      </div>
    </section>

    <!-- 页码指示器 -->
    <nav
      class="fixed right-7 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2.5"
      aria-label="页面导航"
    >
      <button
        v-for="i in PAGES"
        :key="i"
        type="button"
        class="rounded-pill transition-all duration-300"
        :class="dotClass(i - 1)"
        :aria-label="`第 ${i} 页`"
        :aria-current="index === i - 1 ? 'page' : undefined"
        @click="goTo(i - 1)"
      />
    </nav>
    </div>
  </div>
</template>
