import { reactive } from "vue";

/**
 * 家校沟通总结的两个「发起预设」（模块级单例，同 useToast 先例）：
 * - 单个学生 → 学生档案「家校沟通」页签（ParentSummaryPanel）：Agent 工具先写预设再跳转，
 *   页签面板挂载/页签激活时消费预设并自动开始生成
 * - 一键全班 → 班级层批量对话框（ParentSummaryBatchDialog，挂在 App.vue 全局唯一）
 * 这里只存「打开参数」，加载 / 生成 / 线程状态都在各组件内部。
 */

/** 时间范围预设（与 ReportRange 的选择口径一致，校验在组件内做） */
export interface ParentSummaryRangePreset {
  mode: "semester" | "custom";
  semester?: string;
  start?: string;
  end?: string;
}

/* ---------------- 班级层批量对话框 ---------------- */

interface BatchState {
  open: boolean;
  className: string;
  range: ParentSummaryRangePreset | null;
  autoStart: boolean;
  requirement: string;
  /** 打开序号：同一预设再次打开也能被对话框 watch 到 */
  seq: number;
}

const batch = reactive<BatchState>({
  open: false,
  className: "",
  range: null,
  autoStart: false,
  requirement: "",
  seq: 0,
});

export function useParentSummaryBatch(): BatchState {
  return batch;
}

/** 打开班级批量对话框（班级详情入口按钮 / Agent 工具） */
export function openParentSummaryBatch(preset: {
  className: string;
  range?: ParentSummaryRangePreset;
  autoStart?: boolean;
  requirement?: string;
}): void {
  batch.className = preset.className;
  batch.range = preset.range ?? null;
  batch.autoStart = preset.autoStart ?? false;
  batch.requirement = preset.requirement ?? "";
  batch.seq += 1;
  batch.open = true;
}

export function closeParentSummaryBatch(): void {
  batch.open = false;
}

/* ---------------- 学生档案「家校沟通」页签 ---------------- */

interface PanelState {
  /** 目标学生；null = 无待消费预设 */
  studentId: number | null;
  range: ParentSummaryRangePreset | null;
  autoStart: boolean;
  requirement: string;
  /** 预设序号：面板按它感知新预设（同一学生连续两次也能触发） */
  seq: number;
}

const panel = reactive<PanelState>({
  studentId: null,
  range: null,
  autoStart: false,
  requirement: "",
  seq: 0,
});

export function useParentSummaryPanel(): PanelState {
  return panel;
}

/** 发起单生生成（Agent 工具）：先写预设，再由工具跳转到学生档案 */
export function openParentSummaryPanel(preset: {
  studentId: number;
  range?: ParentSummaryRangePreset;
  autoStart?: boolean;
  requirement?: string;
}): void {
  panel.studentId = preset.studentId;
  panel.range = preset.range ?? null;
  panel.autoStart = preset.autoStart ?? false;
  panel.requirement = preset.requirement ?? "";
  panel.seq += 1;
}

/** 面板消费掉预设（防止再次进入该生档案时重复自动生成） */
export function consumeParentSummaryPanel(): void {
  panel.studentId = null;
  panel.range = null;
  panel.autoStart = false;
  panel.requirement = "";
}
