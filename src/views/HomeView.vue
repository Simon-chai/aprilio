<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { onPageAction } from "../agent/page-action-bus";
import FeatureIcon from "../components/FeatureIcon.vue";
import appIcon from "../assets/app-icon.png";
import BackgroundPickerDialog from "../components/BackgroundPickerDialog.vue";
import { useClock } from "../composables/useClock";
import { usePagedScroll } from "../composables/usePagedScroll";
import AppLink from "../components/ui/AppLink.vue";
import {
  getStats,
  listStudents,
  listTimetableExceptionsWithClass,
  listTimetablePeriodsByClass,
  listTimetableSlotsWithClass,
  listTeacherEventsInRange,
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
  eventPeriodLabel,
  mergeColumnBlocks,
  mineOfClassResolver,
  periodsUnion,
  semesterLabel,
  sessionIsNow,
  sessionProgress,
  subjectChipClass,
  subjectGlassBlockClass,
  type MyDaySession,
} from "../lib/timetable";
import { fromDateStr, toDateStr } from "../lib/calendar";
import {
  avatarSrc,
  ensureProfile,
  heroSrc,
  profile,
  saveProfileChanges,
  timetableBgSrc,
} from "../lib/profile";
import { ensureBackgroundLibrary, markBackgroundUsed } from "../lib/backgrounds";
import type { CalendarEvent, CalendarEventType, Stats, TimetablePeriod } from "../types";

const PAGES = 2;

const viewport = ref<HTMLElement | null>(null);
/** 番茄钟沉浸层打开时禁掉滚轮/按键翻页（需在 usePagedScroll 之前声明） */
const pomodoroOpen = ref(false);
const { index, heroProgress, goTo, next } = usePagedScroll(
  PAGES,
  viewport,
  () => !pomodoroOpen.value
);
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

/** 每列（每天）连堂合并后的渲染块：content 统一为数组（单课为单元素数组，空格为空） */
interface PanelBlock {
  content: MyDaySession[];
  span: number;
  covered: boolean;
}

const panelColumns = computed<PanelBlock[][]>(() =>
  weekDates.value.map((date) =>
    mergeColumnBlocks(
      weekPeriods.value.map((p) => {
        const list = sessionsAt(date, p.period);
        return list.length ? list : null;
      }),
      (s) => `${s.class_name}|${s.subject}|${s.state}|${s.note ?? ""}`
    ).map((b) => ({
      span: b.span,
      covered: b.covered,
      content: Array.isArray(b.content) ? b.content : b.content ? [b.content] : [],
    }))
  )
);

/** 「正在上」的进度条宽度：0~100%，未配置节次时间返回空串（不渲染） */
function progressOf(session: MyDaySession): string {
  const p = sessionProgress(session, now.value);
  return p === null ? "" : `${Math.round(p * 100)}%`;
}

/* ---------------- 面板背景图：选图存 profile，换图清理旧文件 ---------------- */

/** 面板背景样式：有图时叠一层深色遮罩保证可读性 */
const panelBgStyle = computed(() => {
  const src = timetableBgSrc.value;
  if (!src) return undefined;
  return {
    backgroundImage: `linear-gradient(rgba(12,14,18,0.55), rgba(12,14,18,0.55)), url(${src})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
});

/* 背景选择器：本地上传 / 网络链接 / 历史切换；换下来的图留在图库里，随时切回 */
const bgPickerOpen = ref(false);

function openPanelBgPicker(): void {
  void ensureBackgroundLibrary();
  bgPickerOpen.value = true;
}

/** 选图立即生效（首页没有保存按钮）；旧图保留在图库中，不删文件 */
async function applyPanelBg(file: string): Promise<void> {
  markBackgroundUsed("timetable_bg", file);
  await saveProfileChanges({ ...profile.value, timetable_bg: file }).catch(() => undefined);
}

/** 移除当前背景：只清空引用，图仍在图库里可以再切回来 */
async function clearPanelBg(): Promise<void> {
  if (!profile.value.timetable_bg) return;
  await saveProfileChanges({ ...profile.value, timetable_bg: "" }).catch(() => undefined);
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

/* 小屏时展开面板左缘会盖住课表按钮：面板打开后按钮默认沉底被课表挡住，
   鼠标进入按钮区域才上浮可点（被覆盖的元素收不到 hover，需用 mousemove 判断） */
const toggleBtn = ref<HTMLButtonElement | null>(null);
const toggleHover = ref(false);

function onHeroMouseMove(e: MouseEvent) {
  if (!panelOpen.value) {
    toggleHover.value = false;
    return;
  }
  const r = toggleBtn.value?.getBoundingClientRect();
  toggleHover.value =
    !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
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
    const mineOf = mineOfClassResolver(rows, subjects);
    const map = buildMyDays(rows, exceptions, mineOf, dates);
    weekMyDays.value = map;
    weekPeriods.value = periodsUnion(timetablePeriods.map((item) => item.periods));
    todaySessions.value = map.get(todayStr.value) ?? [];
    weeklyTotal.value = buildMySchedule(rows, mineOf).weekly_total;
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

/* ---------------- 面板底层的当天日程：只读展示，胶囊按类型筛选（同课表详情） ---------------- */

const typeFilter = ref<CalendarEventType | null>(null);

function toggleTypeFilter(type: CalendarEventType) {
  typeFilter.value = typeFilter.value === type ? null : type;
}

/** 选中类型后，未命中的条目置灰（与课表详情一致） */
function isEventDimmed(event: CalendarEvent): boolean {
  return typeFilter.value !== null && event.type !== typeFilter.value;
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

/* ---------------- 番茄时钟：全屏沉浸倒计时（背景只剩大图） ---------------- */

type PomodoroMode = "focus" | "short" | "long";

const POMODORO_MODES: { key: PomodoroMode; label: string }[] = [
  { key: "focus", label: "专注" },
  { key: "short", label: "短休息" },
  { key: "long", label: "长休息" },
];
/** 各模式默认时长（分钟） */
const POMODORO_MINUTES: Record<PomodoroMode, number> = { focus: 25, short: 5, long: 15 };
/** 进度环几何：viewBox 200，半径 88 */
const POMODORO_CIRCUMFERENCE = 2 * Math.PI * 88;

const pomodoroMode = ref<PomodoroMode>("focus");
const pomodoroRemaining = ref(POMODORO_MINUTES.focus * 60);
const pomodoroRunning = ref(false);
const pomodoroDone = ref(false);
/** 运行中的目标时间戳：按绝对时间倒推，后台被节流也不会走慢 */
let pomodoroEndAt = 0;
let pomodoroTicker = 0;

const pomodoroTotal = computed(() => POMODORO_MINUTES[pomodoroMode.value] * 60);
const pomodoroText = computed(() => {
  const t = pomodoroRemaining.value;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
});
/** 已流逝比例（0~1），驱动进度环 */
const pomodoroElapsed = computed(() => 1 - pomodoroRemaining.value / pomodoroTotal.value);
const pomodoroModeLabel = computed(
  () => POMODORO_MODES.find((m) => m.key === pomodoroMode.value)?.label ?? ""
);
/** 主按钮文案：完成后一键重开本轮，暂停中可继续 */
const pomodoroAction = computed(() =>
  pomodoroDone.value
    ? "再来一轮"
    : pomodoroRunning.value
      ? "暂停"
      : pomodoroRemaining.value < pomodoroTotal.value
        ? "继续"
        : "开始"
);

function stopPomodoroTick() {
  window.clearInterval(pomodoroTicker);
  pomodoroTicker = 0;
}

function pomodoroTick() {
  const left = Math.ceil((pomodoroEndAt - Date.now()) / 1000);
  pomodoroRemaining.value = Math.max(0, left);
  if (left <= 0) {
    stopPomodoroTick();
    pomodoroRunning.value = false;
    pomodoroDone.value = true;
  }
}

function togglePomodoroRunning() {
  if (pomodoroRunning.value) {
    stopPomodoroTick();
    pomodoroRunning.value = false;
    return;
  }
  if (pomodoroDone.value) {
    pomodoroDone.value = false;
    pomodoroRemaining.value = pomodoroTotal.value;
  }
  pomodoroEndAt = Date.now() + pomodoroRemaining.value * 1000;
  pomodoroTicker = window.setInterval(pomodoroTick, 250);
  pomodoroRunning.value = true;
}

function resetPomodoro() {
  stopPomodoroTick();
  pomodoroRunning.value = false;
  pomodoroDone.value = false;
  pomodoroRemaining.value = pomodoroTotal.value;
}

function switchPomodoroMode(mode: PomodoroMode) {
  if (pomodoroMode.value === mode) return;
  pomodoroMode.value = mode;
  resetPomodoro();
}

/** 进入沉浸层：收起课表面板、回到第 1 屏，让浮层透出的一定是大图 */
function openPomodoro() {
  panelOpen.value = false;
  goTo(0);
  pomodoroOpen.value = true;
}

/** 退出即暂停，回来接着走 */
function closePomodoro() {
  pomodoroOpen.value = false;
  if (pomodoroRunning.value) togglePomodoroRunning();
}

/** Esc 退出、空格开始/暂停（沉浸层打开时翻页键已被禁用，不冲突） */
function onPomodoroKeydown(e: KeyboardEvent) {
  if (!pomodoroOpen.value) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closePomodoro();
  } else if (e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    togglePomodoroRunning();
  }
}

onMounted(() => window.addEventListener("keydown", onPomodoroKeydown));

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onPomodoroKeydown);
  stopPomodoroTick();
});

// Agent 的 ui_action 广播：打开番茄钟动作 → 进入沉浸层（src/agent/page-actions/home.ts）
const offPomodoroAction = onPageAction("home/open-pomodoro", () => openPomodoro());
onBeforeUnmount(offPomodoroAction);

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

/** 首屏文字随滚动上浮淡出，大图同向下沉，做出纵深（番茄钟沉浸层打开时由 v-show 隐藏整块） */
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

/** 向下箭头只在第 1 屏可见、可点（番茄钟沉浸层打开时由 v-show 隐藏） */
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
      @mousemove="onHeroMouseMove"
      @mouseleave="toggleHover = false"
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

      <!-- 顶栏浮在大图上（番茄钟沉浸层打开时隐藏，背景只剩图） -->
      <header
        v-show="!pomodoroOpen"
        class="absolute inset-x-0 top-0 flex h-[76px] items-center justify-between px-12"
        :style="heroTextStyle"
      >
        <div class="flex items-center gap-2.5">
          <img
            :src="appIcon"
            alt="aprilio"
            class="h-8 w-8 rounded-sm object-cover shadow-sm"
            draggable="false"
          />
          <span class="text-tagline font-semibold -tracking-[0.3px] text-white">aprilio</span>
        </div>

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
      <div v-show="!pomodoroOpen" class="absolute bottom-9 left-12 max-w-[760px]" :style="heroTextStyle">
        <p class="text-caption tracking-[0.6px] text-white/55">
          {{ yearText }} · {{ semesterLabel(currentSemester(now)) }}
        </p>

        <!-- 实时时钟：分钟更新，避免频繁变化造成视觉抖动；
             右侧下标位置挂番茄钟入口（时钟图标，比数字小、贴基线） -->
        <div class="mt-3 flex items-end gap-2.5">
          <time
            class="tnum block text-[72px] font-semibold leading-none -tracking-[2px] text-white"
            aria-live="polite"
          >
            {{ hhmm }}
          </time>
          <button
            type="button"
            data-test="pomodoro-toggle"
            class="mb-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-pill bg-white/15 text-white/85 backdrop-blur transition-colors hover:bg-white/25 active:scale-[0.95]"
            aria-label="进入番茄时间"
            title="进入番茄时间"
            @click="openPomodoro"
          >
            <svg class="pointer-events-none" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="8.2" stroke="currentColor" stroke-width="1.8" />
              <path
                d="M12 7.6V12l3 1.8"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <p class="mt-3 text-body text-white/70">{{ dateText }}</p>

        <h1 class="mt-7 text-display font-semibold -tracking-[0.37px] text-white">
          {{ greeting }}，{{ profile.name }}
        </h1>
        <p v-if="profile.motto" class="mt-1.5 text-airy font-light text-white/65">
          {{ profile.motto }}
        </p>

      </div>

      <!-- 课程表入口：常驻左侧中间，一键展开/收起（面板打开时沉底让路，鼠标移入该区域才上浮） -->
      <button
        v-show="!pomodoroOpen"
        ref="toggleBtn"
        type="button"
        data-test="timetable-toggle"
        class="absolute left-12 top-1/2 flex -translate-y-1/2 items-center gap-2 rounded-pill px-4 py-2 text-caption backdrop-blur transition-all duration-200"
        :class="panelOpen
          ? (toggleHover
              ? 'z-50 bg-white/90 font-medium text-ink ring-4 ring-white/40 shadow-lg shadow-black/30'
              : 'z-0 bg-white/15 text-white/85')
          : 'z-40 bg-white/15 text-white/85 ring-1 ring-white/20 hover:bg-white/90 hover:font-medium hover:text-ink hover:ring-4 hover:ring-white/40 hover:shadow-lg hover:shadow-black/30'"
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

      <!-- 展开面板：首页正中的小巧半透明周课表（连堂合并、深色彩块、正在上高亮）+ 当天备忘 -->
      <div
        v-if="panelOpen"
        data-test="today-panel"
        class="glass-dark absolute left-1/2 top-1/2 z-30 max-h-[76vh] w-[min(520px,calc(100vw-96px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto scroll-thin rounded-lg p-4"
        :style="panelBgStyle"
      >
            <div class="flex items-center justify-between gap-3">
              <p class="text-caption font-semibold tracking-[0.5px] text-white/85">课程表 · 本周</p>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  data-test="panel-bg-btn"
                  class="flex h-6 w-6 items-center justify-center rounded-pill text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                  aria-label="设置面板背景图"
                  title="设置面板背景图"
                  @click="openPanelBgPicker"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M4.6 7.4h3.1l1.6-2.2h5.4l1.6 2.2h3.1a1.6 1.6 0 0 1 1.6 1.6v9a1.6 1.6 0 0 1-1.6 1.6H4.6a1.6 1.6 0 0 1-1.6-1.6V9a1.6 1.6 0 0 1 1.6-1.6Z"
                      stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"
                    />
                    <circle cx="12" cy="13.2" r="3.1" stroke="currentColor" stroke-width="1.7" />
                  </svg>
                </button>
                <button
                  v-if="profile.timetable_bg"
                  type="button"
                  data-test="panel-bg-clear"
                  class="flex h-6 w-6 items-center justify-center rounded-pill text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                  aria-label="清除面板背景图"
                  title="清除面板背景图"
                  @click="clearPanelBg"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M4.5 6.5h15M9.7 6.2V4.9a.9.9 0 0 1 .9-.9h2.8a.9.9 0 0 1 .9.9v1.3M7.2 6.7l.6 11.6a1.6 1.6 0 0 0 1.6 1.5h5.2a1.6 1.6 0 0 0 1.6-1.5l.6-11.6"
                      stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
                    />
                  </svg>
                </button>
                <AppLink tone="onDarkSolid" to="/timetable" class="font-medium">完整课表</AppLink>
                <button
                  type="button"
                  data-test="panel-close"
                  class="flex h-6 w-6 items-center justify-center rounded-pill text-white/60 transition-colors hover:bg-white/15 hover:text-white"
                  aria-label="收起面板"
                  @click="panelOpen = false"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- 小巧周课表：列 = 周一~周五（带日期），行 = 节次；连堂合并成跨行彩块，只显示科目 -->
            <div
              data-test="panel-week-grid"
              class="mt-2.5 grid grid-cols-[22px_repeat(5,minmax(0,1fr))] gap-1"
              :style="{ gridTemplateRows: `24px repeat(${weekPeriods.length}, 28px)` }"
            >
              <div></div>
              <div
                v-for="(date, i) in weekDates"
                :key="date"
                class="flex h-6 items-center justify-center gap-1 rounded-sm text-fine"
                :class="date === todayStr ? 'bg-white/20 font-medium text-white' : 'text-white/50'"
                :style="{ gridColumn: String(i + 2) }"
              >
                {{ WEEKDAY_LABELS[i] }}
                <span class="tnum opacity-70">{{ shortDate(date) }}</span>
              </div>
              <div
                v-for="(p, pi) in weekPeriods"
                :key="`p-${p.period}`"
                data-test="panel-period-cell"
                class="flex items-center justify-center rounded-sm bg-white/[0.06] tnum text-fine text-white/40"
                :style="{ gridRow: String(pi + 2) }"
              >
                {{ p.period }}
              </div>
              <!-- 各天课程块：连堂合并（span>1 跨行），撞课原样多块 -->
              <template v-for="(blocks, di) in panelColumns" :key="`col-${weekDates[di]}`">
                <template v-for="(block, bi) in blocks" :key="`b-${weekDates[di]}-${bi}`">
                  <div
                    v-if="!block.covered && block.content.length"
                    class="flex flex-col gap-0.5 p-px"
                    :style="{
                      gridColumn: String(di + 2),
                      gridRow: block.span > 1 ? `${bi + 2} / span ${block.span}` : String(bi + 2),
                    }"
                  >
                    <div
                      v-for="s in block.content"
                      :key="`${s.class_name}-${s.subject}-${s.period}`"
                      data-test="panel-grid-session"
                      class="relative flex min-h-[24px] flex-1 items-center justify-center gap-1 overflow-hidden rounded-md px-1 py-1"
                      :class="[
                        subjectGlassBlockClass(s.subject),
                        s.state === 'cancelled' ? 'opacity-70' : '',
                        s.date === todayStr && sessionIsNow(s, now) ? 'ring-2 ring-primary-on-dark' : '',
                      ]"
                    >
                      <span
                        class="truncate text-fine font-medium"
                        :class="s.state === 'cancelled' ? 'text-white/60 line-through' : 'text-white/95'"
                      >{{ s.subject }}</span>
                      <span
                        v-if="s.state !== 'normal'"
                        class="shrink-0 rounded-pill px-1 text-fine leading-3"
                        :class="s.state === 'cancelled' ? 'bg-white/10 text-white/60' : 'bg-primary-on-dark/25 text-primary-on-dark'"
                      >
                        {{ EXCEPTION_STATE_LABELS[s.state] }}
                      </span>
                      <!-- 正在上：呼吸点 + 时间进度条 -->
                      <template v-if="s.date === todayStr && sessionIsNow(s, now)">
                        <span
                          data-test="panel-session-now-dot"
                          class="absolute left-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-primary-on-dark"
                        />
                        <span
                          v-if="progressOf(s)"
                          data-test="panel-session-progress"
                          class="absolute inset-x-1 bottom-0.5 h-[3px] overflow-hidden rounded-pill bg-white/20"
                        >
                          <span class="block h-full rounded-pill bg-primary-on-dark" :style="{ width: progressOf(s) }" />
                        </span>
                      </template>
                    </div>
                  </div>
                </template>
              </template>
            </div>
            <p v-if="!mySubjects.length" class="mt-2 text-fine text-white/40">
              登记任教学科或在班级课表标记「我的科目」后，这里显示你跨班的课；日程不受影响
            </p>

            <!-- 今日日程：只读展示当天行程，沉在面板最底层；右上胶囊按类型筛选，再点取消 -->
            <div class="mt-3 border-t border-white/10 pt-2.5">
              <div class="flex items-center justify-between gap-2">
                <p class="text-fine font-medium tracking-[0.5px] text-white/60">今日日程</p>
                <div class="flex items-center gap-1.5">
                  <button
                    v-for="t in CALENDAR_EVENT_TYPES"
                    :key="t"
                    type="button"
                    data-test="event-type-pill"
                    :title="`点按「${CALENDAR_EVENT_META[t].label}」筛选当天日程，再点取消`"
                    :aria-pressed="typeFilter === t"
                    class="flex items-center gap-1 rounded-pill border px-2 py-0.5 text-fine transition-colors"
                    :class="typeFilter === t ? 'border-white bg-white font-medium text-ink' : 'border-white/25 text-white/60 hover:border-white/60'"
                    @click="toggleTypeFilter(t)"
                  >
                    <span class="h-1.5 w-1.5 rounded-full" :class="CALENDAR_EVENT_META[t].dot" />
                    {{ CALENDAR_EVENT_META[t].label }}
                  </button>
                </div>
              </div>
              <p v-if="!todayEvents.length" class="mt-1.5 px-1 text-fine text-white/45">
                今天还没有日程
              </p>
              <ul v-else class="mt-1 space-y-0.5">
                <li
                  v-for="e in todayEvents"
                  :key="e.id"
                  data-test="panel-event"
                  class="flex items-center gap-2 rounded-md px-1.5 py-1"
                  :class="isEventDimmed(e) ? 'opacity-40' : ''"
                >
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'"
                    :title="CALENDAR_EVENT_META[e.type]?.label ?? e.type"
                  />
                  <span class="min-w-0 flex-1 truncate text-fine" :class="e.done ? 'text-white/35 line-through' : 'text-white/85'">
                    <span class="mr-1 text-white/50">{{ eventPeriodLabel(e) }}</span>{{ e.content }}
                  </span>
                  <span v-if="e.class_name" class="shrink-0 text-fine text-white/40">{{ e.class_name }}</span>
                </li>
              </ul>
            </div>
          </div>

      <!-- 向下提示：会弹动，点了就翻页 -->
      <button
        v-show="!pomodoroOpen"
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
          <AppLink to="/profile">编辑个人资料</AppLink>
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
        </div>
        </div>
      </div>
    </section>

    <!-- ══════════════ 番茄时钟沉浸层：整页只剩背景图与倒计时 ══════════════ -->
    <Transition name="pomodoro-fade">
      <div
        v-if="pomodoroOpen"
        data-test="pomodoro-overlay"
        class="absolute inset-0 z-50 flex flex-col items-center justify-center gap-7 bg-black/45"
        role="dialog"
        aria-label="番茄钟"
      >
        <!-- 模式切换：切换即重置到该模式时长 -->
        <div class="flex items-center gap-1.5">
          <button
            v-for="m in POMODORO_MODES"
            :key="m.key"
            type="button"
            data-test="pomodoro-mode"
            class="rounded-pill px-3.5 py-1.5 text-caption transition-colors"
            :class="pomodoroMode === m.key ? 'bg-white font-medium text-ink' : 'text-white/60 hover:text-white'"
            @click="switchPomodoroMode(m.key)"
          >
            {{ m.label }}
          </button>
        </div>

        <!-- 进度环 + 倒计时（退出按钮贴在表盘右上角，一眼可见） -->
        <div class="relative h-[min(320px,56vmin)] w-[min(320px,56vmin)]">
          <button
            type="button"
            data-test="pomodoro-close"
            class="absolute -right-2 -top-2 z-10 flex h-9 w-9 items-center justify-center rounded-pill bg-white/15 text-white/80 backdrop-blur transition-colors hover:bg-white/25 hover:text-white active:scale-[0.95]"
            aria-label="退出番茄钟"
            title="退出番茄钟"
            @click="closePomodoro"
          >
            <svg class="pointer-events-none" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
          <svg viewBox="0 0 200 200" class="h-full w-full -rotate-90" aria-hidden="true">
            <circle cx="100" cy="100" r="88" fill="none" stroke="rgb(255 255 255 / 0.18)" stroke-width="5" />
            <circle
              cx="100"
              cy="100"
              r="88"
              fill="none"
              class="text-primary-on-dark"
              stroke="currentColor"
              stroke-width="5"
              stroke-linecap="round"
              :stroke-dasharray="POMODORO_CIRCUMFERENCE"
              :stroke-dashoffset="POMODORO_CIRCUMFERENCE * (1 - pomodoroElapsed)"
            />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <p class="tnum text-[64px] font-semibold leading-none -tracking-[2px] text-white">
              {{ pomodoroText }}
            </p>
            <p class="mt-2.5 text-caption text-white/60" :aria-live="pomodoroDone ? 'polite' : undefined">
              {{ pomodoroDone ? "时间到，休息一下吧" : pomodoroModeLabel }}
            </p>
          </div>
        </div>

        <!-- 控制：开始/暂停/继续 + 重置 -->
        <div class="flex items-center gap-3">
          <button
            type="button"
            data-test="pomodoro-primary"
            class="rounded-pill bg-white px-9 py-2.5 text-caption font-medium text-ink transition-[background-color,transform] hover:bg-white/90 active:scale-[0.98]"
            @click="togglePomodoroRunning"
          >
            {{ pomodoroAction }}
          </button>
          <button
            type="button"
            data-test="pomodoro-reset"
            class="flex h-10 w-10 items-center justify-center rounded-pill bg-white/15 text-white/80 transition-colors hover:bg-white/25 active:scale-[0.95]"
            aria-label="重置倒计时"
            @click="resetPomodoro"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 9a8.1 8.1 0 1 1-.9 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              <path d="M4 3.8V9h5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </Transition>

    <!-- 页码指示器 -->
    <nav
      class="fixed right-7 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-2.5 transition-opacity"
      :class="pomodoroOpen ? 'pointer-events-none opacity-0' : ''"
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

    <!-- 课表面板背景选择器：本地上传 / 网络链接 / 历史切换（放在翻页容器外，避免被裁切） -->
    <BackgroundPickerDialog
      :open="bgPickerOpen"
      kind="timetable_bg"
      :current="profile.timetable_bg"
      crop
      data-test="home-bg-picker"
      @select="applyPanelBg"
      @clear="clearPanelBg"
      @close="bgPickerOpen = false"
    />
  </div>
</template>

<style scoped>
/* 番茄钟沉浸层淡入淡出，进出都不打断背景图的呼吸感 */
.pomodoro-fade-enter-active,
.pomodoro-fade-leave-active {
  transition: opacity 0.35s ease;
}
.pomodoro-fade-enter-from,
.pomodoro-fade-leave-to {
  opacity: 0;
}
</style>
