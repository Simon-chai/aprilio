<script setup lang="ts">
/**
 * 导入花名册对话框：指定格式导入 / 智能导入两种模式，支持一次选择多个文件。
 *
 * 与 Agent 工具 import_student_roster 共用 src/lib/roster.ts 的核心管道：
 * 解析 → 姓名列识别（规则 + 可选 AI）→ 字段映射 → 行校验 → 落库。
 * 智能导入模式会展示识别结果（方式、置信度、理由），置信度低时要求人工选择姓名列。
 *
 * 多文件：文件队列逐个独立识别、逐个独立落库（未命名批次各自单立新班逻辑不变），
 * 导入完成后把各文件结果聚合成一次 imported 事件，父视图无需改动。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AnalyzingOverlay from "./AnalyzingOverlay.vue";
import { isTauri } from "../lib/db";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { createLlm } from "../agent/providers";
import { logError, logInfo } from "../lib/logger";
import {
  ROSTER_FIELD_LABELS,
  aiDetectNameColumn,
  combineNameDetection,
  decodeRosterBytes,
  detectFieldMapping,
  detectNameColumn,
  downloadRosterTemplate,
  findNameColumnByHeader,
  importRosterStudents,
  isUnnamedBatch,
  parseRosterTable,
  pickRosterFiles,
  prepareRosterRows,
  validateTemplateTable,
  type NameDetection,
  type RosterField,
  type RosterImportResult,
  type RosterTable,
} from "../lib/roster";
import { detectScoreSheet, type ScoreSheetDetection } from "../lib/scores";
import { applyInferredClassMeta } from "../lib/semester-ai";
import type { StudentInput } from "../types";

type Mode = "smart" | "template";

/** 多文件队列中的单个文件及其独立识别状态 */
interface RosterFileEntry {
  key: number;
  label: string;
  sheet: string;
  table: RosterTable;
  detection: NameDetection | null;
  selectedColumn: number;
  templateError: string;
  /** 成绩单检测：花名册入口最常见的起点就是一份成绩单，提示可一键转成绩导入 */
  scoreHint: ScoreSheetDetection | null;
  scoreHintDismissed: boolean;
  result: RosterImportResult | null;
  error: string;
}

const props = withDefaults(
  defineProps<{ open: boolean; initialMode?: Mode; presetClass?: string }>(),
  { initialMode: "smart" },
);
const emit = defineEmits<{
  close: [];
  /** 导入完成：多文件结果已聚合（成功/更新累加、跳过与失败明细合并），父视图负责关闭对话框与跳转 */
  imported: [payload: { result: RosterImportResult; targetClass: string | null }];
  /** 检测到成绩单且用户选择转入成绩导入：把已解析表格交给父视图打开「导入成绩」 */
  "switch-to-scores": [payload: { table: RosterTable; fileName: string }];
}>();

const mode = ref<Mode>(props.initialMode);
const files = ref<RosterFileEntry[]>([]);
const activeKey = ref<number | null>(null);
const nextKey = ref(1);
const analyzing = ref(false);
const importing = ref(false);
const readError = ref("");

const activeFile = computed(
  () => files.value.find((f) => f.key === activeKey.value) ?? files.value[0] ?? null,
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    mode.value = props.initialMode;
    files.value = [];
    activeKey.value = null;
    importing.value = false;
    analyzing.value = false;
    readError.value = "";
  },
);

watch(mode, async () => {
  for (const entry of files.value) {
    await analyzeEntry(entry);
  }
});

/** 对单个文件做姓名列识别 / 模板校验（表格已就绪，解析在载入时完成） */
async function analyzeEntry(entry: RosterFileEntry) {
  analyzing.value = true;
  entry.detection = null;
  entry.templateError = "";
  entry.result = null;
  entry.error = "";
  entry.selectedColumn = -1;
  entry.scoreHint = null;
  entry.scoreHintDismissed = false;

  try {
    const t = entry.table;
    if (mode.value === "template") {
      const check = validateTemplateTable(t);
      if (!check.ok) {
        entry.templateError = `这不是标准模板表格：缺少「${check.missing.join("、")}」列。请下载模板填写后重试，或改用智能导入。`;
      }
      entry.selectedColumn = findNameColumnByHeader(t);
      return;
    }

    // 成绩单检测（仅智能导入模式）：识别到科目成绩列时提示可转入成绩导入
    entry.scoreHint = detectScoreSheet(t, { fileName: entry.label });

    const rule = detectNameColumn(t);
    entry.detection = rule;
    entry.selectedColumn = rule.selected;

    // 已配置 AI 模型时叠加模型识别（失败/不可用自动回退规则结果）
    const config = loadAiConfig();
    if (isAiConfigured(config)) {
      try {
        const ai = await aiDetectNameColumn(t, createLlm(), config);
        if (ai) {
          entry.detection = combineNameDetection(rule, ai);
          entry.selectedColumn = entry.detection.selected;
        }
      } catch {
        /* 保留规则识别结果 */
      }
    }
  } finally {
    analyzing.value = false;
  }
}

/** 新增一个已解析表格到队列并分析（文件入口，桌面端表格通道 / 测试注入共用） */
async function addTable(table: RosterTable, label: string, sheet = "") {
  const entry: RosterFileEntry = {
    key: nextKey.value++,
    label,
    sheet,
    table,
    detection: null,
    selectedColumn: -1,
    templateError: "",
    scoreHint: null,
    scoreHintDismissed: false,
    result: null,
    error: "",
  };
  files.value.push(entry);
  activeKey.value = entry.key;
  await analyzeEntry(entry);
}

/** 载入已解析的表格并分析（单文件入口，测试与外部调用兼容：追加到队列） */
async function loadTable(loaded: { table: RosterTable; sheet?: string }, label: string) {
  readError.value = "";
  await addTable(loaded.table, label, loaded.sheet ?? "");
}

/** 解析文本为表格并分析（CSV 文本入口，浏览器演示态与测试使用：追加到队列） */
async function loadText(text: string, label = "") {
  try {
    await addTable(parseRosterTable(text), label);
  } catch (e) {
    readError.value = `解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 兼容旧暴露接口：重新分析当前选中的文件 */
async function analyzeFromTable() {
  if (activeFile.value) await analyzeEntry(activeFile.value);
}

function removeFile(key: number) {
  const i = files.value.findIndex((f) => f.key === key);
  if (i >= 0) files.value.splice(i, 1);
  if (activeKey.value === key) activeKey.value = files.value[0]?.key ?? null;
}

async function chooseFile() {
  readError.value = "";
  if (isTauri()) {
    try {
      const loadedList = await pickRosterFiles();
      if (!loadedList) return;
      for (const loaded of loadedList) {
        await addTable(loaded.table, loaded.fileName, loaded.sheet ?? "");
      }
    } catch (e) {
      readError.value = `读取文件失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return;
  }
  const picked = await pickViaInput();
  if (!picked.length) return;
  const failures: string[] = [];
  for (const file of picked) {
    try {
      const text = decodeRosterBytes(await file.arrayBuffer()).text;
      await addTable(parseRosterTable(text), file.name);
    } catch (e) {
      failures.push(`${file.name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length) readError.value = `部分文件解析失败：${failures.join("；")}`;
}

/** 浏览器演示态的文件选择（<input type=file multiple>；取消时靠窗口焦点回落识别） */
function pickViaInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".csv,.tsv,.txt,text/csv,text/plain";
    let settled = false;
    const done = (list: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      resolve(list);
    };
    const onFocus = () => setTimeout(() => done(input.files ? Array.from(input.files) : []), 300);
    input.addEventListener("change", () => done(input.files ? Array.from(input.files) : []));
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

/** 当前选中文件的字段映射（含预设班级回填） */
function mappingOf(entry: RosterFileEntry) {
  if (entry.selectedColumn < 0) return null;
  return detectFieldMapping(entry.table, entry.selectedColumn);
}

function preparedOf(entry: RosterFileEntry) {
  const mapping = mappingOf(entry);
  if (!mapping) return null;
  const prep = prepareRosterRows(entry.table, mapping);
  if (props.presetClass) {
    return {
      ...prep,
      rows: prep.rows.map((r) => ({ ...r, grade_class: r.grade_class || props.presetClass || "" })),
    };
  }
  return prep;
}

const mapping = computed(() => (activeFile.value ? mappingOf(activeFile.value) : null));

const prepared = computed(() => (activeFile.value ? preparedOf(activeFile.value) : null));

/** 单个文件是否具备导入条件（供导入按钮与批量导入共用） */
function isEntryReady(entry: RosterFileEntry): boolean {
  if (entry.selectedColumn < 0 || entry.error || entry.result) return false;
  if (mode.value === "template" && entry.templateError) return false;
  const prep = preparedOf(entry);
  return !!prep && prep.rows.length > 0;
}

const pendingCount = computed(() => files.value.filter((f) => !f.result).length);

const canImport = computed(
  () => files.value.some(isEntryReady) && !analyzing.value && !importing.value,
);

/** 已出结果的文件聚合（多文件结果栏用） */
const aggregated = computed(() => {
  const done = files.value.filter((f) => f.result);
  if (!done.length) return null;
  return {
    count: done.length,
    imported: done.reduce((n, f) => n + (f.result?.imported ?? 0), 0),
    updated: done.reduce((n, f) => n + (f.result?.updated ?? 0), 0),
    skipped: done.flatMap((f) => f.result?.skipped ?? []),
    failed: done.flatMap((f) => f.result?.failed ?? []),
  };
});

const previewRows = computed(() => activeFile.value?.table.rows.slice(0, 5) ?? []);

/** 未命名批次预览：无预设班级且所有行都没有班级信息，导入时会自动单立新班 */
const isUnnamedPreview = computed(() => {
  if (props.presetClass || !prepared.value?.rows?.length) return false;
  return isUnnamedBatch(prepared.value.rows as StudentInput[]);
});

function colLabel(index: number): string {
  const header = activeFile.value?.table.headers[index] ?? "";
  return `第${index + 1}列${header ? `「${header}」` : ""}`;
}

function fileStatus(entry: RosterFileEntry): string {
  if (entry.result) {
    return `已导入：成功 ${entry.result.imported} · 更新 ${entry.result.updated}` +
      (entry.result.failed.length ? ` · 失败 ${entry.result.failed.length}` : "");
  }
  if (entry.error) return "识别失败";
  if (entry.selectedColumn < 0) return "待确认姓名列";
  return "待导入";
}

const mappingEntries = computed(() => {
  if (!mapping.value) return [];
  const entries = [{ field: "姓名", column: colLabel(mapping.value.nameColumn) }];
  for (const [field, column] of Object.entries(mapping.value.fields)) {
    if (column === undefined) continue;
    entries.push({ field: ROSTER_FIELD_LABELS[field as RosterField], column: colLabel(column) });
  }
  return entries;
});

const confidenceLabel = computed(() => {
  const c = activeFile.value?.detection?.confidence;
  return c === "high" ? "高" : c === "medium" ? "中" : "低";
});

/** 从单文件的行推断导入目标班级：全部行同一班级时返回该班级名，否则 null */
function inferTargetClass(rows: StudentInput[]): string | null {
  if (props.presetClass) return props.presetClass;
  const classes = new Set<string>();
  for (const row of rows) {
    const gc = (row.grade_class ?? "") as string;
    if (gc) classes.add(gc);
  }
  return classes.size === 1 ? ([...classes][0] ?? null) : null;
}

async function doImport() {
  if (importing.value) return;
  importing.value = true;
  try {
    let imported = 0;
    let updated = 0;
    const skipped: { name: string; reason: string }[] = [];
    const failed: { row: number; name: string; reason: string }[] = [];
    const targetClasses: string[] = [];
    const autoClasses: string[] = [];

    for (const entry of files.value) {
      if (entry.result) continue;
      if (entry.selectedColumn < 0) {
        entry.error = "请先在下拉框中选择姓名列";
        continue;
      }
      if (mode.value === "template" && entry.templateError) continue;
      const prep = preparedOf(entry);
      if (!prep || !prep.rows.length) {
        entry.error = "没有可导入的数据行";
        continue;
      }
      try {
        const r = await importRosterStudents(prep);
        entry.result = r;
        entry.error = "";
        imported += r.imported;
        updated += r.updated;
        skipped.push(...r.skipped);
        failed.push(...r.failed);
        logInfo(
          `花名册导入完成「${entry.label || "未命名文件"}」：成功 ${r.imported}，更新 ${r.updated}，跳过 ${r.skipped.length}，失败 ${r.failed.length}`,
        );
        // 导入收尾：从文件名 / 标题行识别年级与学期，补写班级元信息（失败静默，不阻塞）
        // 未命名批次优先用落库时分配的自动班级，保证两次导入分成两个班后能正确跳转
        const targetClass = r.autoClass || inferTargetClass(prep.rows as StudentInput[]);
        if (r.autoClass) autoClasses.push(r.autoClass);
        if (targetClass) {
          targetClasses.push(targetClass);
          await applyInferredClassMeta(targetClass, [entry.label, ...(entry.table.titleText ?? [])]);
        }
      } catch (e) {
        logError("花名册导入失败", e);
        entry.error = `导入失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const distinctTargets = [...new Set(targetClasses.filter(Boolean))];
    const distinctAutos = [...new Set(autoClasses.filter(Boolean))];
    const aggregatedResult: RosterImportResult = {
      imported,
      updated,
      skipped,
      failed,
      autoClass: distinctAutos.length === 1 ? distinctAutos[0] : null,
    };
    logInfo(
      `花名册批量导入完成：文件 ${files.value.length} 个，成功 ${imported}，更新 ${updated}，跳过 ${skipped.length}，失败 ${failed.length}`,
    );
    emit("imported", {
      result: aggregatedResult,
      targetClass: distinctTargets.length === 1 ? distinctTargets[0] : null,
    });
  } finally {
    importing.value = false;
  }
}

defineExpose({ loadText, loadTable, analyzeFromTable });
</script>

<template>
  <div
    v-if="props.open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8"
    @click.self="emit('close')"
  >
    <div class="flex max-h-full w-[780px] max-w-full flex-col rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-4 flex shrink-0 items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">导入花名册</h2>
        <button class="text-caption text-weak hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div class="scroll-thin relative min-h-0 flex-1 overflow-y-auto pr-1">
        <!-- AI 分析中：动画独占舞台（内容区此时很矮，叠在原内容上会被裁切/半透明透底） -->
        <div v-if="analyzing" data-test="analyzing-stage" class="relative min-h-[320px]">
          <AnalyzingOverlay
            :show="analyzing"
            title="智能识别中"
            :steps="['解析表格结构…', '识别列语义…', 'AI 分析姓名列…']"
          />
        </div>
        <template v-else>
        <!-- 模式切换 -->
        <div class="flex items-center gap-4">
          <div class="inline-flex rounded-md border border-hairline bg-parchment p-1">
            <button
              type="button"
              class="rounded-[6px] px-4 py-1.5 text-caption transition-colors"
              :class="mode === 'smart' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
              @click="mode = 'smart'"
            >
              智能导入
            </button>
            <button
              type="button"
              class="rounded-[6px] px-4 py-1.5 text-caption transition-colors"
              :class="mode === 'template' ? 'bg-canvas font-medium text-primary' : 'text-weak hover:text-ink'"
              @click="mode = 'template'"
            >
              指定格式导入
            </button>
          </div>
          <p class="min-w-0 flex-1 text-fine text-weak">
            {{
              mode === "smart"
                ? "任意表格：自动识别姓名列（已配置 AI 时由模型辅助判断），其余列按表头自动映射。"
                : "使用标准模板表头（姓名、性别、学号……），可先下载模板填写。"
            }}
          </p>
        </div>

        <!-- 文件选择 -->
        <div class="mt-4 flex items-center gap-3">
          <AppButton variant="secondary" @click="chooseFile">选择文件</AppButton>
          <AppButton variant="pearl" @click="downloadRosterTemplate">下载模板</AppButton>
          <span class="min-w-0 flex-1 truncate text-caption text-weak">
            {{ activeFile?.label || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV，可多选）" }}
          </span>
        </div>

        <!-- 多文件队列：每文件独立识别、独立导入 -->
        <div v-if="files.length > 1" data-test="roster-file-list" class="mt-3 space-y-1.5">
          <p class="text-fine text-weak">已选择 {{ files.length }} 个文件（每文件独立识别、独立导入）：</p>
          <div
            v-for="f in files"
            :key="f.key"
            class="flex items-center gap-2 rounded-sm border px-2 py-1.5 text-caption"
            :class="f.key === activeFile?.key ? 'border-primary-focus bg-primary-soft' : 'border-hairline'"
          >
            <button type="button" class="min-w-0 flex-1 truncate text-left" @click="activeKey = f.key">
              <span class="font-medium text-ink">{{ f.label || "未命名文件" }}</span>
              <span class="text-weak"> · {{ f.table.rows.length }} 行 · {{ fileStatus(f) }}</span>
            </button>
            <button
              type="button"
              data-test="roster-file-remove"
              class="shrink-0 text-fine text-weak hover:text-danger"
              @click="removeFile(f.key)"
            >
              移除
            </button>
          </div>
        </div>

        <p v-if="readError" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ readError }}</p>
        <p v-if="activeFile?.templateError" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
          {{ activeFile.templateError }}
        </p>
        <p v-if="activeFile?.error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
          {{ activeFile.error }}
        </p>

        <!-- 成绩单提示：转入成绩导入，或继续按花名册导入 -->
        <div
          v-if="activeFile?.scoreHint && !activeFile.scoreHintDismissed && mode === 'smart'"
          data-test="score-sheet-banner"
          class="mt-4 rounded-md bg-primary-soft p-3"
        >
          <p class="text-caption text-ink">
            这更像一份<b>成绩单</b>（识别到科目列：{{
              activeFile.scoreHint.subjects.map((s) => s.name).join("、")
            }}）。转为成绩导入会自动创建一次考试，并把成绩关联到学生档案。
          </p>
          <div class="mt-2 flex items-center gap-3">
            <AppButton
              variant="primary"
              data-test="switch-to-scores-btn"
              @click="
                emit('switch-to-scores', {
                  table: activeFile!.table,
                  fileName: activeFile!.label,
                })
              "
            >
              转为成绩导入
            </AppButton>
            <button
              type="button"
              class="text-caption text-weak hover:text-ink"
              @click="activeFile!.scoreHintDismissed = true"
            >
              仍按花名册导入
            </button>
          </div>
        </div>

        <!-- 解析结果 -->
        <template v-if="activeFile && !activeFile.error">
          <p class="mt-4 text-caption text-muted">
            共 {{ activeFile.table.rows.length }} 行数据 ·
            {{ activeFile.table.hasHeader ? "已识别表头" : "未识别表头（首行按数据处理）" }}
            <template v-if="activeFile.sheet"> · 工作表「{{ activeFile.sheet }}」</template>
          </p>

          <!-- 姓名列识别（智能导入） -->
          <div v-if="mode === 'smart'" class="mt-3 rounded-md bg-parchment p-3">
            <div class="flex flex-wrap items-center gap-3">
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">姓名列</span>
                <select
                  v-model="activeFile.selectedColumn"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                >
                  <option :value="-1" disabled>请选择姓名列</option>
                  <option v-for="(header, i) in activeFile.table.headers" :key="i" :value="i">
                    第{{ i + 1 }}列{{ activeFile.table.hasHeader ? ' ' + header : '' }}
                  </option>
                </select>
              </label>
              <span
                v-if="activeFile.detection && activeFile.selectedColumn >= 0"
                class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted"
              >
                {{ activeFile.detection.method === "ai" ? "AI 识别" : "规则识别" }} · 置信度{{ confidenceLabel }}
                <template v-if="activeFile.detection.reason">· {{ activeFile.detection.reason }}</template>
              </span>
            </div>
            <p
              v-if="activeFile.detection && activeFile.detection.confidence === 'low'"
              class="mt-2 text-fine text-danger"
            >
              未能可靠识别姓名列，请在下拉框中人工选择；无法确定时建议改用「指定格式导入」。
            </p>
          </div>

          <!-- 字段映射 -->
          <div v-if="mappingEntries.length" class="mt-3 flex flex-wrap items-center gap-2">
            <span
              v-for="entry in mappingEntries"
              :key="entry.field"
              class="rounded-sm bg-parchment px-2 py-1 text-fine text-muted"
            >
              {{ entry.field }} ← {{ entry.column }}
            </span>
            <span class="text-fine text-weak">其余列将忽略</span>
          </div>

          <!-- 未命名批次提示：无班级信息时自动单立新班，避免两次导入并入同一班 -->
          <p v-if="isUnnamedPreview" class="mt-3 rounded-md bg-primary-soft p-3 text-caption text-ink">
            未检测到班级信息，导入时将自动新建一个班级（与之前导入的分开，可在班级管理重命名）。
          </p>

          <!-- 预览 -->
          <div class="scroll-thin mt-3 overflow-x-auto rounded-sm border border-hairline">
            <table class="w-full text-caption">
              <thead>
                <tr class="bg-parchment text-left">
                  <th
                    v-for="(header, i) in activeFile.table.headers"
                    :key="i"
                    class="whitespace-nowrap px-3 py-2 font-normal"
                    :class="i === activeFile.selectedColumn ? 'text-primary' : 'text-weak'"
                  >
                    {{ header }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, ri) in previewRows" :key="ri" class="border-t border-hairline">
                  <td
                    v-for="(_, ci) in activeFile.table.headers"
                    :key="ci"
                    class="max-w-[180px] truncate whitespace-nowrap px-3 py-1.5"
                    :class="ci === activeFile.selectedColumn ? 'bg-primary-soft font-medium text-ink' : 'text-muted'"
                    :title="row[ci] ?? ''"
                  >
                    {{ row[ci] ?? "" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="activeFile.table.rows.length > 5" class="mt-1 text-fine text-weak">
            仅预览前 5 行，共 {{ activeFile.table.rows.length }} 行。
          </p>
          <p v-if="prepared && prepared.issues.length" class="mt-1 text-fine text-muted">
            {{ prepared.issues.length }} 行无法导入（姓名缺失或表内学号重复），导入时将跳过。
          </p>
        </template>

        <!-- 导入结果：单文件沿用原样式；多文件展示聚合 + 逐文件明细 -->
        <div v-if="files.length <= 1 && activeFile?.result" class="mt-4 rounded-md bg-parchment p-3">
          <p class="text-caption font-medium text-ink">
            导入完成：成功 {{ activeFile.result.imported }} · 更新 {{ activeFile.result.updated }} · 跳过
            {{ activeFile.result.skipped.length }} · 失败 {{ activeFile.result.failed.length }}
            <template v-if="activeFile.result.autoClass"> · 已进入「{{ activeFile.result.autoClass }}」</template>
          </p>
          <ul
            v-if="activeFile.result.skipped.length || activeFile.result.failed.length"
            class="mt-1.5 space-y-0.5 text-fine text-weak"
          >
            <li v-for="(s, i) in activeFile.result.skipped.slice(0, 5)" :key="`s${i}`">{{ s.name }}：{{ s.reason }}</li>
            <li v-for="(f, i) in activeFile.result.failed.slice(0, 5)" :key="`f${i}`">
              第{{ f.row || "—" }}行 {{ f.name || "空姓名" }}：{{ f.reason }}
            </li>
          </ul>
          <p v-if="!activeFile.result.failed.length" class="mt-1 text-fine text-weak">
            正在返回班级详情，无需其他操作…
          </p>
        </div>
        <div v-if="files.length > 1 && aggregated" class="mt-4 rounded-md bg-parchment p-3">
          <p class="text-caption font-medium text-ink">
            批量导入完成（{{ aggregated.count }}/{{ files.length }} 个文件）：成功 {{ aggregated.imported }} · 更新
            {{ aggregated.updated }} · 跳过 {{ aggregated.skipped.length }} · 失败 {{ aggregated.failed.length }}
          </p>
          <ul class="mt-1.5 space-y-0.5 text-fine text-weak">
            <li v-for="f in files" :key="`r${f.key}`">
              {{ f.label || "未命名文件" }}：{{
                f.result
                  ? `成功 ${f.result.imported} · 更新 ${f.result.updated} · 跳过 ${f.result.skipped.length} · 失败 ${f.result.failed.length}`
                  : f.error || "未导入"
              }}
            </li>
          </ul>
        </div>
        </template>
      </div>

      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ aggregated ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" @click="doImport">
          {{ importing ? "导入中…" : files.length > 1 ? `开始导入（${pendingCount} 个待导入）` : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
