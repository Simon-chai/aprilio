/**
 * 图片解码 / 降采样：本地选图与网络图片共用。
 *
 * 桌面端由 Rust 落盘（不受 CORS 限制），这里只在浏览器演示态兜底：
 * 把图片压到指定长边后再转 dataURL，避免 localStorage 被大图写爆。
 */

/**
 * 把图片文件读成 dataURL。
 * @param max 长边上限（px），超过则等比缩小
 * @param square 是否居中裁成正方（头像用，避免拉伸）
 */
export function readImageAsDataUrl(
  file: Blob,
  max: number,
  square: boolean,
): Promise<string> {
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

/** 拉网络图片 → 转 dataURL（浏览器演示态缓存；受 CORS 限制，失败时抛出可读错误） */
export async function fetchImageDataUrl(url: string, max: number): Promise<string> {
  let blob: Blob;
  try {
    const resp = await fetch(url, { mode: "cors" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    blob = await resp.blob();
  } catch (cause) {
    throw new Error(
      `下载图片失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return readImageAsDataUrl(blob, max, false);
}

/**
 * 浏览器演示态的选图：隐藏 file input，返回 File 与原始文件名。
 * 降采样 / 裁剪由调用方决定——裁剪流程需要原图，不能在这里压缩。
 */
export function pickLocalFile(): Promise<{ file: File; name: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const done = (value: { file: File; name: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
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
      done({ file, name: file.name });
    });

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

/** 文件路径 / 文件名 → 展示名（取末段） */
export function nameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

/**
 * base64 图片字节 → blob: URL。
 * 超大图片（数 MB）的 dataURL 喂给 img.src 在 WebView2 里会加载失败/挂起，
 * blob: URL 是内存引用，WebView 原生解码，无大小限制、速度也快得多。
 * 用完请调用 revokeBlobUrl 释放。
 */
export function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 释放 base64ToBlobUrl 创建的 blob: URL（非 blob: 地址原样忽略） */
export function revokeBlobUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
