import { ref } from "vue";
import type { RouteLocationNormalized } from "vue-router";

/** 配置世界路由集合：命中即侧栏切换为「设置中心」形态（方案 B · 双世界，单一事实源） */
const CONFIG_ROUTES = new Set(["settings-center", "prompts", "recycle-bin", "settings"]);

export function isConfigRoute(name: unknown): boolean {
  return CONFIG_ROUTES.has(String(name ?? ""));
}

/** 教学世界的最近足迹：模块级单例——侧栏在首页 / 课堂模式不挂载，记录放在这里才不会丢 */
const lastBizPath = ref("");

/**
 * 「返回教学」的记忆：配置世界之外都算教学足迹（首页 / 课堂 / 班级详情 / 资料编辑在内），
 * 进入配置前在哪，返回就回哪；应用刚启动直进配置世界时无足迹，回落首页。
 */
export function useNavReturn() {
  /** 每次路由确认后调用：教学世界记录 fullPath（含参数与 query），配置世界跳过 */
  function track(to: RouteLocationNormalized) {
    if (!isConfigRoute(to.name)) lastBizPath.value = to.fullPath;
  }

  /** 返回教学的目标：有足迹回足迹，无足迹回落首页 */
  function returnTo(): string | { name: string } {
    return lastBizPath.value || { name: "home" };
  }

  return { track, returnTo };
}
