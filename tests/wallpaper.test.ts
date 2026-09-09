import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom 没有 createObjectURL：blob URL 转换（loadCropSource 桌面端分支）需要它
let blobSeq = 0;
URL.createObjectURL = vi.fn(() => `blob:mock-${(blobSeq += 1)}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

const mocks = vi.hoisted(() => {
  const runtime = { tauri: true, bingUrl: "https://cn.bing.com/th?id=OHR.GabitKeni_1920x1080.jpg" };
  return {
    runtime,
    isTauri: vi.fn(() => runtime.tauri),
    getPhotosDir: vi.fn(async () => "C:/aprilio/photos"),
    photoUrl: vi.fn((dir: string, file: string) => `${dir}/${file}`),
    deletePhotoFile: vi.fn(async () => undefined),
    invoke: vi.fn(),
  };
});

vi.mock("../src/lib/db", () => ({ isTauri: mocks.isTauri }));
vi.mock("../src/lib/photos", () => ({
  getPhotosDir: mocks.getPhotosDir,
  photoUrl: mocks.photoUrl,
  deletePhotoFile: mocks.deletePhotoFile,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const LS_KEY = "aprilio.wallpaper.v1";
/** Bing 返回按新到旧排序：第 0 张是当天 */
const BING_METAS = [
  {
    url: mocks.runtime.bingUrl,
    title: "印度西海岸的生活",
    copyright: "安科拉附近的加比特凯尼海滩 (© Amith Nag Photography)",
  },
  { url: "https://cn.bing.com/th?id=OHR.Second_1920x1080.jpg", title: "近一日", copyright: "© b" },
  { url: "https://cn.bing.com/th?id=OHR.Third_1920x1080.jpg", title: "近二日", copyright: "© c" },
];

type WallpaperModule = typeof import("../src/lib/wallpaper");

/** 每个用例从干净模块开始：config 在 localStorage、图库索引是模块级单例 */
async function freshWallpaper() {
  vi.resetModules();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "backgrounds_dir" ? "C:/aprilio/backgrounds" : undefined,
  );
  const mod = (await import("../src/lib/wallpaper")) as WallpaperModule;
  const bgMod = await import("../src/lib/backgrounds");
  return { mod, bgMod };
}

function mockBingPipeline() {
  let saveSeq = 0;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "backgrounds_dir") return "C:/aprilio/backgrounds";
    if (command === "fetch_bing_wallpaper") return BING_METAS;
    if (command === "download_background") return { mime: "image/jpeg", base64: "AAEC" };
    // 每张图落盘给不同文件名，便于断言逐张入库
    if (command === "save_background_data_url") return `bg_${101 + (saveSeq += 1)}.jpg`;
    return undefined;
  });
}

function storedConfig(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}");
}

beforeEach(() => {
  mocks.runtime.tauri = true;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bing wallpaper import", () => {
  it("imports recent bing wallpapers into the library without changing any background", async () => {
    const { mod, bgMod } = await freshWallpaper();
    mockBingPipeline();

    const imported = await mod.importBingWallpapers();

    // 默认一次拉近 7 天（Bing 接口上限 8）
    expect(mocks.invoke).toHaveBeenCalledWith("fetch_bing_wallpaper", { count: 7 });
    // 全部入库，展示名用 Bing 标题
    expect(imported).toBe(3);
    const library = bgMod.backgroundLibrary.value;
    expect(library).toHaveLength(3);
    expect(library.every((item) => item.kind === "timetable_bg")).toBe(true);
    expect(library.map((item) => item.name)).toContain("印度西海岸的生活");
    // 推进「上次拉取」日期
    expect(storedConfig().last_date).toBe(mod.localDateStr());
  });

  it("passes the configured count to the rust side", async () => {
    const { mod } = await freshWallpaper();
    localStorage.setItem(LS_KEY, JSON.stringify({ count: 3 }));
    mockBingPipeline();

    await mod.importBingWallpapers();

    expect(mocks.invoke).toHaveBeenCalledWith("fetch_bing_wallpaper", { count: 3 });
  });

  it("reuses cached entries on repeated fetches without downloading again", async () => {
    const { mod, bgMod } = await freshWallpaper();
    mockBingPipeline();

    await mod.importBingWallpapers();
    const downloadsAfterFirst = mocks.invoke.mock.calls.filter(
      ([command]) => command === "download_background",
    ).length;
    const imported = await mod.importBingWallpapers();

    // 第二次拉取：同 URL 全部复用，零下载
    expect(imported).toBe(3);
    const downloadsAfterSecond = mocks.invoke.mock.calls.filter(
      ([command]) => command === "download_background",
    ).length;
    expect(downloadsAfterSecond).toBe(downloadsAfterFirst);
    expect(bgMod.backgroundLibrary.value).toHaveLength(3);
  });

  it("skips a failed download and still imports the rest", async () => {
    const { mod, bgMod } = await freshWallpaper();
    mocks.invoke.mockImplementation(async (command: string, args?: { url?: string }) => {
      if (command === "backgrounds_dir") return "C:/aprilio/backgrounds";
      if (command === "fetch_bing_wallpaper") return BING_METAS;
      if (command === "download_background") {
        if (args?.url === BING_METAS[1].url) throw new Error("下载失败");
        return { mime: "image/jpeg", base64: "AAEC" };
      }
      if (command === "save_background_data_url") return "bg_201.jpg";
      return undefined;
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const imported = await mod.importBingWallpapers();

    // 单张失败只跳过：其余照常入库，整体算成功
    expect(imported).toBe(2);
    expect(bgMod.backgroundLibrary.value).toHaveLength(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("必应壁纸入库失败"));
    expect(storedConfig().last_date).toBe(mod.localDateStr());
  });

  it("throws when nothing was imported at all", async () => {
    const { mod } = await freshWallpaper();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "backgrounds_dir") return "C:/aprilio/backgrounds";
      if (command === "fetch_bing_wallpaper") return BING_METAS;
      if (command === "download_background") throw new Error("网络不可用");
      return undefined;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(mod.importBingWallpapers()).rejects.toThrow(/壁纸拉取失败/);
  });

  it("is rejected in the browser demo state", async () => {
    const { mod } = await freshWallpaper();
    mocks.runtime.tauri = false;

    await expect(mod.importBingWallpapers()).rejects.toThrow(/桌面端/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("clamps the fetch count into the 1..8 window", async () => {
    const { mod } = await freshWallpaper();

    // 缺省 / 坏值回默认 7；越界收敛到上下限
    expect(mod.clampWallpaperCount(undefined)).toBe(7);
    expect(mod.clampWallpaperCount("abc")).toBe(7);
    expect(mod.clampWallpaperCount(0)).toBe(1);
    expect(mod.clampWallpaperCount(99)).toBe(8);
    expect(mod.clampWallpaperCount(5.6)).toBe(6);
  });
});
