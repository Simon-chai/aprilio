<script setup lang="ts">
/**
 * 周课表网格：列 = 周一~周五，行 = 节次（按上/下午分组）。
 *
 * - readonly：我的课表页「整周总览」等只读场景
 * - editable：班级详情页课程表 Tab —— 点格子出浮层（科目预设 + 自由输入 + 备注 + 清空），
 *   「节次设置」弹窗调整节数/上下午/时间，写库经 db.saveTimetableSlot / saveTimetablePeriods
 *
 * 高亮：今天列与当前节次（按节次时间命中）用 Action Blue；任教学科格子加小圆点标记。
 * 视觉遵循设计系统：中性底色 + 发丝线，无卡片阴影（仅浮层投影）。
 */
import { computed, ref } from "vue";
import AppButton from "./ui/AppButton.vue";
import { saveTimetablePeriods, saveTimetableSlot } from "../lib/db";
import {
  SUBJECT_PRESETS,
  WEEKDAY_LABELS,
  buildGrid,
  currentPeriod as computeCurrentPeriod,
  defaultPeriods,
  isMySubject,
  subjectChipClass,
  weekdayOf,
} from "../lib/timetable";
import type { Timetable, TimetablePeriod, TimetableSlot } from "../types";

const props = withDefaults(
  defineProps<{
    timetable: Timetable | null;
    slots: TimetableSlot[];
    editable?: boolean;
    /** 任教学科：命中格子在科目下加 Action Blue 小圆点 */
    mySubjects?: string[];
    /** 今天（1~5）；缺省按当前日期推导，测试可显式传入 */
    today?: number | null;
    /** 当前节次；缺省按节次时间推导 */
    currentPeriod?: number | null;
  }>(),
  { editable: false, mySubjects: () => [], today: undefined, currentPeriod: undefined }
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

/** 按（天, 节）取格子；无格子返回 null */
function cellOf(day: number, period: number): TimetableSlot | null {
  const rowIdx = periods.value.findIndex((p) => p.period === period);
  return rowIdx === -1 ? null : (grid.value[rowIdx]?.[day - 1] ?? null);
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

async function saveCell() {
  if (!props.timetable) return;
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

    <!-- 星期表头 -->
    <div class="grid grid-cols-[64px_repeat(5,minmax(0,1fr))] gap-px">
      <div class="flex h-8 items-center justify-center text-fine text-weak">节次</div>
      <div
        v-for="(label, i) in WEEKDAY_LABELS"
        :key="label"
        class="flex h-8 items-center justify-center rounded-sm text-fine font-medium"
        :class="today === i + 1 ? 'bg-primary-soft text-primary' : 'text-muted'"
      >
        {{ label }}
      </div>
    </div>

    <!-- 节次行分组渲染 -->
    <template v-for="(group, gi) in [morningPeriods, afternoonPeriods]" :key="gi">
      <template v-if="group.length">
        <div
          v-if="gi > 0"
          class="flex items-center gap-3 py-1.5"
        >
          <span class="text-fine text-weak">下午</span>
          <span class="h-px flex-1 bg-divider" />
        </div>
        <div
          v-for="p in group"
          :key="p.period"
          class="grid grid-cols-[64px_repeat(5,minmax(0,1fr))] gap-px"
        >
          <div class="flex h-14 flex-col items-center justify-center rounded-sm bg-pearl">
            <span class="text-fine font-medium text-muted">{{ p.period }}</span>
            <span v-if="p.start && p.end" class="text-fine text-faint tnum">
              {{ p.start }}~{{ p.end }}
            </span>
          </div>
          <div
            v-for="day in 5"
            :key="day"
            class="relative"
          >
            <component
              :is="editable ? 'button' : 'div'"
              :type="editable ? 'button' : undefined"
              :data-test="editable ? 'timetable-cell' : undefined"
              class="flex h-14 w-full flex-col items-start justify-center overflow-hidden rounded-sm border px-2 text-left transition-colors"
              :class="
                cellOf(day, p.period)?.subject
                  ? [
                      subjectChipClass(cellOf(day, p.period)!.subject),
                      editable ? 'hover:border-primary/60' : '',
                      // 今天列用主色描边强调，当前节次再加粗一档（不与科目色边框冲突）
                      today === day && currentPeriod === p.period
                        ? 'ring-2 ring-primary'
                        : today === day
                          ? 'ring-1 ring-primary/50'
                          : '',
                    ]
                  : [
                      'border-dashed border-divider bg-pearl/40',
                      editable ? 'hover:border-primary/60' : '',
                    ]
              "
              @click="openEditor(day, p.period, cellOf(day, p.period))"
            >
              <template v-if="cellOf(day, p.period)?.subject">
                <span class="flex items-center gap-1 text-caption font-medium">
                  {{ cellOf(day, p.period)?.subject }}
                  <span
                    v-if="isMySubject(cellOf(day, p.period)!.subject, mySubjects)"
                    class="h-1.5 w-1.5 rounded-full bg-primary"
                    title="我的课"
                  />
                </span>
                <span
                  v-if="cellOf(day, p.period)?.note"
                  class="truncate text-fine text-weak"
                  :title="cellOf(day, p.period)?.note ?? ''"
                >
                  {{ cellOf(day, p.period)?.note }}
                </span>
              </template>
            </component>

            <!-- 格子编辑浮层 -->
            <div
              v-if="editingKey === `${day}:${p.period}`"
              data-test="timetable-popover"
              class="absolute z-30 w-60 rounded-md border border-hairline bg-canvas p-3 text-left shadow-lg"
              :class="anchorTop ? 'top-full mt-1' : 'bottom-full mb-1'"
              :style="{ left: day <= 2 ? '0' : 'auto', right: day <= 2 ? 'auto' : '0' }"
            >
              <p class="mb-2 text-fine font-medium text-muted">
                {{ WEEKDAY_LABELS[day - 1] }} · 第{{ p.period }}节
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
              <div class="mt-3 flex items-center justify-between">
                <button
                  type="button"
                  data-test="slot-clear"
                  class="text-fine text-danger hover:underline"
                  @click="clearCell"
                >
                  清空
                </button>
                <div class="flex gap-2">
                  <AppButton variant="pearl" @click="closeEditor">取消</AppButton>
                  <AppButton @click="saveCell">保存</AppButton>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
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
        <button
          type="button"
          class="mt-3 text-fine text-primary hover:underline disabled:pointer-events-none disabled:opacity-40"
          :disabled="periodsDraft.length >= 12"
          @click="addPeriod"
        >
          ＋ 添加节次
        </button>
        <div class="mt-5 flex justify-end gap-2">
          <AppButton variant="pearl" @click="periodEditorOpen = false">取消</AppButton>
          <AppButton @click="savePeriods">保存</AppButton>
        </div>
      </div>
    </div>
  </div>
</template>
