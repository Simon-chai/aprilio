<script setup lang="ts">
/**
 * 导入成绩对话框：把成绩单导入为考试批次，支持一次选择多个文件。
 *
 * 与 Agent 工具 import_score_sheet 共用 src/lib/scores.ts 的核心管道：
 * 成绩单识别（姓名列 + 科目列，规则 + 可选 AI）→ 考试名/时间提取（可手动改）
 * → 行校验 → 考试批次幂等复用 → 成绩落库（缺失学生自动建档）。
 * 从「导入花名册」检测到成绩单时，可由父视图携带已解析表格交接进来。
 *
 * 多文件：每文件独立识别、独立考试批次（考试名/时间按各自标题行提取、
 * 可逐个手动修改），导入完成后聚合成一次 imported 事件，父视图无需改动。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AnalyzingOverlay from "./AnalyzingOverlay.vue";
import { isTauri } from "../lib/db";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { createLlm } from "../agent/providers";
import { logError, logInfo } from "../lib/logger";
import { localDateStr } from "../lib/format";
import { decodeRosterBytes, parseRosterTable, pickRosterFiles, type RosterTable } from "../lib/roster";
import {
  aiDetectScoreSheet,
  combineScoreDetection,
  detectScoreSheet,
  prepareScoreRows,
  runSmartScoreImport,
  type ScoreImportResult,
  type ScoreSheetDetection,
} from "../lib/scores";
import { applyInferredClassMeta } from "../lib/semester-ai";

/** 多文件队列中的单个成绩单及其独立考试信息 */
interface ScoreFileEntry {
  key: number;
  label: string;
  sheet: string;
  table: RosterTable;
  detection: ScoreSheetDetection | null;
  notScoreSheet: boolean;
  selectedColumn: number;
  examName: string;
  examDate: string;
  result: ScoreImportResult | null;
  /** 导入生成的考试批次（展示与跳转用） */
  examLabel: string;
  examClass: string;
  error: string;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 成绩归属班级（班级详情页传入，避免同名学生跨班误匹配） */
    presetClass?: string;
    /** 由花名册对话框交接进来的已解析表格 */
    initialTable?: RosterTable | null;
    initialFileName?: string;
  }>(),
  { presetClass: "", initialTable: null, initialFileName: "" },
);
const emit = defineEmits<{
  close: [];
  /** 导入完成：多文件结果已聚合（归属班级唯一时带出，否则 null），父视图负责关闭与跳转 */
  imported: [payload: { className: string | null }];
}>();

const files = ref<ScoreFileEntry[]>([]);
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
    files.value = [];
    activeKey.value = null;
    analyzing.value = false;
    importing.value = false;
    readError.value = "";
    if (props.initialTable) {
      void addTable(props.initialTable, props.initialFileName);
    }
  },
);

/** 对单个文件做成绩单识别（表格已就绪，解析在载入时完成） */
async function analyzeEntry(entry: ScoreFileEntry) {
  analyzing.value = true;
  entry.detection = null;
  entry.notScoreSheet = false;
  entry.result = null;
  entry.examLabel = "";
  entry.examClass = "";
  entry.error = "";
  entry.selectedColumn = -1;

  try {
    const t = entry.table;
    let rule = detectScoreSheet(t, { fileName: entry.label });
    if (!rule) {
      // 规则不认为这是成绩单：已配置模型时再问一次，仍不是才提示
      const config = loadAiConfig();
      if (isAiConfigured(config)) {
        try {
          const ai = await aiDetectScoreSheet(t, createLlm(), config);
          if (ai && ai.subjects.length) {
            rule = {
              nameColumn: ai.name_column,
              nameDetection: {
                candidates: [],
                selected: ai.name_column,
                confidence: ai.confidence >= 0.7 ? "high" : "medium",
                method: "ai",
                reason: ai.reason || "AI 识别",
              },
              subjects: ai.subjects.map((s) => ({
                index: s.column,
                header: t.headers[s.column] ?? `第${s.column + 1}列`,
                name: s.name,
                from: "ai" as const,
              })),
              examName: ai.exam_name ?? null,
              examDate: ai.exam_date ?? null,
              className: null,
              studentNoColumn: -1,
              confidence: "medium",
              reason: ai.reason || "AI 识别",
            };
          }
        } catch {
          /* 保留规则结果（null） */
        }
      }
    } else if (isAiConfigured(loadAiConfig())) {
      // 规则识别成功且配置了模型：叠加 AI，修正科目名与考试信息
      try {
        const ai = await aiDetectScoreSheet(t, createLlm(), loadAiConfig());
        if (ai && ai.subjects.length) {
          rule = combineScoreDetection(t, rule, ai);
        }
      } catch {
        /* 保留规则识别结果 */
      }
    }

    if (!rule) {
      entry.notScoreSheet = true;
      return;
    }

    entry.detection = rule;
    entry.selectedColumn = rule.nameColumn;
    entry.examName = rule.examName ?? "";
    entry.examDate = rule.examDate ?? localDateStr();
  } finally {
    analyzing.value = false;
  }
}

/** 新增一个已解析表格到队列并分析（文件入口 / 花名册对话框交接共用） */
async function addTable(table: RosterTable, label: string, sheet = "") {
  const entry: ScoreFileEntry = {
    key: nextKey.value++,
    label,
    sheet,
    table,
    detection: null,
    notScoreSheet: false,
    selectedColumn: -1,
    examName: "",
    examDate: localDateStr(),
    result: null,
    examLabel: "",
    examClass: "",
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
    input.accept = ".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/plain";
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

/** 手动改姓名列：只覆盖识别结果里的姓名列，科目列保持不变 */
function onNameColumnChange() {
  const entry = activeFile.value;
  if (entry?.detection && entry.selectedColumn >= 0) {
    entry.detection = { ...entry.detection, nameColumn: entry.selectedColumn };
  }
}

function effectiveDetectionOf(entry: ScoreFileEntry) {
  return entry.detection && entry.selectedColumn >= 0
    ? { ...entry.detection, nameColumn: entry.selectedColumn }
    : entry.detection;
}

function preparedOf(entry: ScoreFileEntry) {
  const det = effectiveDetectionOf(entry);
  return entry.table && det && det.nameColumn >= 0 ? prepareScoreRows(entry.table, det) : null;
}

const prepared = computed(() => (activeFile.value ? preparedOf(activeFile.value) : null));

/** 单个文件是否具备导入条件 */
function isEntryReady(entry: ScoreFileEntry): boolean {
  if (entry.result || entry.notScoreSheet || entry.error) return false;
  if (!entry.detection || entry.selectedColumn < 0) return false;
  if (!entry.examName.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.examDate)) return false;
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
    written: done.reduce((n, f) => n + (f.result?.scores_written ?? 0), 0),
    matched: done.reduce((n, f) => n + (f.result?.students_matched ?? 0), 0),
    created: done.reduce((n, f) => n + (f.result?.students_created ?? 0), 0),
    skipped: done.reduce((n, f) => n + (f.result?.skipped.length ?? 0), 0),
    failed: done.reduce((n, f) => n + (f.result?.failed.length ?? 0), 0),
  };
});

const previewRows = computed(() => activeFile.value?.table.rows.slice(0, 5) ?? []);

function colLabel(index: number): string {
  const header = activeFile.value?.table.headers[index] ?? "";
  return `第${index + 1}列${header ? `「${header}」` : ""}`;
}

function fileStatus(entry: ScoreFileEntry): string {
  if (entry.result) return `已导入：${entry.examLabel || "考试"} · 写入 ${entry.result.scores_written} 条`;
  if (entry.error) return "导入失败";
  if (entry.notScoreSheet) return "不像成绩单";
  if (!entry.detection || entry.selectedColumn < 0) return "待确认姓名列";
  return "待导入";
}

const confidenceLabel = computed(() => {
  const c = activeFile.value?.detection?.confidence;
  return c === "high" ? "高" : c === "medium" ? "中" : "低";
});

async function doImport() {
  if (importing.value) return;
  importing.value = true;
  try {
    const examClasses: string[] = [];
    for (const entry of files.value) {
      if (entry.result) continue;
      if (!isEntryReady(entry)) {
        if (!entry.result && !entry.notScoreSheet && !entry.error) {
          entry.error = !entry.examName.trim()
            ? "请填写考试名"
            : "该文件暂不具备导入条件（姓名列/考试时间/成绩行请检查）";
        }
        continue;
      }
      entry.error = "";
      try {
        const outcome = await runSmartScoreImport(entry.table, {
          className: props.presetClass || undefined,
          examName: entry.examName.trim() || undefined,
          examDate: entry.examDate || undefined,
          // options.nameColumn 口径是「从 1 起的列号」（与 Agent 工具、报错提示一致）；
          // 对话框内部 selectedColumn 是 0 起下标——直接传会把第一列（姓名）判成找不到
          nameColumn: entry.selectedColumn >= 0 ? entry.selectedColumn + 1 : undefined,
          fileName: entry.label || undefined,
        });
        if (outcome.status === "ok") {
          if (!outcome.result) {
            entry.error = "导入流程异常：缺少导入结果。";
            continue;
          }
          entry.result = outcome.result;
          entry.examLabel = outcome.exam.name;
          entry.examClass = outcome.exam.class_name;
          logInfo(
            `成绩导入完成「${entry.label || "未命名文件"}」：考试「${outcome.exam.name}」(${outcome.exam.exam_date})，成绩 ${outcome.result.scores_written} 条，` +
              `匹配 ${outcome.result.students_matched} 人，建档 ${outcome.result.students_created} 人，` +
              `跳过 ${outcome.result.skipped.length}，失败 ${outcome.result.failed.length}`,
          );
          // 导入收尾：从文件名 / 标题行识别年级与学期，补写班级元信息（失败静默，不阻塞）
          const targetClass = props.presetClass || outcome.exam.class_name;
          if (targetClass) {
            examClasses.push(targetClass);
            await applyInferredClassMeta(targetClass, [entry.label, ...(entry.table.titleText ?? [])]);
          }
        } else {
          // not-score-sheet / need-column / error 都带 message
          entry.error = outcome.message;
        }
      } catch (e) {
        logError("成绩导入失败", e);
        entry.error = `导入失败：${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const distinct = [...new Set(examClasses.filter(Boolean))];
    logInfo(
      `成绩批量导入完成：文件 ${files.value.length} 个，` +
        `写入 ${aggregated.value?.written ?? 0} 条成绩，建档 ${aggregated.value?.created ?? 0} 人`,
    );
    emit("imported", { className: props.presetClass || (distinct.length === 1 ? distinct[0] : null) });
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
    <div class="flex max-h-full w-[820px] max-w-full flex-col rounded-lg bg-canvas p-6 shadow-window">
      <div class="mb-4 flex shrink-0 items-center justify-between">
        <h2 class="text-tagline font-semibold text-ink">导入成绩</h2>
        <button class="text-caption text-weak hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div class="scroll-thin relative min-h-0 flex-1 overflow-y-auto pr-1">
        <!-- AI 分析中：动画独占舞台（内容区此时很矮，叠在原内容上会被裁切/半透明透底） -->
        <div v-if="analyzing" data-test="analyzing-stage" class="relative min-h-[320px]">
          <AnalyzingOverlay
            :show="analyzing"
            title="智能识别中"
            :steps="['解析成绩单结构…', '识别科目列…', 'AI 分析列含义…']"
          />
        </div>
        <template v-else>
        <p class="text-fine text-weak">
          选择成绩单（XLSX / XLS / CSV / TSV / TXT，浏览器演示态仅 CSV，可多选）：自动识别姓名列与科目列，
          从标题行提取考试名与考试时间；每文件独立生成一次考试批次，同一班级同考试名同时间只保留一个批次，重复导入仅更新成绩。
        </p>

        <!-- 文件选择 -->
        <div class="mt-4 flex items-center gap-3">
          <AppButton variant="secondary" @click="chooseFile">选择文件</AppButton>
          <span class="min-w-0 flex-1 truncate text-caption text-weak">
            {{ activeFile?.label || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV，可多选）" }}
          </span>
        </div>

        <!-- 多文件队列：每文件独立考试 -->
        <div v-if="files.length > 1" data-test="score-file-list" class="mt-3 space-y-1.5">
          <p class="text-fine text-weak">已选择 {{ files.length }} 个文件（每文件独立生成一次考试）：</p>
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
              data-test="score-file-remove"
              class="shrink-0 text-fine text-weak hover:text-danger"
              @click="removeFile(f.key)"
            >
              移除
            </button>
          </div>
        </div>

        <p v-if="readError" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ readError }}</p>
        <p v-if="activeFile?.error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
          {{ activeFile.error }}
        </p>
        <p
          v-if="activeFile?.notScoreSheet"
          class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger"
        >
          这张表格不像成绩单：没有识别到科目成绩列。若要导入学生花名册，请使用「导入花名册」。
        </p>

        <!-- 解析结果 -->
        <template v-if="activeFile && !activeFile.error && activeFile.detection">
          <p class="mt-4 text-caption text-muted">
            共 {{ activeFile.table.rows.length }} 行数据 ·
            {{ activeFile.table.hasHeader ? "已识别表头" : "未识别表头（首行按数据处理）" }}
            <template v-if="activeFile.sheet"> · 工作表「{{ activeFile.sheet }}」</template>
          </p>

          <!-- 考试批次信息（每文件独立） -->
          <div class="mt-3 rounded-md bg-parchment p-3">
            <div class="flex flex-wrap items-end gap-3">
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">考试名</span>
                <input
                  v-model="activeFile.examName"
                  data-test="exam-name-input"
                  class="h-8 w-44 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                  placeholder="如：期中考试"
                />
              </label>
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">考试时间</span>
                <!-- 原生日期选择器：点击日历图标即可选日期，无需手敲 YYYY-MM-DD -->
                <input
                  v-model="activeFile.examDate"
                  data-test="exam-date-input"
                  type="date"
                  class="h-8 w-36 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                />
              </label>
              <span v-if="props.presetClass" class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted">
                班级 {{ props.presetClass }}
              </span>
              <span
                v-if="activeFile.examName || activeFile.detection.examName"
                class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted"
              >
                {{ activeFile.detection.examName ? "考试名提取自标题行" : "考试名手动填写" }}
                · 置信度{{ confidenceLabel }}
              </span>
            </div>
            <p v-if="activeFile.detection.confidence === 'low'" class="mt-2 text-fine text-danger">
              未能可靠识别姓名列，请在下方人工选择；科目列与考试信息也建议核对。
            </p>
          </div>

          <!-- 姓名列与科目列 -->
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2">
              <span class="text-caption text-ink">姓名列</span>
              <select
                v-model="activeFile.selectedColumn"
                data-test="name-column-select"
                class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                @change="onNameColumnChange"
              >
                <option :value="-1" disabled>请选择姓名列</option>
                <option v-for="(header, i) in activeFile.table.headers" :key="i" :value="i">
                  第{{ i + 1 }}列{{ activeFile.table.hasHeader ? ' ' + header : '' }}
                </option>
              </select>
            </label>
            <span
              v-for="subj in activeFile.detection.subjects"
              :key="subj.index"
              class="rounded-sm bg-parchment px-2 py-1 text-fine text-muted"
            >
              {{ subj.name }} ← {{ colLabel(subj.index) }}
              <template v-if="subj.from === 'content'">（按内容识别）</template>
            </span>
            <span class="text-fine text-weak">总分/排名等汇总列已忽略</span>
          </div>

          <!-- 预览 -->
          <div class="scroll-thin mt-3 overflow-x-auto rounded-sm border border-hairline">
            <table class="w-full text-caption">
              <thead>
                <tr class="bg-parchment text-left">
                  <th
                    v-for="(header, i) in activeFile.table.headers"
                    :key="i"
                    class="whitespace-nowrap px-3 py-2 font-normal"
                    :class="
                      i === activeFile.selectedColumn
                        ? 'text-primary'
                        : activeFile.detection.subjects.some((s) => s.index === i)
                          ? 'text-ink'
                          : 'text-weak'
                    "
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
                    class="max-w-[160px] truncate whitespace-nowrap px-3 py-1.5"
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
          <p v-if="prepared" class="mt-1 text-fine text-muted">
            将导入 {{ prepared.rows.length }} 名学生的成绩<template v-if="prepared.issues.length">
              · {{ prepared.issues.length }} 行无法导入（{{ prepared.issues[0].reason }}等）</template
            >；档案中不存在的学生会自动建档。
          </p>
        </template>

        <!-- 导入结果：单文件沿用原样式；多文件展示聚合 + 逐文件明细 -->
        <div v-if="files.length <= 1 && activeFile?.result" class="mt-4 rounded-md bg-parchment p-3" data-test="score-import-result">
          <p class="text-caption font-medium text-ink">
            导入完成：写入 {{ activeFile.result.scores_written }} 条成绩 · 匹配已有学生
            {{ activeFile.result.students_matched }} 人 · 自动建档 {{ activeFile.result.students_created }} 人 · 跳过
            {{ activeFile.result.skipped.length }} · 失败 {{ activeFile.result.failed.length }}
          </p>
          <ul
            v-if="activeFile.result.skipped.length || activeFile.result.failed.length"
            class="mt-1.5 space-y-0.5 text-fine text-weak"
          >
            <li v-for="(s, i) in activeFile.result.skipped.slice(0, 5)" :key="`s${i}`">{{ s.name }}：{{ s.reason }}</li>
            <li v-for="(f, i) in activeFile.result.failed.slice(0, 5)" :key="`f${i}`">{{ f.name }}：{{ f.reason }}</li>
          </ul>
        </div>
        <div v-if="files.length > 1 && aggregated" class="mt-4 rounded-md bg-parchment p-3" data-test="score-import-result">
          <p class="text-caption font-medium text-ink">
            批量导入完成（{{ aggregated.count }}/{{ files.length }} 个文件）：写入 {{ aggregated.written }} 条成绩 ·
            匹配 {{ aggregated.matched }} 人 · 自动建档 {{ aggregated.created }} 人 · 跳过 {{ aggregated.skipped }} ·
            失败 {{ aggregated.failed }}
          </p>
          <ul class="mt-1.5 space-y-0.5 text-fine text-weak">
            <li v-for="f in files" :key="`r${f.key}`">
              {{ f.label || "未命名文件" }}：{{
                f.result
                  ? `考试「${f.examLabel}」· 写入 ${f.result.scores_written} 条`
                  : f.error || "未导入"
              }}
            </li>
          </ul>
        </div>
        </template>
      </div>
      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ aggregated ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" data-test="score-import-btn" @click="doImport">
          {{ importing ? "导入中…" : files.length > 1 ? `开始导入（${pendingCount} 个待导入）` : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
