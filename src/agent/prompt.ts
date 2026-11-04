/**
 * system prompt 构造：告诉模型自己的角色、当前页面与工具使用准则。
 * 工具的参数 schema 由 tools 字段单独传输，这里只写行为准则。
 *
 * 正文本身来自提示词模块 `assistant.agent`（可在「提示词管理」页调整），
 * 本函数只负责**注入运行期变量**（页面上下文、用户记忆与补充设定）——
 * 因此改提示词不需要改代码，改代码也不会覆盖用户的自定义。
 *
 * 当前页面优先取视图上报的上下文快照（page-context-bus）：快照带标题、
 * 路由参数与渲染概况，「这个班」「当前页面」这类指代因此可解；
 * 视图未上报时回落到界面注册表的页面名。
 *
 * 用户记忆来自本机记忆文件（memory-store 的同步缓存，启动 / 每次写盘后刷新），
 * 把用户沉淀的叫法与偏好带给模型；还没有记忆时整行省略，零漂移不变。
 */
import { NAV_TARGETS } from "./tools/navigation";
import { getPageContext } from "./page-context-bus";
import { getCachedMemory, memoryForPrompt } from "./memory-store";
import { PROMPT_IDS, resolvePrompt } from "../prompts";

export function buildSystemPrompt(currentRouteName: string, extra?: string): string {
  const snapshot =
    typeof currentRouteName === "string" ? getPageContext(currentRouteName) : undefined;
  const fallback = NAV_TARGETS.find((t) => t.routeName === currentRouteName);
  const where = snapshot
    ? `「${snapshot.title}」（${snapshot.page}）`
    : fallback
      ? `「${fallback.label}」（${fallback.key}）`
      : currentRouteName || "未知页面";

  return resolvePrompt(PROMPT_IDS.agent, {
    当前页面: where,
    // 视图未上报时传空值，渲染时整行省略（与改造前「过滤空段」等价）
    页面概况: snapshot?.summary ?? "",
    // 记忆取同步缓存（应用启动与每次写盘时刷新）；无记忆时空值整行省略
    用户记忆: memoryForPrompt(getCachedMemory()),
    补充设定: extra?.trim() ?? "",
  });
}
