<script setup lang="ts">
/**
 * 导入花名册对话框：指定格式导入 / 智能导入两种模式。
 *
 * 与 Agent 工具 import_student_roster 共用 src/lib/roster.ts 的核心管道：
 * 解析 → 姓名列识别（规则 + 可选 AI）→ 字段映射 → 行校验 → 落库。
 * 智能导入模式会展示识别结果（方式、置信度、理由），置信度低时要求人工选择姓名列。
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
  parseRosterTable,
  pickRosterFile,
  prepareRosterRows,
  validateTemplateTable,
  type NameDetection,
  type RosterField,
  type RosterImportResult,
  type RosterTable,
} from "../lib/roster";
import { detectScoreSheet, type ScoreSheetDetection } from "../lib/scores";

type Mode = "smart" | "template";

const props = withDefaults(
  defineProps<{ open: boolean; initialMode?: Mode; presetClass?: string }>(),
  { initialMode: "smart" },
);
const emit = defineEmits<{
  close: [];
  /** 导入完成：带结果与可跳转的目标班级（唯一时），父视图负责关闭对话框与跳转 */
  imported: [payload: { result: RosterImportResult; targetClass: string | null }];
  /** 检测到成绩单且用户选择转入成绩导入：把已解析表格交给父视图打开「导入成绩」 */
  "switch-to-scores": [payload: { table: RosterTable; fileName: string }];
}>();

const mode = ref<Mode>(props.initialMode);
const fileLabel = ref("");
const sheetLabel = ref("");
const table = ref<RosterTable | null>(null);
const analyzing = ref(false);
const detection = ref<NameDetection | null>(null);
const templateError = ref("");
const selectedColumn = ref(-1);
const importing = ref(false);
const result = ref<RosterImportResult | null>(null);
const error = ref("");
/** 成绩单检测：花名册入口最常见的起点就是一份成绩单，提示可一键转成绩导入 */
const scoreSheetHint = ref<ScoreSheetDetection | null>(null);
const scoreHintDismissed = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    mode.value = props.initialMode;
    fileLabel.value = "";
    sheetLabel.value = "";
    table.value = null;
    detection.value = null;
    templateError.value = "";
    selectedColumn.value = -1;
    importing.value = false;
    result.value = null;
    error.value = "";
    scoreSheetHint.value = null;
    scoreHintDismissed.value = false;
  },
);

watch(mode, () => {
  if (table.value) void analyzeFromTable();
});

/** 载入已解析的表格并分析（文件入口，桌面端表格通道 / 测试注入共用） */
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

const mapping = computed(() =>
  table.value && selectedColumn.value >= 0
    ? detectFieldMapping(table.value, selectedColumn.value)
    : null,
);

const prepared = computed(() => {
  if (!table.value || !mapping.value) return null;
  const prep = prepareRosterRows(table.value, mapping.value);
  if (props.presetClass) {
    return {
      ...prep,
      rows: prep.rows.map((r: any) => {
        if (r.input) {
          return {
            ...r,
            input: {
              ...r.input,
              grade_class: r.input.grade_class || props.presetClass,
            },
          };
        }
        return {
          ...r,
          grade_class: r.grade_class || props.presetClass,
        };
      }),
    };
  }
  return prep;
});

const canImport = computed(
  () =>
    !!prepared.value &&
    prepared.value.rows.length > 0 &&
    !templateError.value &&
    !analyzing.value &&
    !importing.value,
);

const previewRows = computed(() => table.value?.rows.slice(0, 5) ?? []);

function colLabel(index: number): string {
  const header = table.value?.headers[index] ?? "";
  return `第${index + 1}列${header ? `「${header}」` : ""}`;
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
  const c = detection.value?.confidence;
  return c === "high" ? "高" : c === "medium" ? "中" : "低";
});

/** 对当前表格做姓名列识别 / 模板校验（表格已就绪，解析在载入时完成） */
async function analyzeFromTable() {
  if (!table.value) return;
  analyzing.value = true;
  templateError.value = "";
  detection.value = null;
  result.value = null;
  error.value = "";
  selectedColumn.value = -1;
  scoreSheetHint.value = null;
  scoreHintDismissed.value = false;

  const t = table.value;
  if (mode.value === "template") {
    const check = validateTemplateTable(t);
    if (!check.ok) {
      templateError.value = `这不是标准模板表格：缺少「${check.missing.join("、")}」列。请下载模板填写后重试，或改用智能导入。`;
    }
    selectedColumn.value = findNameColumnByHeader(t);
    analyzing.value = false;
    return;
  }

  // 成绩单检测（仅智能导入模式）：识别到科目成绩列时提示可转入成绩导入
  if (mode.value === "smart") {
    scoreSheetHint.value = detectScoreSheet(t, { fileName: fileLabel.value });
  }

  const rule = detectNameColumn(t);
  detection.value = rule;
  selectedColumn.value = rule.selected;

  // 已配置 AI 模型时叠加模型识别（失败/不可用自动回退规则结果）
  const config = loadAiConfig();
  if (isAiConfigured(config)) {
    try {
      const ai = await aiDetectNameColumn(t, createLlm(), config);
      if (ai) {
        detection.value = combineNameDetection(rule, ai);
        selectedColumn.value = detection.value.selected;
      }
    } catch {
      /* 保留规则识别结果 */
    }
  }
  analyzing.value = false;
}

/** 从映射后的行推断导入目标班级：全部行同一班级时返回该班级名，否则 null */
function inferTargetClass(): string | null {
  if (props.presetClass) return props.presetClass;
  const classes = new Set<string>();
  for (const row of prepared.value?.rows ?? []) {
    const gc = (row.input?.grade_class ?? row.grade_class ?? "") as string;
    if (gc) classes.add(gc);
  }
  return classes.size === 1 ? ([...classes][0] ?? null) : null;
}

async function doImport() {
  if (!prepared.value || importing.value) return;
  importing.value = true;
  error.value = "";
  try {
    result.value = await importRosterStudents(prepared.value);
    logInfo(
      `花名册导入完成：成功 ${result.value.imported}，更新 ${result.value.updated}，跳过 ${result.value.skipped.length}，失败 ${result.value.failed.length}`,
    );
    emit("imported", { result: result.value, targetClass: inferTargetClass() });
  } catch (e) {
    logError("花名册导入失败", e);
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
            {{ fileLabel || "支持 XLSX / XLS / CSV / TSV / TXT（浏览器演示态仅 CSV）" }}
          </span>
        </div>

        <p v-if="error" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">{{ error }}</p>
        <p v-if="templateError" class="mt-4 rounded-md bg-[#fdeef0] p-3 text-caption text-danger">
          {{ templateError }}
        </p>

        <!-- 成绩单提示：转入成绩导入，或继续按花名册导入 -->
        <div
          v-if="scoreSheetHint && !scoreHintDismissed && mode === 'smart'"
          data-test="score-sheet-banner"
          class="mt-4 rounded-md bg-primary-soft p-3"
        >
          <p class="text-caption text-ink">
            这更像一份<b>成绩单</b>（识别到科目列：{{
              scoreSheetHint.subjects.map((s) => s.name).join("、")
            }}）。转为成绩导入会自动创建一次考试，并把成绩关联到学生档案。
          </p>
          <div class="mt-2 flex items-center gap-3">
            <AppButton
              variant="primary"
              data-test="switch-to-scores-btn"
              @click="
                emit('switch-to-scores', {
                  table: table!,
                  fileName: fileLabel,
                })
              "
            >
              转为成绩导入
            </AppButton>
            <button
              type="button"
              class="text-caption text-weak hover:text-ink"
              @click="scoreHintDismissed = true"
            >
              仍按花名册导入
            </button>
          </div>
        </div>

        <!-- 解析结果 -->
        <template v-if="table && !error">
          <p class="mt-4 text-caption text-muted">
            共 {{ table.rows.length }} 行数据 ·
            {{ table.hasHeader ? "已识别表头" : "未识别表头（首行按数据处理）" }}
            <template v-if="sheetLabel"> · 工作表「{{ sheetLabel }}」</template>
          </p>

          <!-- 姓名列识别（智能导入） -->
          <div v-if="mode === 'smart'" class="mt-3 rounded-md bg-parchment p-3">
            <div class="flex flex-wrap items-center gap-3">
              <label class="flex items-center gap-2">
                <span class="text-caption text-ink">姓名列</span>
                <select
                  v-model="selectedColumn"
                  class="h-8 rounded-sm border border-hairline bg-canvas px-2 text-caption text-ink outline-none focus:border-primary-focus"
                >
                  <option :value="-1" disabled>请选择姓名列</option>
                  <option v-for="(header, i) in table.headers" :key="i" :value="i">
                    第{{ i + 1 }}列{{ table.hasHeader ? ' ' + header : '' }}
                  </option>
                </select>
              </label>
              <span
                v-if="detection && selectedColumn >= 0"
                class="rounded-sm bg-canvas px-2 py-1 text-fine text-muted"
              >
                {{ detection.method === "ai" ? "AI 识别" : "规则识别" }} · 置信度{{ confidenceLabel }}
                <template v-if="detection.reason">· {{ detection.reason }}</template>
              </span>
            </div>
            <p
              v-if="detection && detection.confidence === 'low'"
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

          <!-- 预览 -->
          <div class="scroll-thin mt-3 overflow-x-auto rounded-sm border border-hairline">
            <table class="w-full text-caption">
              <thead>
                <tr class="bg-parchment text-left">
                  <th
                    v-for="(header, i) in table.headers"
                    :key="i"
                    class="whitespace-nowrap px-3 py-2 font-normal"
                    :class="i === selectedColumn ? 'text-primary' : 'text-weak'"
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
                    class="max-w-[180px] truncate whitespace-nowrap px-3 py-1.5"
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
          <p v-if="prepared && prepared.issues.length" class="mt-1 text-fine text-muted">
            {{ prepared.issues.length }} 行无法导入（姓名缺失或表内学号重复），导入时将跳过。
          </p>
        </template>

        <!-- 导入结果 -->
        <div v-if="result" class="mt-4 rounded-md bg-parchment p-3">
          <p class="text-caption font-medium text-ink">
            导入完成：成功 {{ result.imported }} · 更新 {{ result.updated }} · 跳过
            {{ result.skipped.length }} · 失败 {{ result.failed.length }}
          </p>
          <ul
            v-if="result.skipped.length || result.failed.length"
            class="mt-1.5 space-y-0.5 text-fine text-weak"
          >
            <li v-for="(s, i) in result.skipped.slice(0, 5)" :key="`s${i}`">{{ s.name }}：{{ s.reason }}</li>
            <li v-for="(f, i) in result.failed.slice(0, 5)" :key="`f${i}`">
              第{{ f.row || "—" }}行 {{ f.name || "空姓名" }}：{{ f.reason }}
            </li>
          </ul>
          <p v-if="!result.failed.length" class="mt-1 text-fine text-weak">
            正在返回班级详情，无需其他操作…
          </p>
        </div>
        </template>
      </div>

      <div class="mt-5 flex shrink-0 items-center justify-end gap-3">
        <AppButton variant="pearl" @click="emit('close')">{{ result ? "关闭" : "取消" }}</AppButton>
        <AppButton :disabled="!canImport" @click="doImport">
          {{ importing ? "导入中…" : "开始导入" }}
        </AppButton>
      </div>
    </div>
  </div>
</template>
