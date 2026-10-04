/**
 * 月历组件共享逻辑（拆分自 MyTimetableCalendar / TimetableCalendar）：
 * 月份状态与导航 / 月网格与标题 / 选中日 / 日程事件按日分组与排序 / 重载调度。
 *
 * 两个日历的差异只在「拉什么数据」（我的课表行程 vs 单班日程）与翻页时的
 * 选中日回落细节，由 reload 回调与组件自有的 watch 处理；事件排序口径
 * （节次升序、全天沉底）统一在这里，避免两处漂移。
 */
import { computed, onMounted, ref, watch } from "vue";
import { CALENDAR_WEEKDAY_LABELS, buildMonthGrid, fromDateStr, gridRange, monthTitle, shiftMonth } from "../lib/calendar";
import { localDateStr } from "../lib/format";
import type { CalendarEvent } from "../types";

export interface CalendarMonthRange {
  start: string;
  end: string;
}

export function useCalendarMonth(options: {
  /** 按当前月网格的日期区间拉取数据（实现里自行 try/catch 兜底） */
  reload: (range: CalendarMonthRange) => Promise<void> | void;
}) {
  const now = new Date();
  const today = localDateStr(now);
  const viewYear = ref(now.getFullYear());
  const viewMonth = ref(now.getMonth() + 1);
  const selectedDate = ref(today);

  const grid = computed(() => buildMonthGrid(viewYear.value, viewMonth.value));
  const flatGrid = computed(() => grid.value.flat());
  const title = computed(() => monthTitle(viewYear.value, viewMonth.value));

  const events = ref<CalendarEvent[]>([]);

  const eventsByDate = computed<Map<string, CalendarEvent[]>>(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events.value) {
      const list = map.get(e.event_date) ?? [];
      list.push(e);
      map.set(e.event_date, list);
    }
    return map;
  });

  /** 某天日程：节次升序、全天沉底（两个日历同口径） */
  function eventsOn(date: string): CalendarEvent[] {
    return [...(eventsByDate.value.get(date) ?? [])].sort(
      (a, b) => (a.period ?? 99) - (b.period ?? 99) || a.id - b.id
    );
  }

  async function reloadMonth() {
    await options.reload(gridRange(grid.value));
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

  /** 翻页/回今天后重新拉取 */
  watch([viewYear, viewMonth], () => {
    void reloadMonth();
  });

  onMounted(() => {
    void reloadMonth();
  });

  /** 选中日的展示标题：如「10月4日 周六」 */
  const selectedTitle = computed(() => {
    const d = fromDateStr(selectedDate.value);
    const weekday = ((d.getDay() + 6) % 7) + 1;
    return `${d.getMonth() + 1}月${d.getDate()}日 ${CALENDAR_WEEKDAY_LABELS[weekday - 1]}`;
  });

  return {
    today,
    viewYear,
    viewMonth,
    selectedDate,
    grid,
    flatGrid,
    title,
    events,
    eventsByDate,
    eventsOn,
    shift,
    backToToday,
    reloadMonth,
    selectedTitle,
  };
}
