<script setup lang="ts">
/**
 * 导入成绩对话框：把一份成绩单导入为一次考试批次（考试名 + 考试时间 + 各科成绩）。
 *
 * 与 Agent 工具 import_score_sheet 共用 src/lib/scores.ts 的核心管道：
 * 成绩单识别（姓名列 + 科目列，规则 + 可选 AI）→ 考试名/时间提取（可手动改）
 * → 行校验 → 考试批次幂等复用 → 成绩落库（缺失学生自动建档）。
 * 从「导入花名册」检测到成绩单时，可由父视图携带已解析表格交接进来。
 */
import { computed, ref, watch } from "vue";
import AppButton from "./ui/AppButton.vue";
import AnalyzingOverlay from "./AnalyzingOverlay.vue";
import { isTauri } from "../lib/db";
import { isAiConfigured, loadAiConfig } from "../lib/ai";
import { createLlm } from "../agent/providers";
import { logError, logInfo } from "../lib/logger";
import { localDateStr } from "../lib/format";
import { decodeRosterBytes, parseRosterTable, pickRosterFile, type RosterTable } from "../lib/roster";
import {
  aiDetectScoreSheet,
  combineScoreDetection,
  detectScoreSheet,
  prepareScoreRows,
  runSmartScoreImport,
  type ScoreImportResult,
  type ScoreSheetDetection,
} from "../lib/scores";

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
  /** 导入完成：带成绩归属班级（presetClass 或考试批次班级），父视图负责关闭与跳转 */
  imported: [payload: { className: string | null }];
}>();

const fileLabel = ref("");
const sheetLabel = ref("");
const table = ref<RosterTable | null>(null);
const analyzing = ref(false);
const detection = ref<ScoreSheetDetection | null>(null);
const notScoreSheet = ref(false);
const selectedColumn = ref(-1);
const examName = ref("");
const examDate = ref("");
const importing = ref(false);
const result = ref<ScoreImportResult | null>(null);
const error = ref("");

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    fileLabel.value = props.initialFileName;
    sheetLabel.value = "";
    table.value = null;
    detection.value = null;
    notScoreSheet.value = false;
    selectedColumn.value = -1;
    examName.value = "";
    examDate.value = localDateStr();
    importing.value = false;
    result.value = null;
    error.value = "";
    if (props.initialTable) {
      void loadTable({ table: props.initialTable }, props.initialFileName);
    }
  },
);

/** 载入已解析的表格并分析（文件入口 / 花名册对话框交接共用） */
async function loadTable(loaded: { table: RosterTable; sheet?: string }, label: string) {
  fileLabel.value = label;
  sheetLabel.value = loaded.sheet ?? "";
  table.value = loaded.table;
  await analyzeFromTable();
}

/** 解析文本为表格并分析（CSV 文本入口，浏览器演示态与测试使用） */
async function loadText(text: string, label = "") {
  fileLabel.value = label;
  sheetLabel.value = "";
  try {
    table.value = parseRosterTable(text);
  } catch (e) {
    table.value = null;
    error.value = `解析失败：${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  await analyzeFromTable();
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
    input.accept = ".csv,.tsv,.txt,.xlsx,.xls,text/csv,text/plain";
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

/** 对当前表格做成绩单识别（表格已就绪，解析在载入时完成） */
async function analyzeFromTable() {
  if (!table.value) return;
  analyzing.value = true;
  detection.value = null;
  notScoreSheet.value = false;
  result.value = null;
  error.value = "";
  selectedColumn.value = -1;

  const t = table.value;
  let rule = detectScoreSheet(t, { fileName: fileLabel.value });
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
    notScoreSheet.value = true;
    analyzing.value = false;
    return;
  }

  detection.value = rule;
  selectedColumn.value = rule.nameColumn;
  examName.value = rule.examName ?? "";
  examDate.value = rule.examDate ?? localDateStr();
  analyzing.value = false;
}

/** 手动改姓名列：只覆盖识别结果里的姓名列，科目列保持不变 */
function onNameColumnChange() {
  if (detection.value && selectedColumn.value >= 0) {
    detection.value = { ...detection.value, nameColumn: selectedColumn.value };
  }
}

const effectiveDetection = computed(() =>
  detection.value && selectedColumn.value >= 0
    ? { ...detection.value, nameColumn: selectedColumn.value }
    : detection.value,
);

const prepared = computed(() =>
  table.value && effectiveDetection.value && effectiveDetection.value.nameColumn >= 0
    ? prepareScoreRows(table.value, effectiveDetection.value)
    : null,
);

const canImport = computed(
  () =>
    !!table.value &&
    !!effectiveDetection.value &&
    effectiveDetection.value.nameColumn >= 0 &&
    !!prepared.value &&
    prepared.value.rows.length > 0 &&
    !notScoreSheet.value &&
    !analyzing.value &&
    !importing.value &&
    !!examName.value.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(examDate.value),
);

const previewRows = computed(() => table.value?.rows.slice(0, 5) ?? []);

function colLabel(index: number): string {
  const header = table.value?.headers[index] ?? "";
  return `第${index + 1}列${header ? `「${header}」` : ""}`;
}

const confidenceLabel = computed(() => {
  const c = detection.value?.confidence;
  return c === "high" ? "高" : c === "medium" ? "中" : "低";
});

async function doImport() {
  if (!canImport.value || !table.value) return;
  importing.value = true;
  error.value = "";
  try {
    const outcome = await runSmartScoreImport(table.value, {
      className: props.presetClass || undefined,
      examName: examName.value.trim() || undefined,
      examDate: examDate.value || undefined,
      // options.nameColumn 口径是「从 1 起的列号」（与 Agent 工具、报错提示一致）；
      // 对话框内部 selectedColumn 是 0 起下标——直接传会把第一列（姓名）判成找不到
      nameColumn: selectedColumn.value >= 0 ? selectedColumn.value + 1 : undefined,
      fileName: fileLabel.value || undefined,
    });
    if (outcome.status === "ok") {
      if (!outcome.result) {
        error.value = "导入流程异常：缺少导入结果。";
        return;
      }
      result.value = outcome.result;
      logInfo(
        `成绩导入完成：考试「${outcome.exam.name}」(${outcome.exam.exam_date})，成绩 ${outcome.result.scores_written} 条，` +
          `匹配 ${outcome.result.students_matched} 人，建档 ${outcome.result.students_created} 人，` +
          `跳过 ${outcome.result.skipped.length}，失败 ${outcome.result.failed.length}`,
      );
      emit("imported", { className: props.presetClass || outcome.exam.class_name || null });
    } else {
      // not-score-sheet / need-column / error 都带 message
      error.value = outcome.message;
    }
  } catch (e) {
    logError("成绩导入失败", e);
    error.value = `导入失败：${e instanceof Error ? e.message : String(e)}`;
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
          选择一份成绩单（XLSX / XLS / CSV / TSV / TXT，浏览器演示态仅 CSV）：自动识别姓名列与科目列，
          从标题行提取考试名与考试时间；同一班级同考试名同时间只保留一个批次，重复导入仅更新成绩。
        </p>

        <!-- 文件选择 -->
        <div class="mt-4 flex items-center gap-3">
          <AppButton variant="secondary" @click="chooseFile">选择文件</AppButton>
          <span class="min-w-0 flex-1 truncate text-caption text-weak">
            {{ fileLabel || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV）" }}
          </span>
        </div>

        <p v-if="error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ error }}</p>
        <p
          v-if="notScoreSheet"
          class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger"
        >
          这张表格不像成绩单：没有识别到科目成绩列。若要导入学生花名册，请使用「导入花名册」。
        </p>

        <!-- 解析结果 -->
        <template v-if="table && !error && detection">
          <p class="mt-4 text-caption text-muted">
            共 {{ table.rows.length }} 行数据 ·
            {{ table.hasHeader ? "已识别表头" : "未识别表头（首行按数据处理）" }}
            <template v-if="sheetLabel"> · 工作表「{{ sheetLabel }}」</template>
          </p>

          <!-- 考试批次信息 -->
          <div class="mt-3 rounded-md bg-parchment p-3">
            <div class="flex flex-wrap items-end gap-3">
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">考试名</span>
                <input
                  v-model="examName"
                  data-test="exam-name-input"
                  class="h-8 w-44 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                  placeholder="如：期中考试"
                />
              </label>
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">考试时间</span>
                <!-- 原生日期选择器：点击日历图标即可选日期，无需手敲 YYYY-MM-DD -->
                <input
                  v-model="examDate"
                  data-test="exam-date-input"
                  type="date"
                  class="h-8 w-36 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                />
              </label>
              <span v-if="props.presetClass" class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted">
                班级 {{ props.presetClass }}
              </span>
              <span
                v-if="examName || detection.examName"
                class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted"
              >
                {{ detection.examName ? "考试名提取自标题行" : "考试名手动填写" }}
                · 置信度{{ confidenceLabel }}
              </span>
            </div>
            <p v-if="detection.confidence === 'low'" class="mt-2 text-fine text-danger">
              未能可靠识别姓名列，请在下方人工选择；科目列与考试信息也建议核对。
            </p>
          </div>

          <!-- 姓名列与科目列 -->
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <label class="flex items-center gap-2">
              <span class="text-caption text-ink">姓名列</span>
              <select
                v-model="selectedColumn"
                data-test="name-column-select"
                class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                @change="onNameColumnChange"
              >
                <option :value="-1" disabled>请选择姓名列</option>
                <option v-for="(header, i) in table.headers" :key="i" :value="i">
                  第{{ i + 1 }}列{{ table.hasHeader ? ' ' + header : '' }}
                </option>
              </select>
            </label>
            <span
              v-for="subj in detection.subjects"
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
                    v-for="(header, i) in table.headers"
                    :key="i"
                    class="whitespace-nowrap px-3 py-2 font-normal"
                    :class="
                      i === selectedColumn
                        ? 'text-primary'
                        : detection.subjects.some((s) => s.index === i)
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
                    v-for="(_, ci) in table.headers"
                    :key="ci"
                    class="max-w-[160px] truncate whitespace-nowrap px-3 py-1.5"
                    :class="ci === selectedColumn ? 'bg-primary-soft font-medium text-ink' : 'text-muted'"
                    :title="row[ci] ?? ''"
                  >
                    {{ row[ci] ?? "" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="table.rows.length > 5" class="mt-1 text-fine text-weak">
            仅预览前 5 行，共 {{ table.rows.length }} 行。
          </p>
          <p v-if="prepared" class="mt-1 text-fine text-muted">
            将导入 {{ prepared.rows.length }} 名学生的成绩<template v-if="prepared.issues.length">
              · {{ prepared.issues.length }} 行无法导入（{{ prepared.issues[0].reason }}等）</template
            >；档案中不存在的学生会自动建档。
          </p>
        </template>

        <!-- 导入结果 -->
        <div v-if="result" class="mt-4 rounded-md bg-parchment p-3" data-test="score-import-result">
          <p class="text-caption font-medium text-ink">
            导入完成：写入 {{ result.scores_written }} 条成绩 · 匹配已有学生
            {{ result.students_matched }} 人 · 自动建档 {{ result.students_created }} 人 · 跳过
            {{ result.skipped.length }} · 失败 {{ result.failed.length }}
          </p>
          <ul
            v-if="result.skipped.length || result.failed.length"
            class="mt-1.5 space-y-0.5 text-fine text-weak"
          >
            <li v-for="(s, i) in result.skipped.slice(0, 5)" :key="`s${i}`">{{ s.name }}：{{ s.reason }}</li>
            <li v-for="(f, i) in result.failed.slice(0, 5)" :key="`f${i}`">{{ f.name }}：{{ f.reason }}</li>
          </ul>
        </div>
        </template>
      </div>
      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ result ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" data-test="score-import-btn" @click="doImport">
          {{ importing ? "导入中…" : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
