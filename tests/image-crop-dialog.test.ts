import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** cropperjs 替身：捕获构造参数与实例生命周期，jsdom 里跑不了真 canvas。
    vi.hoisted 里定义：vi.mock 工厂在 import 阶段就会执行，类声明有 TDZ */
const { FakeCropper } = vi.hoisted(() => {
  class FakeCropper {
    static instances: FakeCropper[] = [];

    el: unknown;
    options: Record<string, unknown>;
    destroyed = false;
    canvasCalls: unknown[] = [];
    /** 置 true 时 getCroppedCanvas 返回 null（模拟导出失败） */
    returnNullCanvas = false;

    constructor(el: unknown, options: Record<string, unknown>) {
      this.el = el;
      this.options = options;
      FakeCropper.instances.push(this);
    }

    /** 触发 ready 回调（真实库在图片解码完成后调用） */
    fireReady(): void {
      (this.options.ready as (() => void) | undefined)?.();
    }

    getCroppedCanvas(options: unknown): { toDataURL: () => string } | null {
      this.canvasCalls.push(options);
      if (this.returnNullCanvas) return null;
      return { toDataURL: () => "data:image/jpeg;base64,FAKE" };
    }

    destroy(): void {
      this.destroyed = true;
    }
  }
  return { FakeCropper };
});

vi.mock("cropperjs", () => ({ default: FakeCropper }));

import ImageCropDialog from "../src/components/ImageCropDialog.vue";

const DATA_URL = "data:image/jpeg;base64,AAA";

function mountDialog(open = true) {
  return mount(ImageCropDialog, {
    props: { open, src: open ? DATA_URL : "", title: "课表背景图 · 裁剪取景" },
  });
}

beforeEach(() => {
  FakeCropper.instances = [];
});

describe("ImageCropDialog（cropperjs 封装）", () => {
  it("打开弹窗即初始化 cropper：比例锁定 16:9、图片完整可见、可整体拖动", async () => {
    const wrapper = mountDialog();
    await nextTick();

    expect(FakeCropper.instances).toHaveLength(1);
    const options = FakeCropper.instances[0].options;
    expect(options.aspectRatio).toBeCloseTo(16 / 9);
    expect(options.viewMode).toBe(1); // 图片不超出画布：完整可见
    expect(options.dragMode).toBe("move"); // 空白处可拖动图片
    expect(options.background).toBe(false);
  });

  it("未就绪时确认不可用，ready 后导出 1600 宽的 JPEG dataURL", async () => {
    const wrapper = mountDialog();
    await nextTick();

    const confirmBtn = wrapper.get('[data-test="crop-confirm"]');
    expect(confirmBtn.attributes("disabled")).toBeDefined();

    const cropper = FakeCropper.instances[0];
    cropper.fireReady();
    await nextTick();
    expect(wrapper.get('[data-test="crop-confirm"]').attributes("disabled")).toBeUndefined();

    await wrapper.get('[data-test="crop-confirm"]').trigger("click");

    expect(cropper.canvasCalls).toEqual([
      { width: 1600, imageSmoothingQuality: "high", fillColor: "#ffffff" },
    ]);
    expect(wrapper.emitted("confirm")).toEqual([["data:image/jpeg;base64,FAKE"]]);
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  it("取消：销毁 cropper 并上报 cancel，不产出结果", async () => {
    const wrapper = mountDialog();
    await nextTick();
    FakeCropper.instances[0].fireReady();
    await nextTick();

    await wrapper.get('[data-test="crop-cancel"]').trigger("click");

    expect(FakeCropper.instances[0].destroyed).toBe(true);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("导出画布为空：给出可见提示而不是无声失败", async () => {
    const wrapper = mountDialog();
    await nextTick();
    const cropper = FakeCropper.instances[0];
    cropper.fireReady();
    cropper.returnNullCanvas = true;
    await nextTick();

    await wrapper.get('[data-test="crop-confirm"]').trigger("click");

    expect(wrapper.get('[data-test="crop-confirm-error"]').text()).toContain("导出失败");
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("Esc 关闭走取消路径", async () => {
    const wrapper = mountDialog();
    await nextTick();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();

    expect(FakeCropper.instances[0].destroyed).toBe(true);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("关闭 / 卸载时销毁 cropper，不泄漏实例", async () => {
    const wrapper = mountDialog();
    await nextTick();

    await wrapper.setProps({ open: false, src: "" });
    expect(FakeCropper.instances[0].destroyed).toBe(true);

    // 重新打开：重建一个新实例
    await wrapper.setProps({ open: true, src: DATA_URL });
    await nextTick();
    expect(FakeCropper.instances).toHaveLength(2);

    wrapper.unmount();
    expect(FakeCropper.instances[1].destroyed).toBe(true);
  });
});
