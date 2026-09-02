import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./db";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/** 图片目录绝对路径（Tauri 外壳内有效，浏览器里返回空串） */
export async function getPhotosDir(): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("photos_dir");
}

/** 弹出系统文件选择框 → 把图片复制进应用图片目录 → 返回落盘文件名 */
export async function importPhoto(): Promise<string | null> {
  if (!isTauri()) return null;

  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }],
  });
  if (!selected || Array.isArray(selected)) return null;

  return invoke<string>("import_photo", { source: selected });
}

/** 删除落盘的图片文件（数据库记录由调用方先删） */
export async function deletePhotoFile(fileName: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_photo_file", { fileName });
}

/** 把 <图片目录>/<文件名> 转成 <img src> 能用的地址 */
export function photoUrl(dir: string, fileName: string): string {
  if (!dir || !fileName) return "";
  // 使用 Tauri 2 内置 asset 协议（tauri.conf.json 的 assetProtocol scope 限定到照片目录）
  return convertFileSrc(`${dir.replace(/\\/g, "/")}/${fileName}`);
}
