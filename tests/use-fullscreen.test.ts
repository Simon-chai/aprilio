import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 模拟 Tauri 窗口 API，隔离环境差异
const winMocks = vi.hoisted(() => ({
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
  onResized: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => winMocks,
}));

import { useFullscreen } from "../src/composables/useFullscreen";

describe("useFullscreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    winMocks.onResized.mockReturnValue(Promise.resolve(() => {}));
  });

  it("从未全屏切换时调用 setFullscreen(true)", async () => {
    winMocks.isFullscreen.mockResolvedValue(false);
    winMocks.setFullscreen.mockResolvedValue(undefined);

    const { isFullscreen, toggleFullscreen } = useFullscreen();
    await toggleFullscreen();

    expect(winMocks.setFullscreen).toHaveBeenCalledWith(true);
    expect(isFullscreen.value).toBe(true);
  });

  it("已全屏时切换回窗口模式", async () => {
    winMocks.isFullscreen.mockResolvedValue(true);
    winMocks.setFullscreen.mockResolvedValue(undefined);

    const { isFullscreen, toggleFullscreen } = useFullscreen();
    await toggleFullscreen();

    expect(winMocks.setFullscreen).toHaveBeenCalledWith(false);
    expect(isFullscreen.value).toBe(false);
  });

  it("按 F11 触发全屏切换", async () => {
    winMocks.isFullscreen.mockResolvedValue(false);
    winMocks.setFullscreen.mockResolvedValue(undefined);

    useFullscreen();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11" }));
    await flushPromises();

    expect(winMocks.setFullscreen).toHaveBeenCalledWith(true);
  });

  it("全屏时按 Esc 退出全屏", async () => {
    winMocks.setFullscreen.mockResolvedValue(undefined);

    const { isFullscreen } = useFullscreen();
    isFullscreen.value = true; // 模拟当前处于全屏
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();

    expect(winMocks.setFullscreen).toHaveBeenCalledWith(false);
    expect(isFullscreen.value).toBe(false);
  });

  it("非全屏时按 Esc 不触发任何窗口操作", async () => {
    winMocks.setFullscreen.mockResolvedValue(undefined);

    const { isFullscreen } = useFullscreen();
    isFullscreen.value = false;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();

    expect(winMocks.setFullscreen).not.toHaveBeenCalled();
    expect(isFullscreen.value).toBe(false);
  });
});
