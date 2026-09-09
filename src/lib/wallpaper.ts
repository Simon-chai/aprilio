/**
 * 必应壁纸入库（手动）：设置页点「拉取必应壁纸」把近期壁纸存进本机图库。
 *
 * - 不做任何自动更新：背景图一律由用户在选图弹窗里自行挑用；
 * - 首页大图与课表背景共享图库，拉进来的壁纸两边都能选；
 * - 图库按 origin_url 去重，重复拉取只刷新使用时间，不重复下载；
 * - Bing 官方接口一次最多 8 张（最近 8 天），张数在设置页可选。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { ensureBackgroundLibrary, importUrlBackground } from "./backgrounds";

const LS_KEY = "aprilio.wallpaper.v1";

/** 单次拉取的张数上下限：Bing 官方接口 n 的上限是 8（最近 8 天） */
const COUNT_MIN = 1;
const COUNT_MAX = 8;
/** 默认一次拉最近 7 天 */
export const DEFAULT_WALLPAPER_COUNT = 7;

export interface WallpaperConfig {
  /** 每次拉取的近期壁纸张数（1..=8） */
  count: number;
  /** 上次拉取的本地日期（YYYY-MM-DD），仅用于设置页展示 */
  last_date: string;
}

export const DEFAULT_WALLPAPER_CONFIG: WallpaperConfig = {
  count: DEFAULT_WALLPAPER_COUNT,
  last_date: "",
};

/** 把任意来源的 count 收敛到合法区间（旧配置缺字段 / 手改坏值都兜底） */
export function clampWallpaperCount(count: unknown): number {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n)) return DEFAULT_WALLPAPER_COUNT;
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, n));
}

export function loadWallpaperConfig(): WallpaperConfig {
  if (typeof localStorage === "undefined") return { ...DEFAULT_WALLPAPER_CONFIG };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_WALLPAPER_CONFIG };
    // 旧版配置里还有 enabled / last_url 等字段，这里显式只取仍在使用的
    const parsed = JSON.parse(raw) as Partial<WallpaperConfig>;
    return {
      count: clampWallpaperCount(parsed.count),
      last_date: typeof parsed.last_date === "string" ? parsed.last_date : "",
    };
  } catch {
    return { ...DEFAULT_WALLPAPER_CONFIG };
  }
}

export function saveWallpaperConfig(config: WallpaperConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(config));
}

/** 本地日期 YYYY-MM-DD（跟随系统时区） */
export function localDateStr(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** fetch_bing_wallpaper 的返回结构（Rust backgrounds.rs::BingWallpaper，按新到旧排序） */
interface BingWallpaperMeta {
  url: string;
  title: string;
  copyright: string;
}

/**
 * 拉取必应近期壁纸入库：全部进图库（入库来源记为课表背景），不更换任何背景。
 * 返回成功入库的张数（已在库里的同 URL 直接复用，不重复下载）。
 * 个别下载失败只跳过并落盘；一张都没进库才视为失败抛错。
 */
export async function importBingWallpapers(): Promise<number> {
  if (!isTauri()) throw new Error("仅桌面端支持拉取必应壁纸");

  const config = loadWallpaperConfig();
  const metas = await invoke<BingWallpaperMeta[]>("fetch_bing_wallpaper", {
    count: clampWallpaperCount(config.count),
  });
  await ensureBackgroundLibrary();

  let imported = 0;
  for (const meta of metas) {
    if (!meta.url) continue;
    try {
      await importUrlBackground("timetable_bg", meta.url, meta.title || meta.copyright);
      imported += 1;
    } catch (error) {
      console.error(`[renderer] 必应壁纸入库失败：${error instanceof Error ? error.message : error}`);
    }
  }
  if (metas.length > 0 && imported === 0) {
    throw new Error("壁纸拉取失败，请检查网络后重试");
  }
  saveWallpaperConfig({ ...config, last_date: localDateStr() });
  return imported;
}
