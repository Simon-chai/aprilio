<script setup lang="ts">
/**
 * 周课表网格：列 = 周一~周五，行 = 节次（按上/下午分组），CSS Grid 布局。
 *
 * - readonly：只读场景（班级详情外的引用）
 * - editable：班级详情页课程表 Tab —— 点格子出浮层（科目预设 + 自由输入 + 备注 + 清空），
 *   「节次设置」弹窗调整节数/上下午/时间，写库经 db.saveTimetableSlot / saveTimetablePeriods
 *
 * 渲染特性：
 * - 连堂合并：同天同上/下午内相邻节次「科目+备注」相同 → 合并成一个跨行块（纯渲染层，
 *   数据模型不动；点合并块编辑的是块首格，后续格不动）
 * - 任教高亮：生效我的科目（班级标记 classMarked 优先，回退全局 mySubjects）格子加
 *   主色内描边 + 蓝点标记
 * - 今天列与当前节次用主色 ring 强调
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AppLink from "./ui/AppLink.vue";
import EventTypeSelect from "./EventTypeSelect.vue";
import MemoTitle from "./MemoTitle.vue";
import {
  addCalendarEvent,
  deleteCalendarEvent,
  listClassEventsInRange,
  saveTimetablePeriods,
  saveTimetableSlot,
  setCalendarEventDone,
  setCalendarEventTitle,
} from "../lib/db";
import { mondayOf, toDateStr } from "../lib/calendar";
import { summarizeMemoTitle } from "../lib/memo-ai";
import {
  CALENDAR_EVENT_META,
  SUBJECT_PRESETS,
  WEEKDAY_LABELS,
  buildGrid,
  crossClassConflictsAt,
  currentPeriod as computeCurrentPeriod,
  defaultPeriods,
  isMySubject,
  mergeColumnBlocks,
  mineOfClassResolver,
  resolveClassMySubjects,
  subjectChipClass,
  weekdayOf,
} from "../lib/timetable";
import type { CrossClassConflict } from "../lib/timetable";
import type {
  CalendarEvent,
  CalendarEventType,
  Timetable,
  TimetablePeriod,
  TimetableSlot,
  TimetableSlotWithClass,
} from "../types";

const props = withDefaults(
  defineProps<{
    timetable: Timetable | null;
    slots: TimetableSlot[];
    editable?: boolean;
    /** 全局任教学科（个人资料）：班级未标记时回退用 */
    mySubjects?: string[];
    /** 本班「我的科目」标记（timetables.my_subjects）：null = 未标记，回退全局 */
    classMarked?: string[] | null;
    /** 跨班撞课检测素材：本学期全部班级格子（联班级名/节次/我的科目标记）；不传 = 检测静默关闭 */
    conflictRows?: TimetableSlotWithClass[];
    /** 今天（1~5）；缺省按当前日期推导，测试可显式传入 */
    today?: number | null;
    /** 当前节次；缺省按节次时间推导 */
    currentPeriod?: number | null;
  }>(),
  { editable: false, mySubjects: () => [], classMarked: null, today: undefined, currentPeriod: undefined }
);

const emit = defineEmits<{ changed: [] }>();

const periods = computed<TimetablePeriod[]>(() => props.timetable?.periods ?? defaultPeriods());
const grid = computed(() => buildGrid(props.slots, periods.value));

const today = computed(() => (props.today === undefined ? weekdayOf() : props.today));
const currentPeriod = computed(() =>
  props.currentPeriod === undefined ? computeCurrentPeriod(periods.value) : props.currentPeriod
);

const morningPeriods = computed(() => periods.value.filter((p) => p.session === "morning"));
const afternoonPeriods = computed(() => periods.value.filter((p) => p.session === "afternoon"));

/** 生效「我的科目」：班级标记过按标记（含空数组），未标记回退全局任教学科 */
const effectiveMine = computed(() =>
  resolveClassMySubjects(props.classMarked ?? null, props.mySubjects)
);
function isMine(subject: string): boolean {
  return isMySubject(subject, effectiveMine.value);
}

/** 按（天, 节）取格子；无格子返回 null */
function cellOf(day: number, period: number): TimetableSlot | null {
  const rowIdx = periods.value.findIndex((p) => p.period === period);
  return rowIdx === -1 ? null : (grid.value[rowIdx]?.[day - 1] ?? null);
}

/* ---------------- 连堂合并（分组内，跨上/下午不合并） ---------------- */

/** 一天一列的渲染块：cell = 块首格，startPeriod = 块首节次 */
interface GridBlock {
  cell: TimetableSlot | null;
  startPeriod: number;
  span: number;
  covered: boolean;
}

function blocksForDay(day: number, group: TimetablePeriod[]): GridBlock[] {
  return mergeColumnBlocks(
    group.map((p) => cellOf(day, p.period)),
    (c) => `${c.subject}|${c.note ?? ""}`
  ).map((b, i) => ({
    cell: b.covered ? null : (Array.isArray(b.content) ? b.content[0] : b.content),
    startPeriod: group[i].period,
    span: b.span,
    covered: b.covered,
  }));
}

/** 分组渲染模型：每个上/下午段 = 一个网格（左节次列 + 5 天连堂合并后的块） */
const groups = computed(() =>
  [morningPeriods.value, afternoonPeriods.value]
    .filter((g) => g.length)
    .map((periods, gi) => ({
      gi,
      periods,
      blocksByDay: Array.from({ length: 5 }, (_, di) => blocksForDay(di + 1, periods)),
    }))
);

/** 块（组内第 bi 行起、跨 span 行）是否覆盖某个节次（用于「正在上」强调） */
function blockCoversPeriod(group: TimetablePeriod[], bi: number, span: number, period: number): boolean {
  return group.slice(bi, bi + span).some((p) => p.period === period);
}

/* ---------------- 格子编辑浮层 ---------------- */

const editingKey = ref<string | null>(null);
const editDay = ref(1);
const editPeriod = ref(1);
const editSubject = ref("");
const editNote = ref("");

/** 浮层锚定方向：上半部分向下弹，下半部分向上弹，避免溢出 */
const anchorTop = ref(true);

function openEditor(day: number, period: number, cell: TimetableSlot | null) {
  if (!props.editable || !props.timetable) return;
  forceConfirm.value = false;
  memoEditingDay.value = null; // 与列头备忘编辑器互斥
  editDay.value = day;
  editPeriod.value = period;
  editSubject.value = cell?.subject ?? "";
  editNote.value = cell?.note ?? "";
  const rowIdx = periods.value.findIndex((p) => p.period === period);
  anchorTop.value = rowIdx < periods.value.length / 2;
  editingKey.value = `${day}:${period}`;
}

function closeEditor() {
  editingKey.value = null;
}

/* ---------------- 跨班撞课检测（conflictRows 未传 = 静默关闭） ---------------- */

/** 撞课警告已出示、待二次确认（「仍要保存」） */
const forceConfirm = ref(false);

const conflictMineOf = computed(() =>
  props.conflictRows ? mineOfClassResolver(props.conflictRows, props.mySubjects) : null
);

/** 编辑中格子若落库，撞上的其他班「我的课」；conflictRows 未传 / 空科目 / 非本班我的科目 → 空 */
const editConflicts = computed<CrossClassConflict[]>(() => {
  if (!props.conflictRows || !props.timetable || !conflictMineOf.value) return [];
  if (!isMySubject(editSubject.value, effectiveMine.value)) return [];
  return crossClassConflictsAt(props.conflictRows, conflictMineOf.value, {
    day_of_week: editDay.value,
    period: editPeriod.value,
    excludeTimetableId: props.timetable.id,
  });
});

/** 改科目/备注后重新评估，撤回武装态 */
watch([editSubject, editNote], () => {
  forceConfirm.value = false;
});

async function saveCell() {
  if (!props.timetable) return;
  if (editConflicts.value.length > 0 && !forceConfirm.value) {
    // 第一次点：只出示撞课警告，不落库
    forceConfirm.value = true;
    return;
  }
  await saveTimetableSlot(props.timetable.id, editDay.value, editPeriod.value, editSubject.value, editNote.value);
  closeEditor();
  emit("changed");
}

async function clearCell() {
  if (!props.timetable) return;
  await saveTimetableSlot(props.timetable.id, editDay.value, editPeriod.value, "");
  closeEditor();
  emit("changed");
}

/* ---------------- 列头全天备忘（绑班级，period = null，挂本周对应日期） ---------------- */

/** 本周周一~周五日期（列头备忘的挂载日期） */
const weekDates = computed<string[]>(() => {
  const monday = mondayOf();
  return Array.from({ length: 5 }, (_, i) =>
    toDateStr(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))
  );
});

/** 本班本周的全天日程事件（绑节次的不进周网格，由日历与我的课表承载） */
const dayMemos = ref<CalendarEvent[]>([]);

async function reloadMemos() {
  const className = props.timetable?.class_name;
  if (!className) {
    dayMemos.value = [];
    return;
  }
  try {
    const rows = await listClassEventsInRange(className, weekDates.value[0], weekDates.value[4]);
    dayMemos.value = rows.filter((e) => e.period === null);
  } catch {
    dayMemos.value = [];
  }
}

/** 某列（周几）的全天备忘，按录入顺序 */
function memosAt(day: number): CalendarEvent[] {
  const date = weekDates.value[day - 1];
  return dayMemos.value.filter((e) => e.event_date === date).sort((a, b) => a.id - b.id);
}

/** 列头备忘编辑器打开的列（1~5）；null = 收起 */
const memoEditingDay = ref<number | null>(null);
const newMemoType = ref<CalendarEventType>("memo");
const memoSaving = ref(false);
/** 各列输入草稿（key = day），收起后保留以便续写 */
const memoDraftByDay = ref<Record<number, string>>({});

/** v-focus：列头编辑器的输入框挂载即聚焦 */
const vFocus = { mounted: (el: HTMLInputElement) => el.focus() };

function openMemoEditor(day: number) {
  if (!props.editable || !props.timetable) return;
  editingKey.value = null; // 与格子编辑浮层互斥
  memoEditingDay.value = day;
}

function closeMemoEditor() {
  memoEditingDay.value = null;
}

async function addMemo(day: number) {
  const className = props.timetable?.class_name;
  const content = (memoDraftByDay.value[day] ?? "").trim();
  if (!className || !content || memoSaving.value) return;
  memoSaving.value = true;
  let savedId = 0;
  try {
    savedId = await addCalendarEvent(className, weekDates.value[day - 1], content, newMemoType.value, null);
    memoDraftByDay.value = { ...memoDraftByDay.value, [day]: "" };
    await reloadMemos();
  } finally {
    memoSaving.value = false;
  }
  // AI 快速浏览标题后台生成（与我的课表速记同口径；未配置 → 显示全文前几个字）
  void summarizeMemoTitle(content).then(async (title) => {
    if (!title || !savedId) return;
    try {
      await setCalendarEventTitle(savedId, title);
      await reloadMemos();
    } catch {
      /* 标题回写失败不影响备忘本身 */
    }
  });
}

async function toggleMemo(event: CalendarEvent) {
  await setCalendarEventDone(event.id, event.done !== 1);
  await reloadMemos();
}

async function removeMemo(event: CalendarEvent) {
  await deleteCalendarEvent(event.id);
  await reloadMemos();
}

/** 首次挂载 / 换班级课表时重拉列头备忘 */
watch(
  () => props.timetable?.id,
  () => {
    closeMemoEditor();
    void reloadMemos();
  },
  { immediate: true }
);

/* ---------------- 节次设置 ---------------- */

const periodEditorOpen = ref(false);
const periodsDraft = ref<TimetablePeriod[]>([]);

function openPeriodEditor() {
  periodsDraft.value = periods.value.map((p) => ({ ...p }));
  periodEditorOpen.value = true;
}

function toggleSession(idx: number) {
  const row = periodsDraft.value[idx];
  if (row) row.session = row.session === "morning" ? "afternoon" : "morning";
}

function addPeriod() {
  const next = Math.max(0, ...periodsDraft.value.map((p) => p.period)) + 1;
  if (next > 12) return;
  periodsDraft.value.push({ period: next, session: "afternoon", start: "", end: "" });
}

function removePeriod(idx: number) {
  periodsDraft.value.splice(idx, 1);
}

async function savePeriods() {
  if (!props.timetable) return;
  const rows = [...periodsDraft.value].sort((a, b) => a.period - b.period);
  await saveTimetablePeriods(props.timetable.id, rows);
  periodEditorOpen.value = false;
  emit("changed");
}
</script>

<template>
  <div class="space-y-3">
    <!-- 工具行：节次设置（仅编辑态） -->
    <div v-if="editable" class="flex items-center justify-end">
      <AppButton variant="pearl" data-test="period-editor-btn" @click="openPeriodEditor">
        节次设置
      </AppButton>
    </div>

    <!-- 星期表头：兼任该班全天备忘入口（点列头速记，备忘挂本周对应日期） -->
    <div class="grid grid-cols-[64px_repeat(5,minmax(0,1fr))] gap-px">
      <div class="flex min-h-8 items-center justify-center text-fine text-weak">节次</div>
      <div
        v-for="(label, i) in WEEKDAY_LABELS"
        :key="label"
        data-test="grid-day-header"
        class="relative flex min-h-8 flex-col items-center justify-center rounded-sm px-1 py-1 text-center text-fine font-medium transition-colors"
        :class="[
          today === i + 1 ? 'bg-primary-soft text-primary' : 'text-muted',
          editable ? 'cursor-pointer hover:bg-pearl' : '',
        ]"
        :title="editable ? `${label} · 点击记全天备忘` : undefined"
        @click="openMemoEditor(i + 1)"
      >
        <span>{{ label }}</span>
        <!-- 全天备忘（period 为空）：最多展示 2 条，溢出收数 -->
        <span
          v-for="e in memosAt(i + 1).slice(0, 2)"
          :key="e.id"
          data-test="grid-day-memo"
          class="mt-0.5 flex w-full items-center justify-center gap-1 font-normal text-faint"
        >
          <span class="h-1 w-1 shrink-0 rounded-full" :class="CALENDAR_EVENT_META[e.type]?.dot ?? 'bg-stone-400'" />
          <MemoTitle :event="e" :align="i >= 3 ? 'right' : 'left'" class="min-w-0" :class="e.done ? 'line-through' : ''" />
        </span>
        <span v-if="memosAt(i + 1).length > 2" data-test="grid-day-memo-more" class="font-normal text-faint">
          +{{ memosAt(i + 1).length - 2 }}
        </span>
        <!-- 全天备忘编辑器（从列头打开）：勾选 / 删除 / 回车速记，与我的课表列头同交互 -->
        <div
          v-if="memoEditingDay === i + 1"
          data-test="grid-day-memo-editor"
          class="absolute top-full z-30 mt-1 flex w-[230px] flex-col gap-1.5 rounded-md border border-hairline bg-canvas p-2.5 text-left shadow-lg"
          :class="i === 0 ? 'left-0' : i === WEEKDAY_LABELS.length - 1 ? 'right-0' : 'left-1/2 -translate-x-1/2'"
          @click.stop
        >
          <div class="flex items-center justify-between">
            <p class="text-fine font-medium text-ink">全天 · {{ label }}</p>
            <button
              type="button"
              class="flex h-4 w-4 items-center justify-center rounded-md text-faint hover:bg-pearl hover:text-ink"
              aria-label="收起"
              @click="closeMemoEditor()"
            >
              <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <p v-if="!memosAt(i + 1).length" class="text-fine text-faint">这天还没有全天备忘</p>
          <ul v-else class="space-y-px">
            <li
              v-for="e in memosAt(i + 1)"
              :key="e.id"
              data-test="grid-day-memo-row"
              class="group flex items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-pearl"
            >
              <button
                type="button"
                class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors"
                :class="e.done ? 'border-primary bg-primary' : 'border-weak hover:border-primary'"
                :aria-label="e.done ? '标记为待办' : '标记为已完成'"
                @click="toggleMemo(e)"
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
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
                aria-label="删除备忘"
                @click="removeMemo(e)"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
            </li>
          </ul>
          <div class="flex items-center gap-1.5">
            <EventTypeSelect v-model="newMemoType" />
            <input
              v-focus
              v-model="memoDraftByDay[i + 1]"
              data-test="grid-day-memo-input"
              :placeholder="`记${CALENDAR_EVENT_META[newMemoType].label}，回车`"
              class="h-7 min-w-0 flex-1 rounded-sm border border-hairline bg-canvas px-1.5 text-fine text-ink outline-none focus:border-primary-focus"
              @keydown.enter.prevent="addMemo(i + 1)"
              @keydown.esc.prevent="closeMemoEditor()"
            />
          </div>
          <p class="text-fine text-faint">色点下拉选类型 · 回车保存</p>
        </div>
      </div>
    </div>

    <!-- 上/下午分组网格：左节次列 + 每天连堂合并块（CSS Grid row-span） -->
    <template v-for="group in groups" :key="group.gi">
      <div v-if="group.gi > 0" class="flex items-center gap-3 py-1.5">
        <span class="text-fine text-weak">下午</span>
        <span class="h-px flex-1 bg-divider" />
      </div>
      <div
        class="grid gap-px"
        :style="{
          gridTemplateColumns: '64px repeat(5, minmax(0, 1fr))',
          gridTemplateRows: `repeat(${group.periods.length}, 3.5rem)`,
        }"
      >
        <!-- 左侧节次列 -->
        <div
          v-for="(p, ri) in group.periods"
          :key="p.period"
          class="flex flex-col items-center justify-center rounded-sm bg-pearl"
          :style="{ gridColumn: '1', gridRow: String(ri + 1) }"
        >
          <span class="text-fine font-medium text-muted">{{ p.period }}</span>
          <span v-if="p.start && p.end" class="text-fine text-faint tnum">
            {{ p.start }}~{{ p.end }}
          </span>
        </div>

        <!-- 每天渲染块：relative 包一层锚浮层；有课块跨行合并，空格渲染虚线占位 -->
        <template v-for="day in 5" :key="day">
          <template v-for="(b, bi) in group.blocksByDay[day - 1]" :key="`${day}-${bi}`">
            <div
              v-if="!b.covered"
              class="relative"
              :style="{ gridColumn: String(day + 1), gridRow: `${bi + 1} / span ${b.span}` }"
            >
              <component
                :is="editable ? 'button' : 'div'"
                :type="editable ? 'button' : undefined"
                :data-test="b.cell ? 'timetable-cell' : 'timetable-empty-cell'"
                :data-cell="`${day}:${b.startPeriod}`"
                class="flex h-full w-full flex-col items-start justify-center overflow-hidden rounded-md border px-2 text-left transition-colors"
                :class="
                  b.cell
                    ? [
                        subjectChipClass(b.cell.subject),
                        editable ? 'hover:border-primary/60' : '',
                        isMine(b.cell.subject) ? 'inset-ring-2 inset-ring-primary/70' : '',
                        today === day &&
                        currentPeriod !== null &&
                        blockCoversPeriod(group.periods, bi, b.span, currentPeriod)
                          ? 'ring-2 ring-primary'
                          : today === day
                            ? 'ring-1 ring-primary/50'
                            : '',
                      ]
                    : [
                        'border-dashed border-divider bg-pearl/40',
                        editable ? 'cursor-pointer hover:border-primary/60' : '',
                      ]
                "
                @click="openEditor(day, b.startPeriod, b.cell)"
              >
                <template v-if="b.cell">
                  <span class="flex items-center gap-1 text-caption font-medium">
                    {{ b.cell.subject }}
                    <span
                      v-if="isMine(b.cell.subject)"
                      class="h-1.5 w-1.5 rounded-full bg-primary"
                      title="我的课"
                    />
                  </span>
                  <span
                    v-if="b.cell.note"
                    class="truncate text-fine text-weak"
                    :title="b.cell.note"
                  >
                    {{ b.cell.note }}
                  </span>
                </template>
              </component>

              <!-- 格子编辑浮层：锚定在块容器上 -->
              <div
                v-if="editingKey === `${day}:${b.startPeriod}`"
                data-test="timetable-popover"
                class="absolute z-30 w-60 rounded-md border border-hairline bg-canvas p-3 text-left shadow-lg"
                :class="anchorTop ? 'top-full mt-1' : 'bottom-full mb-1'"
                :style="{ left: day <= 2 ? '0' : 'auto', right: day <= 2 ? 'auto' : '0' }"
              >
                <p class="mb-2 text-fine font-medium text-muted">
                  {{ WEEKDAY_LABELS[day - 1] }} · 第{{ b.startPeriod }}节
                </p>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="s in SUBJECT_PRESETS"
                    :key="s"
                    type="button"
                    class="rounded-pill px-2.5 py-1 text-fine transition-colors border"
                    :class="
                      editSubject === s
                        ? 'border-ink bg-ink text-canvas font-medium'
                        : 'border-hairline bg-canvas text-muted hover:border-ink'
                    "
                    @click="editSubject = s"
                  >
                    {{ s }}
                  </button>
                </div>
                <input
                  v-model="editSubject"
                  data-test="slot-subject-input"
                  placeholder="或输入自定义科目"
                  class="mt-2 h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                />
                <input
                  v-model="editNote"
                  data-test="slot-note-input"
                  placeholder="备注（选填，如：去机房）"
                  class="mt-2 h-8 w-full rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                />
                <!-- 跨班撞课警告：出示后保存按钮变「仍要保存」二次确认 -->
                <div
                  v-if="forceConfirm && editConflicts.length"
                  data-test="conflict-warning"
                  class="mt-2 rounded-md border border-danger/40 bg-danger-soft p-2"
                >
                  <p class="text-fine font-medium text-danger">这个时段你还要上别的班：</p>
                  <p v-for="c in editConflicts" :key="c.class_name" class="mt-0.5 text-fine text-danger">
                    {{ WEEKDAY_LABELS[editDay - 1] }} 第{{ editPeriod }}节 · {{ c.class_name }}（{{ c.subject }}）
                  </p>
                </div>
                <div class="mt-3 flex items-center justify-between">
                  <AppLink
                    data-test="slot-clear"
                    tone="danger"
                    variant="action"
                    class="text-fine"
                    @click="clearCell"
                  >
                    清空
                  </AppLink>
                  <div class="flex gap-2">
                    <AppButton variant="pearl" @click="closeEditor">取消</AppButton>
                    <AppButton
                      data-test="slot-save"
                      :variant="forceConfirm ? 'danger' : 'primary'"
                      @click="saveCell"
                    >
                      {{ forceConfirm ? "仍要保存" : "保存" }}
                    </AppButton>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </template>

    <!-- 节次设置弹窗 -->
    <div
      v-if="periodEditorOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      @click.self="periodEditorOpen = false"
    >
      <div
        data-test="period-editor"
        class="w-[440px] max-h-[80vh] overflow-y-auto scroll-thin rounded-lg border border-hairline bg-canvas p-5 shadow-lg"
      >
        <h3 class="text-body font-semibold text-ink">节次设置</h3>
        <p class="mt-1 text-fine text-weak">
          调整节数、上下午归属与上下课时间；时间全部留空时网格只显示节次序号
        </p>
        <div class="mt-4 space-y-2">
          <div v-for="(row, idx) in periodsDraft" :key="row.period" class="flex items-center gap-2">
            <span class="w-11 shrink-0 text-caption text-muted">第{{ row.period }}节</span>
            <button
              type="button"
              class="h-7 shrink-0 rounded-pill px-2.5 text-fine transition-colors border"
              :class="row.session === 'morning' ? 'border-ink bg-ink text-canvas' : 'border-hairline text-muted'"
              @click="toggleSession(idx)"
            >
              {{ row.session === "morning" ? "上午" : "下午" }}
            </button>
            <input
              v-model="row.start"
              type="time"
              class="h-8 w-[92px] rounded-sm border border-hairline bg-canvas px-1.5 text-fine text-ink outline-none focus:border-primary-focus"
            />
            <span class="text-faint">–</span>
            <input
              v-model="row.end"
              type="time"
              class="h-8 w-[92px] rounded-sm border border-hairline bg-canvas px-1.5 text-fine text-ink outline-none focus:border-primary-focus"
            />
            <button
              type="button"
              class="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-weak hover:bg-danger-soft hover:text-danger transition-colors"
              aria-label="删除该节次"
              @click="removePeriod(idx)"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <AppLink
          variant="action"
          class="mt-3 text-fine"
          :disabled="periodsDraft.length >= 12"
          @click="addPeriod"
        >
          ＋ 添加节次
        </AppLink>
        <div class="mt-5 flex justify-end gap-2">
          <AppButton variant="pearl" @click="periodEditorOpen = false">取消</AppButton>
          <AppButton @click="savePeriods">保存</AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
