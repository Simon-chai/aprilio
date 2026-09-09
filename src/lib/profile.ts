import { computed, ref } from "vue";
import defaultAvatar from "../assets/avatar-teacher.png";
import defaultHero from "../assets/hero-classroom.png";
import { DEFAULT_PROFILE } from "../types";
import type { BackgroundKind, Profile } from "../types";
import { getProfile, isTauri, saveProfile as saveProfileRecord } from "./db";
import {
  classifyProfileSaveError,
  profileSaveErrorDiagnostic,
} from "./error-message";
import { getPhotosDir, importPhoto, photoUrl } from "./photos";
import {
  BG_FILE_PREFIX,
  backgroundCacheUrl,
  discardBackgroundFile,
  ensureBackgroundLibrary,
  registerLocalBackground,
} from "./backgrounds";
import { readImageAsDataUrl } from "./image";
import { error as tauriError } from "@tauri-apps/plugin-log";

/* ---- 临时诊断（排查个人资料持久化，验证后删除） ---- */
function diag(msg: string): void {
  try {
    void tauriError(`[diag:profile] ${msg}`).catch(() => undefined);
  } catch {
    /* 非 Tauri 环境 */
  }
}
diag(`module loaded isTauri=${isTauri()}`);

export type ProfileImageKind = BackgroundKind;

export interface ProfileImageSelection {
  value: string;
  /** Tauri copied files have a filename that can be cleaned up before saving. */
  fileName?: string;
}

/**
 * 个人资料的全局单一来源。
 * 组件只读写这个 ref，持久化由 persistProfile 负责，首页因此能实时反映编辑结果。
 */
export const profile = ref<Profile>({ ...DEFAULT_PROFILE });

/** 图片目录绝对路径；Tauri 内有效，浏览器里为空串 */
const photosDir = ref("");

const LS_KEY = "aprilio.profile.v1";

/* ------------------------------------------------------------------ */
/* 读取 / 写入                                                          */
/* ------------------------------------------------------------------ */

async function readProfile(): Promise<Profile> {
  if (!isTauri()) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return { ...DEFAULT_PROFILE, ...(JSON.parse(raw) as Partial<Profile>) };
    } catch {
      /* localStorage 不可用则退回内存 */
    }
  }
  const loaded = await getProfile();
  diag(`readProfile name=${loaded.name} my_subjects=${JSON.stringify(loaded.my_subjects)}`);
  return loaded;
}

async function writeProfile(p: Profile): Promise<void> {
  const mode = isTauri() ? "tauri" : "browser";

  try {
    if (mode === "browser") {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(p));
      } catch {
        throw new Error("本地资料保存失败，可能是浏览器存储空间不足。");
      }
    }

    await saveProfileRecord(p);
    diag(`writeProfile ok name=${p.name}`);
  } catch (cause) {
    const kind = classifyProfileSaveError(cause);
    const detail = profileSaveErrorDiagnostic(cause);
    diag(`writeProfile FAILED kind=${kind} detail=${detail}`);
    console.error(`[profile.save] failed mode=${mode} kind=${kind} detail=${detail}`);
    throw cause;
  }
}

let initPromise: Promise<void> | null = null;

/** 幂等初始化：应用启动时调一次即可，重复调用返回同一个 Promise */
export function ensureProfile(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const [p, dir] = await Promise.all([
        // 读取失败不能静默装作没发生：回退默认资料会让用户误以为编辑丢失，
        // 落盘错误便于事后从日志定位（Tauri 下载入失败会由 getDb 重试兜底）
        readProfile().catch((cause: unknown) => {
          console.error(
            "[renderer] 个人资料读取失败，本次启动显示默认资料：",
            cause instanceof Error ? cause.message : cause,
          );
          return { ...DEFAULT_PROFILE };
        }),
        getPhotosDir().catch(() => ""),
        ensureBackgroundLibrary().catch(() => undefined),
      ]);
      profile.value = { ...DEFAULT_PROFILE, ...p };
      photosDir.value = dir;
    })();
  }
  return initPromise;
}

let saveTimer = 0;
let pendingProfile: Profile | null = null;
let writeChain: Promise<void> = Promise.resolve();
let pendingWaiters: Array<{
  resolve: () => void;
  reject: (reason?: unknown) => void;
}> = [];

/** 防抖落库。返回 Promise 便于调用方显示"已保存"状态 */
export function persistProfile(next: Profile = profile.value): Promise<void> {
  pendingProfile = { ...next };

  const promise = new Promise<void>((resolve, reject) => {
    pendingWaiters.push({ resolve, reject });
  });

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const snapshot = pendingProfile;
    const waiters = pendingWaiters;
    pendingProfile = null;
    pendingWaiters = [];

    if (!snapshot) {
      waiters.forEach(({ resolve }) => resolve());
      return;
    }

    const queuedWrite = writeChain.then(() => writeProfile(snapshot));
    writeChain = queuedWrite.catch(() => undefined);
    void queuedWrite.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    );
  }, 350);

  return promise;
}

let saveVersion = 0;

export function saveProfileChanges(next: Profile): Promise<void> {
  const version = ++saveVersion;
  return persistProfile(next).then(() => {
    if (version === saveVersion) {
      profile.value = { ...next };
    }
  });
}

export function resetProfile(): void {
  profile.value = { ...DEFAULT_PROFILE };
}

/* ------------------------------------------------------------------ */
/* 图片                                                                */
/* ------------------------------------------------------------------ */

/** 存的是文件名就拼缓存目录；浏览器演示态存的是 dataURL，直接用 */
function resolve(value: string): string {
  if (!value) return "";
  if (/^(data|blob|https?):/.test(value)) return value;
  // bg_ 前缀 = 网络图片下载缓存（独立目录），其余是本地上传 / 历史数据（照片目录）
  if (value.startsWith(BG_FILE_PREFIX)) return backgroundCacheUrl(value);
  if (!photosDir.value) return "";
  return photoUrl(photosDir.value, value);
}

export function profileImageSrc(value: string, kind: ProfileImageKind): string {
  /* 课表背景无默认图：未设置返回空串，调用方自行决定降级样式 */
  if (kind === "timetable_bg") return resolve(value);
  const fallback = kind === "avatar" ? defaultAvatar : defaultHero;
  return resolve(value) || fallback;
}

export const avatarSrc = computed(() => profileImageSrc(profile.value.avatar, "avatar"));
export const heroSrc = computed(() => profileImageSrc(profile.value.hero, "hero"));

/** 首页课表面板背景图：没有默认图，未设置时为空串（面板退回纯毛玻璃） */
export const timetableBgSrc = computed(() => resolve(profile.value.timetable_bg));

/**
 * 课表卡片背景样式（我的课表页 / 班级课表 / 万年历等浅色表面共用）：
 * 白雾打底压住图片亮度，网格黑字仍可读；未设置返回 undefined（保持纯色卡片）。
 */
export const timetableBgSurfaceStyle = computed<Record<string, string> | undefined>(() => {
  const src = timetableBgSrc.value;
  if (!src) return undefined;
  return {
    backgroundImage: `linear-gradient(rgba(255,255,255,0.86), rgba(255,255,255,0.86)), url(${src})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
});

/**
 * 与 timetableBgSurfaceStyle 配套的比例约束：有背景图时统一 16:9，
 * 与裁剪窗口比例一致 —— 裁剪窗口里看到的就是各课表位置显示的区域。
 * CSS aspect-ratio 只是最小比例（内容更高时盒子随之长高），不裁内容、不加滚动条。
 */
export const timetableBgSurfaceClass = computed(() =>
  timetableBgSurfaceStyle.value ? "aspect-[16/9]" : ""
);

/** 是否用了自定义图片（决定编辑页要不要显示"恢复默认"） */
export const hasCustomAvatar = computed(() => profile.value.avatar !== "");
export const hasCustomHero = computed(() => profile.value.hero !== "");

/** 浏览器态的选图：隐藏 file input + canvas 降采样，避免 localStorage 爆掉 */
function pickLocal(square: boolean): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(v);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      reject(error);
    };

    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return done(null);
      readImageAsDataUrl(file, square ? 512 : 1920, square).then(done, fail);
    });

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

export async function selectProfileImage(
  kind: ProfileImageKind,
): Promise<ProfileImageSelection | null> {
  const value = isTauri()
    ? await importPhoto()
    : await pickLocal(kind === "avatar");
  if (!value) return null;

  // 选中的图立刻进图库：换下来的旧图留在历史里，未保存就离开时才清掉这张
  void registerLocalBackground(kind, value).catch(() => undefined);

  return isTauri() ? { value, fileName: value } : { value };
}

/** 丢弃一张未采用的图：图库索引与缓存文件一起清掉 */
export async function discardSelectedProfileImage(fileName: string): Promise<void> {
  if (!fileName) return;
  await discardBackgroundFile(fileName);
}

/**
 * 删除图库图片时同步清理个人资料里的引用：
 * 首页大图与课表背景共享一套图库，同一张图可能同时被多个字段引用。
 * 有清理时防抖落库，返回是否发生了清理。
 */
export async function clearProfileImageRefs(file: string): Promise<boolean> {
  if (!file) return false;
  const fields = ["avatar", "hero", "timetable_bg"] as const;
  const next = { ...profile.value };
  let changed = false;
  for (const field of fields) {
    if (next[field] === file) {
      next[field] = "";
      changed = true;
    }
  }
  if (changed) {
    profile.value = next;
    await persistProfile(next).catch(() => undefined);
  }
  return changed;
}
