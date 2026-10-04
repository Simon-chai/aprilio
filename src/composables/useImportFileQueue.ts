/**
 * 多文件导入对话框共用的队列状态机（拆分自 ImportRosterDialog / ImportScoreDialog）：
 * files / activeKey / analyzing / importing / readError 五件套 + 增删与文件选择。
 *
 * 各对话框的识别逻辑（花名册姓名列 / 成绩单识别 / 模板校验）经 analyzeEntry 钩子注入，
 * 打开重置时对话框自有状态（导入模式 / 班级候选）经 onReset 钩子清理；
 * 条目的字段形状由 createEntry 决定，本队列只关心 key 与增删。
 */
import { computed, ref, watch, type Ref } from "vue";
// ^ Ref 类型同时用于 files 的显式标注
import { isTauri } from "../lib/env";
import { errorMessage } from "../lib/error-message";
import { pickFilesViaInput, TEXT_TABLE_ACCEPT } from "../lib/file-pick";
import { decodeRosterBytes, parseRosterTable, pickRosterFiles, type RosterTable } from "../lib/roster";

export interface ImportFileQueueOptions<E> {
  /** 对话框开关（false → true 时清空队列并触发 onReset） */
  open: Ref<boolean>;
  /** 构造新队列条目（key 由队列分配，调用方填各自字段并置初始值） */
  createEntry: (key: number, table: RosterTable, label: string, sheet: string) => E;
  /** 单文件识别钩子：进入前自行清理上一轮识别字段；analyzing 由队列统一维护 */
  analyzeEntry: (entry: E) => Promise<void>;
  /** 打开重置时的额外清理（对话框自有状态） */
  onReset?: () => void;
  /** 每次入队前的异步准备（如成绩导入先备好班级候选） */
  beforeAdd?: () => Promise<void>;
  /** 浏览器演示态文件选择的 accept 串（缺省纯文本表格；成绩导入多收 xlsx/xls） */
  pickAccept?: string;
}

export function useImportFileQueue<E extends { key: number }>(options: ImportFileQueueOptions<E>) {
  // 显式 Ref<E[]>：ref 的深层解包（UnwrapRefSimple）与泛型条目类型不兼容
  const files = ref([]) as Ref<E[]>;
  const activeKey = ref<number | null>(null);
  const nextKey = ref(1);
  const analyzing = ref(false);
  const importing = ref(false);
  const readError = ref("");

  const activeFile = computed<E | null>(
    () => files.value.find((f) => f.key === activeKey.value) ?? files.value[0] ?? null,
  );

  watch(options.open, (open) => {
    if (!open) return;
    files.value = [];
    activeKey.value = null;
    importing.value = false;
    analyzing.value = false;
    readError.value = "";
    options.onReset?.();
  });

  /** 统一维护 analyzing 的单文件识别入口（模式切换重分析 / 新增文件共用） */
  async function runAnalyze(entry: E) {
    analyzing.value = true;
    try {
      await options.analyzeEntry(entry);
    } finally {
      analyzing.value = false;
    }
  }

  /** 新增一个已解析表格到队列并分析 */
  async function addTable(table: RosterTable, label: string, sheet = "") {
    if (options.beforeAdd) await options.beforeAdd();
    const entry = options.createEntry(nextKey.value++, table, label, sheet);
    files.value.push(entry);
    activeKey.value = entry.key;
    await runAnalyze(entry);
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
      readError.value = `解析失败：${errorMessage(e)}`;
    }
  }

  /** 兼容旧暴露接口：重新分析当前选中的文件 */
  async function analyzeFromTable() {
    if (activeFile.value) await runAnalyze(activeFile.value);
  }

  function removeFile(key: number) {
    const i = files.value.findIndex((f) => f.key === key);
    if (i >= 0) files.value.splice(i, 1);
    if (activeKey.value === key) activeKey.value = files.value[0]?.key ?? null;
  }

  /** 选文件并入队：桌面端走花名册管道的表格抽取，浏览器演示态逐个解析文本 */
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
        readError.value = `读取文件失败：${errorMessage(e)}`;
      }
      return;
    }
    const picked = await pickFilesViaInput(options.pickAccept ?? TEXT_TABLE_ACCEPT);
    const failures: string[] = [];
    for (const file of picked) {
      try {
        const text = decodeRosterBytes(await file.arrayBuffer()).text;
        await addTable(parseRosterTable(text), file.name);
      } catch (e) {
        failures.push(`${file.name}：${errorMessage(e)}`);
      }
    }
    if (failures.length) readError.value = `部分文件解析失败：${failures.join("；")}`;
  }

  return {
    files,
    activeKey,
    analyzing,
    importing,
    readError,
    activeFile,
    runAnalyze,
    addTable,
    loadTable,
    loadText,
    analyzeFromTable,
    removeFile,
    chooseFile,
  };
}
