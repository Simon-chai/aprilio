import { computed, ref } from "vue";
import defaultAvatar from "../assets/avatar-teacher.png";
import defaultHero from "../assets/hero-classroom.png";
import { DEFAULT_PROFILE } from "../types";
import type { Profile } from "../types";
import { getProfile, isTauri, saveProfile as saveProfileRecord } from "./db";
import {
  classifyProfileSaveError,
  profileSaveErrorDiagnostic,
} from "./error-message";
import { deletePhotoFile, getPhotosDir, importPhoto, photoUrl } from "./photos";

export type ProfileImageKind = "avatar" | "hero";

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
  return getProfile();
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
  } catch (cause) {
    const kind = classifyProfileSaveError(cause);
    const detail = profileSaveErrorDiagnostic(cause);
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
        readProfile().catch(() => ({ ...DEFAULT_PROFILE })),
        getPhotosDir().catch(() => ""),
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

/** 存的是文件名就拼图片目录；浏览器演示态存的是 dataURL，直接用 */
function resolve(value: string): string {
  if (!value) return "";
  if (/^(data|blob|https?):/.test(value)) return value;
  if (!photosDir.value) return "";
  return photoUrl(photosDir.value, value);
}

export function profileImageSrc(value: string, kind: ProfileImageKind): string {
  const fallback = kind === "avatar" ? defaultAvatar : defaultHero;
  return resolve(value) || fallback;
}

export const avatarSrc = computed(() => profileImageSrc(profile.value.avatar, "avatar"));
export const heroSrc = computed(() => profileImageSrc(profile.value.hero, "hero"));

/** 是否用了自定义图片（决定编辑页要不要显示"恢复默认"） */
export const hasCustomAvatar = computed(() => profile.value.avatar !== "");
export const hasCustomHero = computed(() => profile.value.hero !== "");

function readAsDataUrl(file: File, max: number, square: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.onabort = () => reject(new Error("读取文件已中止"));
    reader.onload = () => {
      try {
        const img = new Image();
        img.onerror = () => reject(new Error("这不是有效的图片"));
        img.onload = () => {
          try {
            let { width: sw, height: sh } = img;
            let sx = 0;
            let sy = 0;
            if (square) {
              // 居中裁正方，头像不会被拉伸
              const side = Math.min(sw, sh);
              sx = Math.round((sw - side) / 2);
              sy = Math.round((sh - side) / 2);
              sw = side;
              sh = side;
            }
            const scale = Math.min(1, max / Math.max(sw, sh));
            const w = Math.max(1, Math.round(sw * scale));
            const h = Math.max(1, Math.round(sh * scale));

            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("无法处理图片");
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.86));
          } catch (error) {
            reject(error);
          }
        };
        img.src = String(reader.result);
      } catch (error) {
        reject(error);
      }
    };
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      reject(error);
    }
  });
}

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
      try {
        void readAsDataUrl(file, square ? 512 : 1920, square).then(done, fail);
      } catch (error) {
        fail(error);
      }
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

  return isTauri() ? { value, fileName: value } : { value };
}

export async function discardSelectedProfileImage(fileName: string): Promise<void> {
  if (!isTauri() || !fileName || /^(data|blob|https?):/.test(fileName)) return;
  await deletePhotoFile(fileName);
}
