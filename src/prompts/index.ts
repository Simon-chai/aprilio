/**
 * 系统提示词统一管理（详见 docs/PROMPT_MANAGEMENT.md）。
 *
 * 对业务代码只暴露两件事：`resolvePrompt(id, vars)` 取系统提示词、
 * `PROMPT_IDS` 拿到模块 id 常量；其余（扫描装载 / 覆盖存储 / 渲染）
 * 都是管理页与测试的入口。
 */
export { definePromptModule } from "./define";
export { PROMPT_GROUPS, type PromptGroup } from "./groups";
export {
  bucketPromptModules,
  createPromptRegistry,
  getPromptModule,
  getPromptRegistry,
  listPromptModules,
  scanPromptModules,
  type PromptGroupBucket,
} from "./registry";
export {
  customizedPromptIds,
  loadPromptOverride,
  loadPromptOverrides,
  promptVersion,
  resetAllPromptOverrides,
  resetPromptOverride,
  sanitizePromptState,
  savePromptOverride,
} from "./store";
export {
  effectivePromptText,
  missingContractVariables,
  promptPreview,
  renderPromptText,
  resolvePrompt,
  unknownPlaceholders,
  type PromptOverrideMap,
} from "./resolve";
export { PROMPT_IDS } from "./ids";
export type { PromptModule, PromptOverride, PromptStoreState, PromptVariable } from "./types";
