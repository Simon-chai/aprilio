import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";

// photoUrl 依赖 Tauri 运行时的 convertFileSrc，测试里换成纯字符串映射
vi.mock("../src/lib/photos", () => ({
  photoUrl: (dir: string, fileName: string) => (dir ? `mock-asset://${fileName}` : ""),
}));

import ImageLightbox from "../src/components/ui/ImageLightbox.vue";
import PhotoGrid from "../src/components/PhotoGrid.vue";
import type { Photo } from "../src/types";

const items = [
  { src: "mock-asset://a.png", caption: "春游合影" },
  { src: "mock-asset://b.png", caption: "运动会" },
  { src: "mock-asset://c.png", caption: "" },
];

const mountLightbox = (props: Record<string, unknown> = {}) =>
  mount(ImageLightbox, { props: { open: true, items, index: 0, ...props } });

const photo = (over: Partial<Photo>): Photo => ({
  id: 1,
  student_id: null,
  file_name: "a.png",
  caption: null,
  taken_at: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

describe("ImageLightbox", () => {
  it("打开时按 index 显示对应图片、说明与计数，首张时「上一张」禁用", () => {
    const w = mountLightbox();
    expect(w.find('[data-test="lightbox-image"]').attributes("src")).toBe(items[0].src);
    expect(w.find('[data-test="lightbox-caption"]').text()).toBe("春游合影");
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("1 / 3");
    expect(w.find('[data-test="lightbox-prev"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="lightbox-next"]').attributes("disabled")).toBeUndefined();
    w.unmount();
  });

  it("index 越界时收敛到最后一张", () => {
    const w = mountLightbox({ index: 99 });
    expect(w.find('[data-test="lightbox-image"]').attributes("src")).toBe(items[2].src);
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("3 / 3");
    w.unmount();
  });

  it("按钮翻页更新图片与计数，末张时「下一张」禁用", async () => {
    const w = mountLightbox();
    await w.find('[data-test="lightbox-next"]').trigger("click");
    expect(w.find('[data-test="lightbox-image"]').attributes("src")).toBe(items[1].src);
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("2 / 3");

    await w.find('[data-test="lightbox-next"]').trigger("click");
    expect(w.find('[data-test="lightbox-next"]').attributes("disabled")).toBeDefined();

    await w.find('[data-test="lightbox-prev"]').trigger("click");
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("2 / 3");
    w.unmount();
  });

  it("← / → 键盘翻页", async () => {
    const w = mountLightbox();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await w.vm.$nextTick();
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("2 / 3");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await w.vm.$nextTick();
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("1 / 3");
    w.unmount();
  });

  it("点击图片在适应窗口 ↔ 原始尺寸间切换，翻页后回到适应窗口", async () => {
    const w = mountLightbox();
    const img = () => w.find('[data-test="lightbox-image"]');
    expect(img().classes()).toContain("object-contain");

    await img().trigger("click");
    expect(img().classes()).toContain("max-w-none");
    expect(img().classes()).not.toContain("object-contain");

    await w.find('[data-test="lightbox-next"]').trigger("click");
    expect(img().classes()).toContain("object-contain");
    w.unmount();
  });

  it("关闭按钮与遮罩壳统一 emit close", async () => {
    const w = mountLightbox();
    await w.find('[data-test="lightbox-close"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("只有一张时不渲染翻页按钮与计数", () => {
    const w = mount(ImageLightbox, {
      props: { open: true, items: [items[0]], index: 0 },
    });
    expect(w.find('[data-test="lightbox-prev"]').exists()).toBe(false);
    expect(w.find('[data-test="lightbox-next"]').exists()).toBe(false);
    expect(w.find('[data-test="lightbox-count"]').exists()).toBe(false);
    w.unmount();
  });

  it("open=false 时不渲染任何内容", () => {
    const w = mountLightbox({ open: false });
    expect(w.find('[data-test="lightbox-image"]').exists()).toBe(false);
    w.unmount();
  });
});

describe("PhotoGrid 缩略图与查看原图", () => {
  const photos = [
    photo({ id: 1, file_name: "a.png", caption: "春游合影" }),
    photo({ id: 2, file_name: "b.png", caption: "运动会" }),
  ];

  it("缩略图等比缩放（object-contain）不裁剪，点击打开原图灯箱", async () => {
    const w = mount(PhotoGrid, { props: { photos, dir: "D:/photos", canAdd: true } });
    const thumbs = w.findAll('[data-test="photo-thumb"]');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0].classes()).toContain("object-contain");
    expect(thumbs[0].classes()).not.toContain("object-cover");

    await thumbs[1].trigger("click");
    expect(w.find('[data-test="image-lightbox"]').exists()).toBe(true);
    expect(w.find('[data-test="lightbox-image"]').attributes("src")).toBe("mock-asset://b.png");
    expect(w.find('[data-test="lightbox-count"]').text()).toBe("2 / 2");
    w.unmount();
  });

  it("没有文件地址（演示模式）的照片展示占位、无缩略图可点", async () => {
    const w = mount(PhotoGrid, { props: { photos, dir: "", canAdd: false } });
    expect(w.text()).toContain("示例图片");
    expect(w.find('[data-test="photo-thumb"]').exists()).toBe(false);
    expect(w.find('[data-test="lightbox-image"]').exists()).toBe(false);
    w.unmount();
  });
});
