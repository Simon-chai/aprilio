import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  items: [] as Array<{
    id: string;
    kind: "avatar" | "hero" | "timetable_bg";
    file: string;
    source: "local" | "url";
    origin_url: string;
    name: string;
    added_at: string;
    used_at: string;
  }>,
  ensureBackgroundLibrary: vi.fn(async () => undefined),
  importUrlBackground: vi.fn(),
  removeBackground: vi.fn(async () => undefined),
  markBackgroundUsed: vi.fn(),
  selectProfileImage: vi.fn(),
  discardSelectedProfileImage: vi.fn(async () => undefined),
  clearProfileImageRefs: vi.fn(async () => false),
  loadCropSource: vi.fn(),
  saveCroppedBackground: vi.fn(),
  pickLocalFile: vi.fn(),
}));

vi.mock("../src/lib/backgrounds", () => ({
  backgroundSrc: (item: { file: string }) => `resolved://${item.file}`,
  pickerBackgrounds: () => mocks.items,
  ensureBackgroundLibrary: mocks.ensureBackgroundLibrary,
  importUrlBackground: mocks.importUrlBackground,
  removeBackground: mocks.removeBackground,
  markBackgroundUsed: mocks.markBackgroundUsed,
  loadCropSource: mocks.loadCropSource,
  saveCroppedBackground: mocks.saveCroppedBackground,
}));

vi.mock("../src/lib/profile", () => ({
  selectProfileImage: mocks.selectProfileImage,
  discardSelectedProfileImage: mocks.discardSelectedProfileImage,
  clearProfileImageRefs: mocks.clearProfileImageRefs,
}));

vi.mock("../src/lib/image", () => ({
  pickLocalFile: mocks.pickLocalFile,
}));

import BackgroundPickerDialog from "../src/components/BackgroundPickerDialog.vue";

/** ImageCropDialog 替身：只保留 open/src 的映射与 confirm/cancel 事件面 */
const CropStub = defineComponent({
  name: "ImageCropDialog",
  props: {
    open: { type: Boolean, default: false },
    src: { type: String, default: "" },
    title: { type: String, default: "" },
  },
  emits: ["confirm", "cancel"],
  setup(props) {
    return () => (props.open ? h("div", { "data-test": "crop-dialog-stub" }) : null);
  },
});

function itemAt(index: number) {
  return {
    id: `id-${index}`,
    kind: "timetable_bg" as const,
    file: `img_${index}.png`,
    source: "local" as const,
    origin_url: "",
    name: `图 ${index}`,
    added_at: "2026-09-08T02:00:00.000Z",
    used_at: "2026-09-08T02:00:00.000Z",
  };
}

function mountPicker(current = "") {
  return mount(BackgroundPickerDialog, {
    props: { open: true, kind: "timetable_bg", current },
  });
}

/** 开启裁剪流程的挂载（课表背景）：ImageCropDialog 用替身，便于观察状态与派发事件 */
function mountCropPicker(current = "") {
  return mount(BackgroundPickerDialog, {
    props: { open: true, kind: "timetable_bg", current, crop: true },
    global: { stubs: { ImageCropDialog: CropStub } },
  });
}

beforeEach(() => {
  mocks.items = [itemAt(1), itemAt(2)];
  mocks.ensureBackgroundLibrary.mockClear();
  mocks.importUrlBackground.mockReset();
  mocks.removeBackground.mockClear();
  mocks.markBackgroundUsed.mockClear();
  mocks.selectProfileImage.mockReset().mockResolvedValue(null);
  mocks.discardSelectedProfileImage.mockClear();
  mocks.clearProfileImageRefs.mockClear();
  mocks.loadCropSource.mockReset();
  mocks.saveCroppedBackground.mockReset();
  mocks.pickLocalFile.mockReset();
});

describe("BackgroundPickerDialog", () => {
  it("lists history thumbnails and switching back takes one click", async () => {
    const wrapper = mountPicker("img_2.png");

    expect(wrapper.findAll('[data-test="bg-picker-item"]')).toHaveLength(2);
    await wrapper.findAll('[data-test="bg-picker-item"]')[0].trigger("click");

    expect(mocks.markBackgroundUsed).toHaveBeenCalledWith("timetable_bg", "img_1.png");
    expect(wrapper.emitted("select")).toEqual([["img_1.png", false]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("uploads a local image and marks it as fresh", async () => {
    mocks.selectProfileImage.mockResolvedValue({ value: "img_new.png", fileName: "img_new.png" });
    const wrapper = mountPicker();

    await wrapper.get('[data-test="bg-picker-local"]').trigger("click");

    expect(mocks.selectProfileImage).toHaveBeenCalledWith("timetable_bg");
    expect(wrapper.emitted("select")).toEqual([["img_new.png", true]]);
  });

  it("loads an image from a url and reports it as fresh", async () => {
    mocks.importUrlBackground.mockResolvedValue({ ...itemAt(9), file: "bg_9.png", source: "url" });
    const wrapper = mountPicker();

    await wrapper.get('[data-test="bg-picker-url"]').setValue("https://cdn.test/sky.jpg");
    await wrapper.get('[data-test="bg-picker-add"]').trigger("click");

    expect(mocks.importUrlBackground).toHaveBeenCalledWith("timetable_bg", "https://cdn.test/sky.jpg");
    expect(wrapper.emitted("select")).toEqual([["bg_9.png", true]]);
  });

  it("shows the failure reason when a url cannot be loaded", async () => {
    mocks.importUrlBackground.mockRejectedValue(new Error("图片下载失败：HTTP 404"));
    const wrapper = mountPicker();

    await wrapper.get('[data-test="bg-picker-url"]').setValue("https://cdn.test/missing.jpg");
    await wrapper.get('[data-test="bg-picker-add"]').trigger("click");

    expect(wrapper.get('[data-test="bg-picker-error"]').text()).toContain("HTTP 404");
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("empties the current background when its entry is deleted", async () => {
    const wrapper = mountPicker("img_1.png");

    await wrapper.findAll('[data-test="bg-picker-remove"]')[0].trigger("click");

    expect(mocks.removeBackground).toHaveBeenCalledWith("id-1");
    // 共享图库删除时同步清掉个人资料里的引用
    expect(mocks.clearProfileImageRefs).toHaveBeenCalledWith("img_1.png");
    expect(wrapper.emitted("clear")).toHaveLength(1);
  });

  it("keeps the current background when another entry is deleted", async () => {
    const wrapper = mountPicker("img_1.png");

    await wrapper.findAll('[data-test="bg-picker-remove"]')[1].trigger("click");

    expect(mocks.clearProfileImageRefs).toHaveBeenCalledWith("img_2.png");
    expect(wrapper.emitted("clear")).toBeUndefined();
  });

  it("hints at an empty library instead of rendering a blank grid", () => {
    mocks.items = [];
    const wrapper = mountPicker();

    expect(wrapper.text()).toContain("还没有历史图片");
    expect(wrapper.find('[data-test="bg-picker-item"]').exists()).toBe(false);
  });

  it("discards an in-flight selection when the dialog unmounts mid-pick", async () => {
    // 手动控制：先挂起，卸载后再结算
    let resolveSelection!: (value: { value: string; fileName: string }) => void;
    const pending = new Promise<{ value: string; fileName: string }>((resolve) => {
      resolveSelection = resolve;
    });
    mocks.selectProfileImage.mockReturnValueOnce(pending);

    const wrapper = mountPicker();
    await wrapper.get('[data-test="bg-picker-local"]').trigger("click");
    wrapper.unmount();

    resolveSelection({ value: "late-bg.png", fileName: "late-bg.png" });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.discardSelectedProfileImage).toHaveBeenCalledWith("late-bg.png");
  });

  it("announces busy state so the host page can block leaving", async () => {
    let release!: (value: { value: string; fileName: string } | null) => void;
    const pending = new Promise<{ value: string; fileName: string } | null>((resolve) => {
      release = resolve;
    });
    mocks.selectProfileImage.mockReturnValueOnce(pending);

    const wrapper = mountPicker();
    await wrapper.get('[data-test="bg-picker-local"]').trigger("click");
    expect(wrapper.emitted("busy")).toEqual([[true]]);

    release(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapper.emitted("busy")?.at(-1)).toEqual([false]);
  });

  /* ---- 裁剪流程（crop = true，课表背景）：先取景，确认后才落盘入库 ---- */

  it("routes a url image through the crop window before saving", async () => {
    mocks.loadCropSource.mockResolvedValue({ src: "blob:mock-sky", name: "sky.jpg" });
    mocks.saveCroppedBackground.mockResolvedValue({ id: "id-9", file: "bg_9.png" });
    const wrapper = mountCropPicker();

    await wrapper.get('[data-test="bg-picker-url"]').setValue("https://cdn.test/sky.jpg");
    await wrapper.get('[data-test="bg-picker-add"]').trigger("click");
    await flushPromises();

    expect(mocks.loadCropSource).toHaveBeenCalledWith({ type: "url", url: "https://cdn.test/sky.jpg" });
    // 还没确认：不能先采用
    expect(wrapper.emitted("select")).toBeUndefined();

    const crop = wrapper.findComponent(CropStub);
    expect(crop.props("open")).toBe(true);
    expect(crop.props("src")).toBe("blob:mock-sky");

    crop.vm.$emit("confirm", "data:image/jpeg;base64,CROP");
    await flushPromises();

    expect(mocks.saveCroppedBackground).toHaveBeenCalledWith(
      "timetable_bg",
      "data:image/jpeg;base64,CROP",
      { source: "url", originUrl: "https://cdn.test/sky.jpg", name: "sky.jpg" },
    );
    expect(mocks.markBackgroundUsed).toHaveBeenCalledWith("timetable_bg", "bg_9.png");
    expect(wrapper.emitted("select")).toEqual([["bg_9.png", true]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("routes a local upload through the crop window before saving", async () => {
    mocks.pickLocalFile.mockResolvedValue({ file: new File([], "local.png"), name: "local.png" });
    mocks.loadCropSource.mockResolvedValue({ src: "data:image/png;base64,BBB", name: "local.png" });
    mocks.saveCroppedBackground.mockResolvedValue({ id: "id-8", file: "bg_8.png" });
    const wrapper = mountCropPicker();

    await wrapper.get('[data-test="bg-picker-local"]').trigger("click");
    await flushPromises();

    expect(mocks.pickLocalFile).toHaveBeenCalledTimes(1);
    expect(mocks.loadCropSource).toHaveBeenCalledWith({ type: "file", file: expect.any(File) });
    expect(wrapper.findComponent(CropStub).props("open")).toBe(true);
    expect(wrapper.emitted("select")).toBeUndefined();

    wrapper.findComponent(CropStub).vm.$emit("confirm", "data:image/png;base64,CCC");
    await flushPromises();

    expect(mocks.saveCroppedBackground).toHaveBeenCalledWith(
      "timetable_bg",
      "data:image/png;base64,CCC",
      { source: "local", originUrl: undefined, name: "local.png" },
    );
    expect(wrapper.emitted("select")).toEqual([["bg_8.png", true]]);
  });

  it("keeps the current background when the crop window is cancelled", async () => {
    mocks.loadCropSource.mockResolvedValue({ src: "blob:mock-sky", name: "sky.jpg" });
    const wrapper = mountCropPicker();

    await wrapper.get('[data-test="bg-picker-url"]').setValue("https://cdn.test/sky.jpg");
    await wrapper.get('[data-test="bg-picker-add"]').trigger("click");
    await flushPromises();

    wrapper.findComponent(CropStub).vm.$emit("cancel");
    await flushPromises();

    expect(mocks.saveCroppedBackground).not.toHaveBeenCalled();
    expect(mocks.markBackgroundUsed).not.toHaveBeenCalled();
    expect(wrapper.emitted("select")).toBeUndefined();
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("rejects non-http links before opening the crop window", async () => {
    const wrapper = mountCropPicker();

    await wrapper.get('[data-test="bg-picker-url"]').setValue("ftp://cdn.test/x.jpg");
    await wrapper.get('[data-test="bg-picker-add"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-test="bg-picker-error"]').text()).toContain("http/https");
    expect(mocks.loadCropSource).not.toHaveBeenCalled();
    expect(wrapper.findComponent(CropStub).props("open")).toBe(false);
  });
});
