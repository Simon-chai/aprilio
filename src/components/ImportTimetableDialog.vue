<script setup lang="ts">
/**
 * 导入课表对话框：Excel/CSV → 识别星期表头/节次表头 → 预览周网格 → 落库。
 * 与 ImportRosterDialog 同一交互骨架；文件管道复用 roster.ts（桌面 xlsx 走 Rust，浏览器仅 CSV）。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import {
  clearTimetableSlots,
  findOrCreateTimetable,
  isTauri,
  listClasses,
  listTimetablePeriodsByClass,
  saveTimetablePeriods,
  saveTimetableSlot,
} from "../lib/db";
import { WEEKDAY_LABELS, currentSemester, defaultPeriods, subjectChipClass } from "../lib/timetable";
import {
  detectTimetableLayout,
  downloadTimetableTemplate,
  layoutFromSelection,
  mapTimetableCells,
  previewPeriods,
  type TimetableLayout,
} from "../lib/timetable-import";
import { decodeRosterBytes, parseRosterTable, pickRosterFile, type RosterTable } from "../lib/roster";
import { logError, logInfo } from "../lib/logger";
import type { Timetable } from "../types";

const props = defineProps<{ open: boolean; presetClass?: string }>();
const emit = defineEmits<{
  close: [];
  imported: [payload: { className: string; count: number }];
}>();

const classes = ref<string[]>([]);
const selectedClass = ref("");
const fileLabel = ref("");
const table = ref<RosterTable | null>(null);
const layout = ref<TimetableLayout | null>(null);
const manual = ref(false);
const manualPeriodRows = ref(true);
const manualDayHeader = ref(0);
const manualPeriodHeader = ref(0);
const clearing = ref(false);
const importing = ref(false);
const result = ref<{ imported: number; failed: string[] } | null>(null);
const error = ref("");

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    classes.value = [];
    selectedClass.value = props.presetClass ?? "";
    fileLabel.value = "";
    table.value = null;
    layout.value = null;
    manual.value = false;
    manualPeriodRows.value = true;
    manualDayHeader.value = 0;
    manualPeriodHeader.value = 0;
    clearing.value = false;
    importing.value = false;
    result.value = null;
    error.value = "";
    try {
      // 班级列表 = 有学生的班级 ∪ 已建课表的班级（支持先建空课表再导入）
      const [summaries, timetables] = await Promise.all([
        listClasses().catch(() => []),
        listTimetablePeriodsByClass(currentSemester()).catch(() => []),
      ]);
      const names = new Set<string>([...summaries.map((c) => c.name), ...timetables.map((t) => t.class_name)]);
      classes.value = [...names].sort((a, b) => a.localeCompare(b, "zh"));
    } catch {
      classes.value = [];
    }
  },
  { immediate: true },
);

const mapping = computed(() =>
  table.value && layout.value ? mapTimetableCells(table.value, layout.value) : null,
);
const previewRows = computed(() => (mapping.value ? previewPeriods(mapping.value.cells) : []));
const canImport = computed(
  () =>
    !!(props.presetClass || selectedClass.value) &&
    !!mapping.value &&
    mapping.value.cells.length > 0 &&
    !importing.value,
);

/** 手动指定的候选轴：periodRows → 星期选行、节次选列；转置反之 */
const dayOptions = computed(() => {
  if (!table.value) return [];
  if (manualPeriodRows.value) {
    const n = table.value.rows.length + (table.value.hasHeader ? 1 : 0);
    return Array.from({ length: n }, (_, i) => ({ value: i, label: `第${i + 1}行` }));
  }
  return table.value.headers.map((h, i) => ({ value: i, label: `第${i + 1}列${h ? ` ${h}` : ""}` }));
});
const periodOptions = computed(() => {
  if (!table.value) return [];
  if (manualPeriodRows.value) {
    return table.value.headers.map((h, i) => ({ value: i, label: `第${i + 1}列${h ? ` ${h}` : ""}` }));
  }
  const n = table.value.rows.length + (table.value.hasHeader ? 1 : 0);
  return Array.from({ length: n }, (_, i) => ({ value: i, label: `第${i + 1}行` }));
});

async function loadTable(loaded: { table: RosterTable; sheet?: string }, label: string) {
  fileLabel.value = label;
  table.value = loaded.table;
  await analyze();
}

/** CSV 文本入口（浏览器演示态与测试注入共用） */
async function loadText(text: string, label = "") {
  fileLabel.value = label;
  try {
    table.value = parseRosterTable(text);
  } catch (e) {
    table.value = null;
    error.value = `解析失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  await analyze();
}

async function chooseFile() {
  error.value = "";
  result.value = null;
  if (isTauri()) {
    try {
      const loaded = await pickRosterFile();
      if (!loaded) return;
      await loadTable(loaded, loaded.fileName);
    } catch (e) {
      error.value = `读取文件失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return;
  }
  const file = await pickViaInput();
  if (!file) return;
  const text = decodeRosterBytes(await file.arrayBuffer()).text;
  await loadText(text, file.name);
}

/** 浏览器演示态的文件选择（<input type=file>；取消时靠窗口焦点回落识别） */
function pickViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    let settled = false;
    const done = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(file);
    };
    const onFocus = () => setTimeout(() => done(input.files?.[0] ?? null), 300);
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

async function analyze() {
  if (!table.value) return;
  result.value = null;
  error.value = "";
  const detected = detectTimetableLayout(table.value);
  layout.value = detected;
  manual.value = !detected.ok;
  if (!detected.ok) {
    manualPeriodRows.value = detected.periodRows;
    manualDayHeader.value = Math.max(detected.dayHeader, 0);
    manualPeriodHeader.value = Math.max(detected.periodHeader, 0);
    applyManual();
  }
}

function applyManual() {
  if (!table.value) return;
  layout.value = layoutFromSelection(
    table.value,
    manualPeriodRows.value,
    manualDayHeader.value,
    manualPeriodHeader.value,
  );
}

async function ensureImportedPeriods(timetable: Timetable, periods: number[]): Promise<void> {
  const maxPeriod = Math.max(0, ...periods);
  const current = [...(timetable.periods ?? defaultPeriods())];
  const known = new Set(current.map((period) => period.period));
  for (let period = 1; period <= maxPeriod; period += 1) {
    if (known.has(period)) continue;
    current.push({
      period,
      session: period <= 4 ? "morning" : "afternoon",
      start: "",
      end: "",
    });
  }
  current.sort((a, b) => a.period - b.period);
  if (current.length !== (timetable.periods ?? defaultPeriods()).length) {
    await saveTimetablePeriods(timetable.id, current);
  }
}

async function doImport() {
  const m = mapping.value;
  const className = props.presetClass || selectedClass.value;
  if (!m || !className || importing.value) return;
  importing.value = true;
  error.value = "";
  try {
    const { timetable } = await findOrCreateTimetable(className, currentSemester());
    await ensureImportedPeriods(timetable, m.cells.map((cell) => cell.period));
    if (clearing.value) await clearTimetableSlots(timetable.id);
    const failed: string[] = [];
    for (const cell of m.cells) {
      try {
        await saveTimetableSlot(timetable.id, cell.day_of_week, cell.period, cell.subject, cell.note);
      } catch (e) {
        failed.push(
          `${WEEKDAY_LABELS[cell.day_of_week - 1]} 第${cell.period}节 ${cell.subject}：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    result.value = { imported: m.cells.length - failed.length, failed };
    logInfo(`课表导入完成：班级=${className} 成功 ${result.value.imported} 格，失败 ${failed.length} 格`);
    if (result.value.imported > 0) {
      emit("imported", { className, count: result.value.imported });
    }
  } catch (e) {
    logError("课表导入失败", e);
    error.value = `导入失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    importing.value = false;
  }
}

defineExpose({ loadText, loadTable });
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @click.self="emit('close')"
  >
    <div class="flex max-h-full w-[780px] max-w-full flex-col rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-4 flex shrink-0 items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">导入课表</h2>
        <button class="text-caption text-weak hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div class="scroll-thin relative min-h-0 flex-1 overflow-y-auto pr-1">
        <!-- 目标班级 + 文件 -->
        <div class="flex flex-wrap items-center gap-3">
          <label class="flex items-center gap-2 text-caption text-ink">
            目标班级
            <select
              v-model="selectedClass"
              data-test="import-class-select"
              :disabled="!!props.presetClass"
              class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus disabled:opacity-60"
            >
              <option value="" disabled>请选择班级</option>
              <option v-for="c in classes" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <AppButton variant="secondary" @click="chooseFile">选择文件</AppButton>
          <AppButton variant="pearl" @click="downloadTimetableTemplate">下载模板</AppButton>
          <span class="min-w-0 flex-1 truncate text-caption text-weak">
            {{ fileLabel || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV）" }}
          </span>
        </div>

        <p v-if="error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ error }}</p>

        <template v-if="table && layout">
          <!-- 识别状态 -->
          <div class="mt-4 rounded-md bg-parchment p-3">
            <p class="text-caption text-ink">
              {{ layout.confidence === "high" ? "自动识别成功" : "未能完全识别，请手动指定" }} ·
              {{ layout.reason }}
            </p>
            <p
              v-for="c in (mapping?.cells ?? []).filter((x) => x.note)"
              :key="`${c.day_of_week}-${c.period}`"
              class="mt-1 text-fine text-weak"
            >
              {{ WEEKDAY_LABELS[c.day_of_week - 1] }} 第{{ c.period }}节：{{ c.subject }} · 备注「{{ c.note }}」
            </p>
            <p v-if="mapping?.skipped.length" class="mt-1 text-fine text-weak">
              已跳过非节次行：{{ mapping.skipped.join("、") }}
            </p>
            <p v-if="mapping?.droppedWeekendCells" class="mt-1 text-fine text-weak">
              周末列不会导入（丢弃 {{ mapping.droppedWeekendCells }} 格）
            </p>

            <!-- 低置信度：手动指定表头 -->
            <div v-if="manual" class="mt-2 flex flex-wrap items-center gap-3">
              <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1 text-caption"
                  :class="manualPeriodRows ? 'bg-canvas font-medium text-primary' : 'text-weak'"
                  @click="manualPeriodRows = true; applyManual()"
                >
                  行=节次
                </button>
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1 text-caption"
                  :class="!manualPeriodRows ? 'bg-canvas font-medium text-primary' : 'text-weak'"
                  @click="manualPeriodRows = false; applyManual()"
                >
                  列=节次
                </button>
              </div>
              <label class="flex items-center gap-2 text-caption text-ink">
                星期表头
                <select
                  v-model.number="manualDayHeader"
                  data-test="manual-day-header"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption"
                  @change="applyManual"
                >
                  <option v-for="o in dayOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <label class="flex items-center gap-2 text-caption text-ink">
                节次表头
                <select
                  v-model.number="manualPeriodHeader"
                  data-test="manual-period-header"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption"
                  @change="applyManual"
                >
                  <option v-for="o in periodOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
            </div>
          </div>

          <!-- 预览：映射后的周网格 -->
          <div
            v-if="mapping && previewRows.length"
            class="scroll-thin mt-3 overflow-x-auto rounded-sm border border-hairline"
          >
            <table class="w-full text-caption">
              <thead>
                <tr class="bg-parchment text-left">
                  <th class="whitespace-nowrap px-3 py-2 font-normal text-weak">节次</th>
                  <th
                    v-for="w in WEEKDAY_LABELS"
                    :key="w"
                    class="whitespace-nowrap px-3 py-2 font-normal text-weak"
                  >
                    {{ w }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in previewRows" :key="p" class="border-t border-hairline">
                  <td class="whitespace-nowrap px-3 py-1.5 text-muted">第{{ p }}节</td>
                  <td v-for="(w, dayIdx) in WEEKDAY_LABELS" :key="w" class="px-1.5 py-1.5">
                    <span
                      v-for="cell in mapping.cells.filter((c) => c.day_of_week === dayIdx + 1 && c.period === p)"
                      :key="cell.subject"
                      class="mr-1 inline-block rounded-sm border px-1.5 py-0.5 text-fine"
                      :class="subjectChipClass(cell.subject)"
                      :title="cell.note ?? ''"
                    >
                      {{ cell.subject }}<template v-if="cell.note">（{{ cell.note }}）</template>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="mapping" class="mt-1 text-fine text-weak">
            共识别 {{ mapping.cells.length }} 格有内容的课；空格子不会写入。
          </p>

          <!-- 导入选项与结果 -->
          <label class="mt-3 flex items-center gap-2 text-caption text-muted">
            <input v-model="clearing" type="checkbox" data-test="clear-before-import" />
            清空该班现有课表后导入（覆盖整张表）
          </label>

          <div v-if="result" class="mt-4 rounded-md bg-parchment p-3">
            <p class="text-caption font-medium text-ink">
              导入完成：成功 {{ result.imported }} 格<template v-if="result.failed.length">，失败 {{ result.failed.length }} 格</template>
            </p>
            <ul v-if="result.failed.length" class="mt-1.5 space-y-0.5 text-fine text-weak">
              <li v-for="(f, i) in result.failed" :key="i">{{ f }}</li>
            </ul>
          </div>
        </template>
      </div>

      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ result ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" data-test="import-submit" @click="doImport">
          {{ importing ? "导入中…" : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
