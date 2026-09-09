import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom 没有 createObjectURL：blob URL 转换（loadCropSource 桌面端分支）需要它
let blobSeq = 0;
URL.createObjectURL = vi.fn(() => `blob:mock-${(blobSeq += 1)}`) as typeof URL.createObjectURL;
URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL;

const mocks = vi.hoisted(() => {
  const runtime = { tauri: true, photosDir: "C:/aprilio/photos", bgDir: "C:/aprilio/backgrounds" };
  return {
    runtime,
    isTauri: vi.fn(() => runtime.tauri),
    getPhotosDir: vi.fn(async () => runtime.photosDir),
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

type BackgroundsModule = typeof import("../src/lib/backgrounds");

/** 每个用例都从干净模块开始：图库索引是模块级单例，resetModules 才能隔离 */
async function freshLibrary(): Promise<BackgroundsModule> {
  vi.resetModules();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "backgrounds_dir") return mocks.runtime.bgDir;
    return undefined;
  });
  const mod = await import("../src/lib/backgrounds");
  await mod.ensureBackgroundLibrary();
  return mod;
}

beforeEach(() => {
  mocks.runtime.tauri = true;
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("background library", () => {
  it("caches a remote image locally and indexes its origin", async () => {
    const bg = await freshLibrary();
    // 新契约：download_background 只回字节流，前端裁剪/直存时再经 save_background_data_url 落盘
    mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "backgrounds_dir") return mocks.runtime.bgDir;
      if (command === "download_background") return { mime: "image/jpeg", base64: "AAEC" };
      if (command === "save_background_data_url") {
        expect(args?.dataUrl).toBe("data:image/jpeg;base64,AAEC");
        return "bg_1.png";
      }
      return undefined;
    });

    const item = await bg.importUrlBackground("hero", "https://cdn.example.com/a/b/sunset.jpg?w=800");

    expect(mocks.invoke).toHaveBeenCalledWith("download_background", {
      url: "https://cdn.example.com/a/b/sunset.jpg?w=800",
    });
    expect(item.file).toBe("bg_1.png");
    expect(item.source).toBe("url");
    expect(item.origin_url).toBe("https://cdn.example.com/a/b/sunset.jpg?w=800");
    expect(item.name).toBe("sunset.jpg");
    expect(bg.backgroundsOf("hero")).toEqual([item]);
  });

  it("rejects non-http urls before touching the network", async () => {
    const bg = await freshLibrary();

    await expect(bg.importUrlBackground("hero", "ftp://example.com/a.png")).rejects.toThrow(
      /http/,
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "download_background",
      expect.anything(),
    );
  });

  it("accepts an explicit display name for url imports", async () => {
    const bg = await freshLibrary();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "backgrounds_dir") return mocks.runtime.bgDir;
      if (command === "download_background") return { mime: "image/jpeg", base64: "AAEC" };
      if (command === "save_background_data_url") return "bg_2.png";
      return undefined;
    });

    // 必应壁纸的 URL 末段冗长难读，允许调用方传入展示名（缺省仍取 URL 末段）
    const named = await bg.importUrlBackground(
      "timetable_bg",
      "https://cn.bing.com/th?id=OHR.GabitKeni_ZH-CN2314122948_1920x1080.jpg",
      "印度西海岸的生活",
    );
    expect(named.name).toBe("印度西海岸的生活");

    const fallback = await bg.importUrlBackground("hero", "https://cdn.example.com/a/dawn.jpg");
    expect(fallback.name).toBe("dawn.jpg");
  });

  it("reuses the cached entry when the same url is added twice", async () => {
    const bg = await freshLibrary();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "backgrounds_dir") return mocks.runtime.bgDir;
      if (command === "download_background") return { mime: "image/png", base64: "AAE" };
      if (command === "save_background_data_url") return "bg_1.png";
      return undefined;
    });

    const first = await bg.importUrlBackground("timetable_bg", "https://a.com/x.png");
    const second = await bg.importUrlBackground("timetable_bg", "https://a.com/x.png");

    // 第二次同一 URL：复用记录，不再走下载
    const downloadCalls = mocks.invoke.mock.calls.filter(([c]) => c === "download_background");
    expect(downloadCalls).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(bg.backgroundLibrary.value).toHaveLength(1);
  });

  it("keeps locally uploaded images and remote cache in separate directories", async () => {
    const bg = await freshLibrary();

    await bg.registerLocalBackground("avatar", "img_99.png");

    expect(bg.backgroundsFileUrl("img_99.png")).toBe("C:/aprilio/photos/img_99.png");
    expect(bg.backgroundsFileUrl("bg_1.png")).toBe("C:/aprilio/backgrounds/bg_1.png");
    expect(bg.backgroundSrc(bg.backgroundsOf("avatar")[0])).toBe(
      "C:/aprilio/photos/img_99.png",
    );
  });

  it("sorts history by last used time so switching back is one click", async () => {
    const bg = await freshLibrary();
    const older = await bg.registerLocalBackground("hero", "img_1.png");
    const newer = await bg.registerLocalBackground("hero", "img_2.png");

    expect(bg.backgroundsOf("hero").map((i) => i.file)).toEqual(["img_2.png", "img_1.png"]);

    bg.markBackgroundUsed("hero", older!.file);
    expect(bg.backgroundsOf("hero").map((i) => i.file)).toEqual(["img_1.png", "img_2.png"]);
  });

  it("deletes the cached file together with the index entry", async () => {
    const bg = await freshLibrary();
    const remote = await bg.registerLocalBackground("timetable_bg", "bg_7.png");
    const local = await bg.registerLocalBackground("timetable_bg", "img_7.png");

    await bg.removeBackground(remote!.id);
    await bg.removeBackground(local!.id);

    expect(mocks.invoke).toHaveBeenCalledWith("delete_background_file", {
      fileName: "bg_7.png",
    });
    expect(mocks.deletePhotoFile).toHaveBeenCalledWith("img_7.png");
    expect(bg.backgroundLibrary.value).toHaveLength(0);
  });

  it("drops an unsaved image from the index and disk", async () => {
    const bg = await freshLibrary();
    await bg.registerLocalBackground("hero", "img_pending.png");

    await bg.discardBackgroundFile("img_pending.png");

    expect(bg.backgroundLibrary.value).toHaveLength(0);
    expect(mocks.deletePhotoFile).toHaveBeenCalledWith("img_pending.png");
  });

  it("keeps avatars capped at 12 entries and prunes the least recently used", async () => {
    const bg = await freshLibrary();
    for (let i = 1; i <= 14; i += 1) {
      await bg.registerLocalBackground("avatar", `img_${i}.png`);
    }

    const files = bg.backgroundsOf("avatar").map((item) => item.file);
    expect(files).toHaveLength(12);
    // 最新一张必须留下（可能正在用），淘汰的是最早的两张
    expect(files).toContain("img_14.png");
    expect(files).not.toContain("img_1.png");
  });

  it("caps the shared hero/timetable pool at 24 entries", async () => {
    const bg = await freshLibrary();
    for (let i = 1; i <= 26; i += 1) {
      await bg.registerLocalBackground("hero", `img_${i}.png`);
    }

    const files = bg.pickerBackgrounds("hero").map((item) => item.file);
    expect(files).toHaveLength(24);
    expect(files).toContain("img_26.png");
    expect(files).not.toContain("img_1.png");
  });

  it("shares one pool between hero and timetable backgrounds, avatars stay separate", async () => {
    const bg = await freshLibrary();
    await bg.registerLocalBackground("hero", "img_hero.png");
    await bg.registerLocalBackground("timetable_bg", "img_tt.png");
    await bg.registerLocalBackground("avatar", "img_face.png");

    // 头像弹窗只见头像
    expect(bg.pickerBackgrounds("avatar").map((item) => item.file)).toEqual(["img_face.png"]);
    // 首页大图与课表背景共用一套（按最近使用倒序）
    const shared = ["img_tt.png", "img_hero.png"];
    expect(bg.pickerBackgrounds("hero").map((item) => item.file)).toEqual(shared);
    expect(bg.pickerBackgrounds("timetable_bg").map((item) => item.file)).toEqual(shared);
  });

  it("dedupes a url across the shared pool instead of per kind", async () => {
    const bg = await freshLibrary();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "backgrounds_dir") return mocks.runtime.bgDir;
      if (command === "download_background") return { mime: "image/png", base64: "AAE" };
      if (command === "save_background_data_url") return "bg_1.png";
      return undefined;
    });

    const first = await bg.importUrlBackground("timetable_bg", "https://a.com/x.png");
    const second = await bg.importUrlBackground("hero", "https://a.com/x.png");

    // 同一 URL 先进课表池再进首页池：共享池内去重，不重复下载
    expect(second.id).toBe(first.id);
    expect(bg.backgroundLibrary.value).toHaveLength(1);
  });

  it("finds shared entries across kinds when marking usage", async () => {
    const bg = await freshLibrary();
    await bg.registerLocalBackground("hero", "img_1.png");

    // 课表背景直接采用首页大图传进来的缓存标识：跨 kind 也能命中
    expect(bg.findBackground("timetable_bg", "img_1.png")?.file).toBe("img_1.png");
    bg.markBackgroundUsed("timetable_bg", "img_1.png");
    expect(bg.backgroundsOf("hero")).toHaveLength(1);
  });

  it("persists the index to localStorage and rebuilds it after a reload", async () => {
    const first = await freshLibrary();
    await first.registerLocalBackground("timetable_bg", "img_keep.png");
    await first.importUrlBackground("timetable_bg", "https://a.com/keep.png").catch(() => undefined);

    const raw = localStorage.getItem("aprilio.backgrounds.v1") ?? "[]";
    expect(raw).toContain("img_keep.png");

    // 模拟重启：重新加载模块后索引仍在
    const reloaded = await (async () => {
      vi.resetModules();
      mocks.invoke.mockImplementation(async (command: string) =>
        command === "backgrounds_dir" ? mocks.runtime.bgDir : undefined,
      );
      const mod = await import("../src/lib/backgrounds");
      await mod.ensureBackgroundLibrary();
      return mod;
    })();
    expect(reloaded.backgroundsOf("timetable_bg").map((i) => i.file)).toContain("img_keep.png");
  });

  it("ignores corrupted index payloads instead of crashing the view", async () => {
    localStorage.setItem("aprilio.backgrounds.v1", "{not json");
    const bg = await freshLibrary();

    expect(bg.backgroundLibrary.value).toEqual([]);
  });
});
