/**
 * 活动注册表 —— 「放文件即接入」的装配入口（同构 src/agent/manifest.ts 的 tools/page-actions 先例）：
 * - src/classroom/activities/*.activity.ts  default export 一个 LessonActivityDef 产物
 * - import.meta.glob 构建期扫描、启动期注册（dev 下新文件热更新即被感知）
 * - 重复 type 启动即报错（fail-fast，对齐容器启动对账惯例）
 */
import type { ActivitySetEntry, LessonActivityDef, LessonActivityEntry } from "./types";

const activityModules = import.meta.glob<LessonActivityDef>("./activities/*.activity.ts", {
  import: "default",
  eager: true,
});

/** activities/ 扫描产物（default export 且形如活动定义的模块） */
export function scanActivities(): LessonActivityDef<unknown>[] {
  return Object.values(activityModules).filter(
    (m): m is LessonActivityDef<unknown> =>
      !!m && typeof m === "object" && "type" in m && "reduce" in m && "component" in m,
  );
}

/** 按 type 建注册表；重复 type 直接抛错（新活动接入时立刻暴露冲突） */
export function createActivityRegistry(
  defs: LessonActivityDef<unknown>[],
): Map<string, LessonActivityDef<unknown>> {
  const map = new Map<string, LessonActivityDef<unknown>>();
  for (const def of defs) {
    const type = def.type.trim();
    if (!type) throw new Error("活动定义的 type 不能为空");
    if (map.has(type)) throw new Error(`活动 type 重复注册：${type}`);
    map.set(type, def);
  }
  return map;
}

let registry: Map<string, LessonActivityDef<unknown>> | null = null;

/** 全局注册表（懒装配单例；测试可传 defs 覆盖） */
export function getActivityRegistry(): Map<string, LessonActivityDef<unknown>> {
  if (!registry) registry = createActivityRegistry(scanActivities());
  return registry;
}

/**
 * 把会话快照（activity_set_json）解析成可渲染的活动条目。
 * 未注册的 type（教师配置了未安装的活动）→ 跳过并回报，不阻断开课
 * （对齐「未知工具不崩溃」的兜底哲学）。
 */
export function resolveActivityEntries(
  entries: ActivitySetEntry[],
  defs: Map<string, LessonActivityDef<unknown>> = getActivityRegistry(),
): { activities: LessonActivityEntry[]; skipped: string[] } {
  const activities: LessonActivityEntry[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const def = defs.get(entry.type);
    if (!def) {
      skipped.push(entry.type);
      continue;
    }
    activities.push({ def, config: entry.config ?? {} });
  }
  return { activities, skipped };
}