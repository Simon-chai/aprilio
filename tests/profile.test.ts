import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileMocks = vi.hoisted(() => {
  const runtime = { tauri: false };

  return {
    runtime,
    getProfile: vi.fn(),
    isTauri: vi.fn(() => runtime.tauri),
    saveProfile: vi.fn(),
    dbg: vi.fn(),
    deletePhotoFile: vi.fn(),
    getPhotosDir: vi.fn(),
    importPhoto: vi.fn(),
    photoUrl: vi.fn((dir: string, fileName: string) => `${dir}/${fileName}`),
  };
});

vi.mock("../src/lib/db", () => ({
  getProfile: profileMocks.getProfile,
  isTauri: profileMocks.isTauri,
  saveProfile: profileMocks.saveProfile,
  dbg: profileMocks.dbg,
}));

vi.mock("../src/lib/photos", () => ({
  deletePhotoFile: profileMocks.deletePhotoFile,
  getPhotosDir: profileMocks.getPhotosDir,
  importPhoto: profileMocks.importPhoto,
  photoUrl: profileMocks.photoUrl,
}));

import { DEFAULT_PROFILE, type Profile } from "../src/types";
import {
  discardSelectedProfileImage,
  ensureProfile,
  profile,
  profileImageSrc,
  saveProfileChanges,
  selectProfileImage,
} from "../src/lib/profile";

const nextProfile: Profile = {
  name: "周老师",
  title: "语文老师",
  motto: "把好奇心留在每一堂课里。",
  avatar: "",
  hero: "",
};

const firstProfile: Profile = { ...nextProfile, name: "第一版" };
const secondProfile: Profile = { ...nextProfile, name: "第二版" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type PromiseOutcome<T> =
  | { status: "pending" }
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

async function observePromise<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  let outcome: PromiseOutcome<T> = { status: "pending" };
  void promise.then(
    (value) => {
      outcome = { status: "fulfilled", value };
    },
    (reason: unknown) => {
      outcome = { status: "rejected", reason };
    },
  );

  for (let i = 0; i < 8 && outcome.status === "pending"; i += 1) {
    await Promise.resolve();
  }
  return outcome;
}

function mockBrowserFileSelection(file = new File(["source"], "image.png", { type: "image/png" })) {
  return vi.spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(function () {
      Object.defineProperty(this, "files", { configurable: true, value: [file] });
      this.dispatchEvent(new Event("change"));
    });
}

describe("profile persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    profileMocks.runtime.tauri = false;
    profileMocks.getProfile.mockReset().mockResolvedValue({ ...DEFAULT_PROFILE });
    profileMocks.isTauri.mockClear();
    profileMocks.saveProfile.mockReset().mockResolvedValue(undefined);
    profileMocks.dbg.mockReset().mockResolvedValue(undefined);
    profileMocks.deletePhotoFile.mockReset().mockResolvedValue(undefined);
    profileMocks.getPhotosDir.mockReset().mockResolvedValue("");
    profileMocks.importPhoto.mockReset().mockResolvedValue(null);
    profileMocks.photoUrl.mockClear();
    localStorage.clear();
    profile.value = { ...DEFAULT_PROFILE };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns a bundled fallback when a profile image is empty", () => {
    expect(profileImageSrc("", "avatar")).toBeTruthy();
    expect(profileImageSrc("", "hero")).toBeTruthy();
  });

  it("does not mutate the profile when image selection is cancelled", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function () {
        this.dispatchEvent(new Event("cancel"));
      });

    await expect(selectProfileImage("avatar")).resolves.toBeNull();
    expect(profile.value).toEqual(DEFAULT_PROFILE);
    click.mockRestore();
  });

  it("returns the selected Tauri filename without mutating the profile", async () => {
    profileMocks.runtime.tauri = true;
    profileMocks.importPhoto.mockResolvedValue("teacher-avatar.png");

    await expect(selectProfileImage("avatar")).resolves.toEqual({
      value: "teacher-avatar.png",
      fileName: "teacher-avatar.png",
    });
    expect(profileMocks.importPhoto).toHaveBeenCalledOnce();
    expect(profile.value).toEqual(DEFAULT_PROFILE);
  });

  it("converts and center-crops a browser avatar before returning it", async () => {
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        this.result = "data:image/png;base64,source";
        this.onload?.();
      }
    }

    class FakeImage {
      width = 1200;
      height = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,converted");
    const file = new File(["source"], "wide.png", { type: "image/png" });
    const click = vi.spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function () {
        Object.defineProperty(this, "files", { configurable: true, value: [file] });
        this.dispatchEvent(new Event("change"));
      });
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);

    await expect(selectProfileImage("avatar")).resolves.toEqual({
      value: "data:image/jpeg;base64,converted",
    });
    expect(getContext).toHaveBeenCalledOnce();
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.86);
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(FakeImage),
      200,
      0,
      800,
      800,
      0,
      0,
      512,
      512,
    );
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("compresses a non-square browser hero image to a maximum dimension of 1920", async () => {
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        this.result = "data:image/png;base64,source";
        this.onload?.();
      }
    }

    class FakeImage {
      width = 3840;
      height = 2160;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    const drawImage = vi.fn();
    const context = { drawImage } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,compressed");
    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", FakeFileReader);
    vi.stubGlobal("Image", FakeImage);

    await expect(selectProfileImage("hero")).resolves.toEqual({
      value: "data:image/jpeg;base64,compressed",
    });
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(FakeImage),
      0,
      0,
      3840,
      2160,
      0,
      0,
      1920,
      1080,
    );
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects browser image read failures and removes the hidden input", async () => {
    class FailingFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        this.onerror?.();
      }
    }

    const file = new File(["broken"], "broken.png", { type: "image/png" });
    const click = vi.spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function () {
        Object.defineProperty(this, "files", { configurable: true, value: [file] });
        this.dispatchEvent(new Event("change"));
      });
    vi.stubGlobal("FileReader", FailingFileReader);

    const selection = selectProfileImage("hero");
    const rejection = expect(selection).rejects.toThrow("读取文件失败");
    await rejection;

    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects a FileReader abort and removes the hidden input", async () => {
    class AbortingFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        queueMicrotask(() => this.abort());
      }

      abort(): void {
        this.onabort?.();
      }
    }

    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", AbortingFileReader);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toBeTruthy();
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects a synchronous FileReader.readAsDataURL error and removes the hidden input", async () => {
    class ThrowingFileReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        throw new Error("synchronous read failed");
      }
    }

    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", ThrowingFileReader);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toContain("synchronous read failed");
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects an Image src setter error and removes the hidden input", async () => {
    class AsyncFileReader {
      result: string | null = "data:image/png;base64,source";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        queueMicrotask(() => {
          try {
            this.onload?.();
          } catch {
            // Browser event dispatch does not turn an onload exception into a read promise rejection.
          }
        });
      }
    }

    class ThrowingImage {
      width = 800;
      height = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        throw new Error("image source failed");
      }
    }

    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", AsyncFileReader);
    vi.stubGlobal("Image", ThrowingImage);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toContain("image source failed");
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects a canvas drawImage error and removes the hidden input", async () => {
    class AsyncFileReader {
      result: string | null = "data:image/png;base64,source";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        queueMicrotask(() => {
          try {
            this.onload?.();
          } catch {
            // Keep the fake event boundary faithful to browser behavior.
          }
        });
      }
    }

    class LoadedImage {
      width = 800;
      height = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    const drawImage = vi.fn(() => {
      throw new Error("draw failed");
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", AsyncFileReader);
    vi.stubGlobal("Image", LoadedImage);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toContain("draw failed");
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects a canvas toDataURL error and removes the hidden input", async () => {
    class AsyncFileReader {
      result: string | null = "data:image/png;base64,source";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        queueMicrotask(() => {
          try {
            this.onload?.();
          } catch {
            // Keep the fake event boundary faithful to browser behavior.
          }
        });
      }
    }

    class LoadedImage {
      width = 800;
      height = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    }

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockImplementation(() => {
        throw new Error("encode failed");
      });
    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", AsyncFileReader);
    vi.stubGlobal("Image", LoadedImage);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toContain("encode failed");
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects an invalid image load and removes the hidden input", async () => {
    class FileReaderThatLoads {
      result: string | null = "data:image/png;base64,source";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      readAsDataURL(_file: File): void {
        this.onload?.();
      }
    }

    class InvalidImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onerror?.();
      }
    }

    const click = mockBrowserFileSelection();
    vi.stubGlobal("FileReader", FileReaderThatLoads);
    vi.stubGlobal("Image", InvalidImage);

    const outcome = await observePromise(selectProfileImage("hero"));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(Error);
      expect((outcome.reason as Error).message).toBeTruthy();
    }
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("rejects picker errors and removes the hidden input", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function () {
        throw new Error("选择器失败");
      });

    await expect(selectProfileImage("hero")).rejects.toThrow("选择器失败");
    expect(document.querySelector('input[type="file"]')).toBeNull();
    click.mockRestore();
  });

  it("deletes a selected Tauri image during discard", async () => {
    profileMocks.runtime.tauri = true;

    await discardSelectedProfileImage("teacher-hero.jpg");

    expect(profileMocks.deletePhotoFile).toHaveBeenCalledOnce();
    expect(profileMocks.deletePhotoFile).toHaveBeenCalledWith("teacher-hero.jpg");
  });

  it("serializes overlapping writes and exposes the newest saved snapshot", async () => {
    const writes: Array<{
      snapshot: Profile;
      completion: ReturnType<typeof deferred<void>>;
    }> = [];
    profileMocks.saveProfile.mockImplementation((snapshot: Profile) => {
      const completion = deferred<void>();
      writes.push({ snapshot, completion });
      return completion.promise;
    });

    const firstSaving = saveProfileChanges(firstProfile);
    await vi.advanceTimersByTimeAsync(350);
    const secondSaving = saveProfileChanges(secondProfile);
    await vi.advanceTimersByTimeAsync(350);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.snapshot).toEqual(firstProfile);

    writes[0]?.completion.resolve();
    await expect(firstSaving).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(2);
    expect(writes[1]?.snapshot).toEqual(secondProfile);
    expect(profile.value).toEqual(DEFAULT_PROFILE);

    writes[1]?.completion.resolve();
    await expect(secondSaving).resolves.toBeUndefined();
    expect(profile.value).toEqual(secondProfile);
  });

  it("writes the requested snapshot before exposing it as saved state", async () => {
    const saving = saveProfileChanges(nextProfile);
    expect(profile.value).toEqual(DEFAULT_PROFILE);

    await vi.advanceTimersByTimeAsync(350);
    await saving;

    expect(profile.value).toEqual(nextProfile);
    expect(JSON.parse(localStorage.getItem("aprilio.profile.v1") ?? "{}"))
      .toMatchObject(nextProfile);
  });

  it("keeps the saved state unchanged when local storage rejects the write", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
    });

    const saving = saveProfileChanges(nextProfile);
    const rejection = expect(saving).rejects.toThrow("本地资料保存失败");
    await vi.advanceTimersByTimeAsync(350);

    await rejection;
    expect(profile.value).toEqual(DEFAULT_PROFILE);
    setItem.mockRestore();
  });

  it("persists changes through the Tauri database writer", async () => {
    profileMocks.runtime.tauri = true;

    const saving = saveProfileChanges(nextProfile);
    await vi.advanceTimersByTimeAsync(350);

    await expect(saving).resolves.toBeUndefined();
    expect(profileMocks.saveProfile).toHaveBeenCalledOnce();
    expect(profileMocks.saveProfile).toHaveBeenCalledWith(nextProfile);
    expect(profile.value).toEqual(nextProfile);
    expect(localStorage.getItem("aprilio.profile.v1")).toBeNull();
  });

  it("records a sanitized Tauri save lifecycle", async () => {
    profileMocks.runtime.tauri = true;

    const saving = saveProfileChanges(nextProfile);
    await vi.advanceTimersByTimeAsync(350);
    await expect(saving).resolves.toBeUndefined();

    expect(profileMocks.dbg).toHaveBeenCalledWith("PROFILE_SAVE_START mode=tauri");
    expect(profileMocks.dbg).toHaveBeenCalledWith("PROFILE_SAVE_SUCCESS mode=tauri");
    const messages = profileMocks.dbg.mock.calls.flat().join(" ");
    expect(messages).not.toContain(nextProfile.name);
    expect(messages).not.toContain(nextProfile.title);
    expect(messages).not.toContain(nextProfile.motto);
  });

  it("classifies a Tauri execute permission failure in diagnostics", async () => {
    profileMocks.runtime.tauri = true;
    profileMocks.saveProfile.mockRejectedValueOnce(new Error("command execute not allowed"));

    const saving = saveProfileChanges(nextProfile);
    const rejection = expect(saving).rejects.toThrow("command execute not allowed");
    await vi.advanceTimersByTimeAsync(350);
    await rejection;

    expect(profileMocks.dbg).toHaveBeenCalledWith(
      "PROFILE_SAVE_FAILURE mode=tauri kind=database-permission detail=Error command execute not allowed",
    );
  });

  it("rejects every waiter when a debounced write fails", async () => {
    const failure = new Error("write failed");
    profileMocks.saveProfile.mockRejectedValue(failure);

    const firstSaving = saveProfileChanges(firstProfile);
    const secondSaving = saveProfileChanges(secondProfile);
    const outcomes = Promise.allSettled([firstSaving, secondSaving]);
    await vi.advanceTimersByTimeAsync(350);

    const settled = await outcomes;
    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ status: "rejected", reason: failure });
    expect(settled[1]).toMatchObject({ status: "rejected", reason: failure });
    expect(profile.value).toEqual(DEFAULT_PROFILE);
  });

  it("resolves initialized Tauri filenames through the configured photos directory", async () => {
    profileMocks.runtime.tauri = true;
    profileMocks.getProfile.mockResolvedValue({
      ...DEFAULT_PROFILE,
      hero: "stored-hero.png",
    });
    profileMocks.getPhotosDir.mockResolvedValue("C:/aprilio/photos");

    await ensureProfile();

    expect(profileImageSrc("stored-hero.png", "hero"))
      .toBe("C:/aprilio/photos/stored-hero.png");
    expect(profileMocks.photoUrl).toHaveBeenCalledWith(
      "C:/aprilio/photos",
      "stored-hero.png",
    );
  });
});
