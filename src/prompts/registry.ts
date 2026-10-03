/**
 * 提示词模块注册表 —— 「放文件即接入」的装配入口
 * （同构 src/agent/manifest.ts 的 tools/ 与 src/classroom/registry.ts 的 activities/ 先例）。
 *
 * - src/prompts/modules/*.prompt.ts  default export 一个 definePromptModule() 产物
 * - import.meta.glob 构建期扫描、启动期建索引（dev 下新文件热更新即被感知）
 * - 重复 id 启动即抛错（fail-fast，对齐能力容器「重复注册立即报错」的惯例）
 */
import type { PromptModule } from "./types";
import { PROMPT_GROUPS, PROMPT_GROUP_FALLBACK, type PromptGroup } from "./groups";

const moduleFiles = import.meta.glob<PromptModule>("./modules/*.prompt.ts", {
  import: "default",
  eager: true,
});

/** modules/ 扫描产物（default export 且形如提示词模块的条目） */
export function scanPromptModules(): PromptModule[] {
  return Object.values(moduleFiles).filter(
    (m): m is PromptModule =>
      !!m && typeof m === "object" && "id" in m && "defaultText" in m && "group" in m,
  );
}

/** 按 id 建索引；重复 id 直接抛错（新增模块时立刻暴露冲突） */
export function createPromptRegistry(modules: PromptModule[]): Map<string, PromptModule> {
  const map = new Map<string, PromptModule>();
  for (const mod of modules) {
    const id = mod.id.trim();
    if (!id) throw new Error("提示词模块的 id 不能为空");
    if (map.has(id)) throw new Error(`提示词模块 id 重复注册：${id}`);
    map.set(id, mod);
  }
  return map;
}

let registry: Map<string, PromptModule> | null = null;

/** 全局注册表（懒装配单例；测试可传 modules 覆盖） */
export function getPromptRegistry(): Map<string, PromptModule> {
  if (!registry) registry = createPromptRegistry(scanPromptModules());
  return registry;
}

/** 全部模块，按「分组顺序 → 分组内 label」稳定排序（管理页与列表共用） */
export function listPromptModules(
  modules: Map<string, PromptModule> = getPromptRegistry(),
): PromptModule[] {
  const order = new Map(PROMPT_GROUPS.map((g, i) => [g.id, i]));
  return [...modules.values()].sort((a, b) => {
    const ga = order.get(a.group) ?? PROMPT_GROUPS.length;
    const gb = order.get(b.group) ?? PROMPT_GROUPS.length;
    return ga - gb || a.label.localeCompare(b.label, "zh-Hans-CN") || a.id.localeCompare(b.id);
  });
}

/** 一个分组连同它的模块（管理页左侧列表的结构） */
export interface PromptGroupBucket {
  group: PromptGroup;
  modules: PromptModule[];
}

/**
 * 按分组聚合模块，供管理页渲染。
 * 未在 groups.ts 登记过的 group 归入「其他」兜底分组——模块不会因为漏登记而消失。
 */
export function bucketPromptModules(
  modules: Map<string, PromptModule> = getPromptRegistry(),
): PromptGroupBucket[] {
  const known = new Map(PROMPT_GROUPS.map((g) => [g.id, g]));
  const buckets = new Map<string, PromptGroupBucket>();
  for (const g of PROMPT_GROUPS) buckets.set(g.id, { group: g, modules: [] });
  buckets.set(PROMPT_GROUP_FALLBACK.id, { group: PROMPT_GROUP_FALLBACK, modules: [] });

  for (const mod of listPromptModules(modules)) {
    const group = known.get(mod.group) ?? PROMPT_GROUP_FALLBACK;
    buckets.get(group.id)!.modules.push(mod);
  }

  return [...buckets.values()].filter((b) => b.modules.length > 0);
}

/** 取单个模块；不存在返回 undefined（调用方决定如何兜底） */
export function getPromptModule(
  id: string,
  modules: Map<string, PromptModule> = getPromptRegistry(),
): PromptModule | undefined {
  return modules.get(id);
}
