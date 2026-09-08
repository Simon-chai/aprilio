/**
 * 背景图库：本地索引 + 本地缓存。
 *
 * - 索引：只存元信息，落 localStorage（浏览器演示态与桌面端同一套，纯本地、不同步到云端）；
 * - 缓存：本地上传沿用照片目录（`img_*.png`，历史数据就在这里，不做迁移），
 *   网络图片下载到独立缓存目录 `backgrounds/`（`bg_*.png` 前缀），由 backgroundsFileUrl 区分；
 * - 切换：profile 的三类图片字段仍只存「缓存标识」，从图库挑一张即写回该字段；
 *   换下来的图留在库里随时可切回，只有显式删除才清文件。
 */

import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./db";
import { photoUrl, getPhotosDir, deletePhotoFile } from "./photos";
import {
  base64ToBlobUrl,
  fetchImageDataUrl,
  nameFromPath,
  readImageAsDataUrl,
  revokeBlobUrl,
} from "./image";
import type { BackgroundImage, BackgroundKind, BackgroundSource } from "../types";

/** 网络缓存图的文件名前缀（Rust 侧 save_background_data_url 生成） */
const BG_PREFIX = "bg_";
const LS_KEY = "aprilio.backgrounds.v1";
/** 每类背景最多保留的历史张数（超出按最近使用时间淘汰） */
const MAX_PER_KIND = 12;

/** 图库索引（按 kind 分组、按最近使用倒序展示） */
export const backgroundLibrary = ref<BackgroundImage[]>([]);
/** 网络图片缓存目录（Tauri 内有效，浏览器里为空串） */
const backgroundsDir = ref("");
/** 照片目录：本地上传与历史数据都在这里 */
const photosDir = ref("");

let loadPromise: Promise<void> | null = null;

/* ------------------------------------------------------------------ */
/* 索引读写                                                            */
/* ------------------------------------------------------------------ */

/** 单调时间戳：同一毫秒内连续入库也能排出稳定的先后顺序 */
let lastTimestamp = 0;

function nowIso(): string {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return new Date(lastTimestamp).toISOString();
}

function newId(): string {
  return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 洗一遍外部存储：字段缺失补默认，脏数据直接丢弃，避免渲染层拿到 undefined */
function sanitize(raw: unknown): BackgroundImage[] {
  if (!Array.isArray(raw)) return [];
  const out: BackgroundImage[] = [];
  for (const item of raw as BackgroundImage[]) {
    if (!item || typeof item.file !== "string" || !item.file) continue;
    if (item.kind !== "avatar" && item.kind !== "hero" && item.kind !== "timetable_bg") continue;
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : newId(),
      kind: item.kind,
      file: item.file,
      source: item.source === "url" ? "url" : "local",
      origin_url: typeof item.origin_url === "string" ? item.origin_url : "",
      name: typeof item.name === "string" ? item.name : "",
      added_at: typeof item.added_at === "string" ? item.added_at : nowIso(),
      used_at: typeof item.used_at === "string" ? item.used_at : nowIso(),
    });
  }
  return out;
}

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(backgroundLibrary.value));
  } catch {
    /* 存储不可用（隐私模式 / 超配额）时只留内存态，不阻断使用 */
  }
}

/** 幂等初始化：读索引 + 解析两个缓存目录 */
export function ensureBackgroundLibrary(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) backgroundLibrary.value = sanitize(JSON.parse(raw));
      } catch {
        backgroundLibrary.value = [];
      }
      const [pd, bd] = await Promise.all([
        getPhotosDir().catch(() => ""),
        isTauri() ? invoke<string>("backgrounds_dir").catch(() => "") : Promise.resolve(""),
      ]);
      photosDir.value = pd;
      backgroundsDir.value = bd;
    })();
  }
  return loadPromise;
}

/* ------------------------------------------------------------------ */
/* 查询 / 解析                                                         */
/* ------------------------------------------------------------------ */

/** 网络下载缓存的文件名前缀（供 profile 侧判断该查哪个目录） */
export const BG_FILE_PREFIX = BG_PREFIX;

/** 网络缓存图（bg_ 前缀）的展示地址 */
export function backgroundCacheUrl(file: string): string {
  if (!file) return "";
  if (/^(data|blob|https?):/.test(file)) return file;
  return backgroundsDir.value ? photoUrl(backgroundsDir.value, file) : "";
}

/** 本地上传图（照片目录）的展示地址 */
export function localBackgroundUrl(file: string): string {
  if (!file) return "";
  if (/^(data|blob|https?):/.test(file)) return file;
  return photosDir.value ? photoUrl(photosDir.value, file) : "";
}

/** 把缓存标识解析成 <img src> / CSS url() 可用的地址（按前缀自动分流目录） */
export function backgroundsFileUrl(file: string): string {
  if (!file) return "";
  return file.startsWith(BG_PREFIX) ? backgroundCacheUrl(file) : localBackgroundUrl(file);
}

/** 图库项的展示地址 */
export function backgroundSrc(item: BackgroundImage | null | undefined): string {
  return item ? backgroundsFileUrl(item.file) : "";
}

/** 某类背景的历史（最近使用的在前） */
export function backgroundsOf(kind: BackgroundKind): BackgroundImage[] {
  return backgroundLibrary.value
    .filter((item) => item.kind === kind)
    .sort((a, b) => (a.used_at < b.used_at ? 1 : a.used_at > b.used_at ? -1 : 0));
}

export function findBackground(kind: BackgroundKind, file: string): BackgroundImage | undefined {
  if (!file) return undefined;
  return backgroundLibrary.value.find((item) => item.kind === kind && item.file === file);
}

/* ------------------------------------------------------------------ */
/* 入库                                                                */
/* ------------------------------------------------------------------ */

/** 从 URL 取展示名：末段文件名，取不到退回域名 */
export function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    const decoded = last ? decodeURIComponent(last) : "";
    return decoded || parsed.hostname;
  } catch {
    return url;
  }
}

async function register(input: {
  kind: BackgroundKind;
  file: string;
  source: BackgroundSource;
  origin_url?: string;
  name?: string;
}): Promise<BackgroundImage> {
  await ensureBackgroundLibrary();

  // 重复添加同一张：直接复用旧记录（URL 按原始地址去重，本地按缓存标识去重）
  const existing = backgroundLibrary.value.find((item) =>
    input.source === "url"
      ? item.kind === input.kind && item.origin_url === (input.origin_url ?? "")
      : item.kind === input.kind && item.file === input.file,
  );
  if (existing) {
    existing.used_at = nowIso();
    persist();
    prune(input.kind);
    return existing;
  }

  const item: BackgroundImage = {
    id: newId(),
    kind: input.kind,
    file: input.file,
    source: input.source,
    origin_url: input.origin_url ?? "",
    name: input.name ?? "",
    added_at: nowIso(),
    used_at: nowIso(),
  };
  backgroundLibrary.value = [...backgroundLibrary.value, item];
  persist();
  prune(input.kind);
  return item;
}

/** 本地上传：图片已落照片目录，这里只登记索引 */
export async function registerLocalBackground(
  kind: BackgroundKind,
  file: string,
  name = "",
): Promise<BackgroundImage | null> {
  if (!file) return null;
  return register({ kind, file, source: "local", name });
}

/** 裁剪原图的来源：桌面端本地文件 / 浏览器 File / 网络链接 */
export type CropSourceInput =
  | { type: "local"; path: string }
  | { type: "file"; file: File }
  | { type: "url"; url: string };

/**
 * 桌面端字节流的暂存表：blob: URL → { mime, base64 }。
 * blob URL 只给 <img> 展示用；真正落盘 / 直存时经 sourceToDataUrl 还原成 dataURL。
 */
const stagedSources = new Map<string, { mime: string; base64: string }>();

/** 把桌面端字节流暂存为 blob: URL（供 img.src 用，绕开超大 dataURL 在 WebView2 里加载失败的坑） */
function stageBlobUrl(base64: string, mime: string): string {
  const url = base64ToBlobUrl(base64, mime);
  stagedSources.set(url, { mime, base64 });
  return url;
}

/**
 * 把 loadCropSource 的 src 还原成可落盘的 dataURL：
 * blob: → 取暂存字节拼 dataURL（并释放）；data: / 其他 → 原样返回。
 */
export function sourceToDataUrl(src: string): string {
  if (!src.startsWith("blob:")) return src;
  const staged = stagedSources.get(src);
  revokeBlobUrl(src);
  if (!staged) return src;
  stagedSources.delete(src);
  return `data:${staged.mime};base64,${staged.base64}`;
}

/**
 * 取裁剪用的原图（**不落盘、不降采样**，裁剪窗要原始像素）。
 * 返回的 src 给 <img> 展示：桌面端是 blob: URL（超大图不再做成 dataURL，
 * 那在 WebView2 里会加载失败导致裁剪窗卡死），浏览器态仍是 dataURL。
 */
export async function loadCropSource(
  input: CropSourceInput,
): Promise<{ src: string; name: string }> {
  if (input.type === "file") {
    return {
      src: await readImageAsDataUrl(input.file, Number.MAX_SAFE_INTEGER, false),
      name: input.file.name,
    };
  }
  if (input.type === "local") {
    const bytes = await invoke<{ mime: string; base64: string }>("read_image_bytes", {
      source: input.path,
    });
    return { src: stageBlobUrl(bytes.base64, bytes.mime), name: nameFromPath(input.path) };
  }
  // url：桌面端 Rust 下载字节 → blob URL；浏览器态 fetch 后按原尺寸解码
  if (isTauri()) {
    const bytes = await invoke<{ mime: string; base64: string }>("download_background", {
      url: input.url.trim(),
    });
    return { src: stageBlobUrl(bytes.base64, bytes.mime), name: nameFromUrl(input.url) };
  }
  return { src: await fetchImageDataUrl(input.url, Number.MAX_SAFE_INTEGER), name: nameFromUrl(input.url) };
}

/**
 * 裁剪确认：dataURL 在桌面端校验后写盘（`bg_` 前缀，backgrounds 目录），
 * 浏览器演示态直接把 dataURL 当缓存标识，随后登记索引。
 */
export async function saveCroppedBackground(
  kind: BackgroundKind,
  dataUrl: string,
  meta: { source: BackgroundSource; originUrl?: string; name?: string },
): Promise<BackgroundImage> {
  const file = isTauri()
    ? await invoke<string>("save_background_data_url", { dataUrl })
    : dataUrl;
  if (!file) throw new Error("图片保存失败，请重试");
  return register({ kind, file, source: meta.source, origin_url: meta.originUrl ?? "", name: meta.name ?? "" });
}

/** 网络图片（不走裁剪窗的场景）：下载字节 → 写盘 → 入库 */
export async function importUrlBackground(
  kind: BackgroundKind,
  rawUrl: string,
): Promise<BackgroundImage> {
  const url = rawUrl.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error("请填写 http/https 开头的图片链接");
  }
  await ensureBackgroundLibrary();
  // 同一 URL 已在库里：直接复用旧记录，不再重复下载
  const existing = backgroundLibrary.value.find(
    (item) => item.kind === kind && item.origin_url === url,
  );
  if (existing) {
    return register({ kind, file: existing.file, source: "url", origin_url: url, name: existing.name });
  }
  const { src } = await loadCropSource({ type: "url", url });
  return saveCroppedBackground(kind, sourceToDataUrl(src), {
    source: "url",
    originUrl: url,
    name: nameFromUrl(url),
  });
}

/* ------------------------------------------------------------------ */
/* 使用 / 删除                                                         */
/* ------------------------------------------------------------------ */

/** 淘汰某类里最久未使用的历史（至少保留一张，避免删掉正在用的图） */
function prune(kind: BackgroundKind): void {
  const items = backgroundsOf(kind);
  if (items.length <= MAX_PER_KIND) return;
  for (const stale of items.slice(1).slice(MAX_PER_KIND - 1)) {
    void removeBackground(stale.id);
  }
}

/** 标记某张图被设为当前背景（图库排序依据） */
export function markBackgroundUsed(kind: BackgroundKind, file: string): void {
  const item = findBackground(kind, file);
  if (!item) return;
  item.used_at = nowIso();
  persist();
}

/** 从图库移除：删索引 + 删缓存文件 */
export async function removeBackground(id: string): Promise<void> {
  const item = backgroundLibrary.value.find((entry) => entry.id === id);
  if (!item) return;
  backgroundLibrary.value = backgroundLibrary.value.filter((entry) => entry.id !== id);
  persist();
  await deleteBackgroundCache(item.file);
}

/** 删除缓存文件本身：bg_ 走背景缓存目录，其余走照片目录 */
async function deleteBackgroundCache(file: string): Promise<void> {
  if (!file || /^(data|blob|https?):/.test(file)) return;
  if (!isTauri()) return;
  try {
    if (file.startsWith(BG_PREFIX)) {
      await invoke("delete_background_file", { fileName: file });
    } else {
      await deletePhotoFile(file);
    }
  } catch {
    /* 文件已丢失不影响索引清理 */
  }
}

/**
 * 丢弃一张「选了但没保存」的图：索引与文件一起清掉。
 * 已保存过的图不在清理范围内，所以换图不会误删历史。
 */
export async function discardBackgroundFile(file: string): Promise<void> {
  if (!file) return;
  const before = backgroundLibrary.value.length;
  backgroundLibrary.value = backgroundLibrary.value.filter((item) => item.file !== file);
  if (backgroundLibrary.value.length !== before) persist();
  await deleteBackgroundCache(file);
}

/** 清空图库（设置页清数据用）：索引与缓存文件一并删除 */
export async function clearBackgroundLibrary(): Promise<void> {
  const files = backgroundLibrary.value.map((item) => item.file);
  backgroundLibrary.value = [];
  persist();
  await Promise.all(files.map((file) => deleteBackgroundCache(file)));
}
