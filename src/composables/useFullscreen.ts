import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 模块级单例：全屏状态全局共享（App 只挂载一次，侧边栏与快捷键读写同一份）
const isFullscreen = ref(false);

// 监听器只绑一次（App 与 AppSidebar 都会调用本组合式函数）
let bound = false;

async function syncState() {
  try {
    isFullscreen.value = await getCurrentWindow().isFullscreen();
  } catch {
    // 非 Tauri 环境（单测 / 纯浏览器预览）静默忽略
  }
}

/**
 * 窗口全屏模式。
 * 进入后隐藏系统标题栏与边框；F11 快捷键全局可切换，侧边栏提供同步按钮。
 */
export function useFullscreen() {
  const toggleFullscreen = async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      isFullscreen.value = next;
    } catch {
      // 非 Tauri 环境静默忽略
    }
  };

  // 仅用于 Esc 退出全屏；正常模式下不拦截 Esc，避免影响弹窗等既有交互
  const exitFullscreen = async () => {
    try {
      const win = getCurrentWindow();
      await win.setFullscreen(false);
      isFullscreen.value = false;
    } catch {
      // 非 Tauri 环境静默忽略
    }
  };

  if (!bound) {
    bound = true;
    // F11 切换全屏（浏览器习惯键位），拦截默认行为避免 WebView 自己处理；
    // 全屏时 Esc 同效退出，非全屏时放行给页面内交互
    window.addEventListener("keydown", (e) => {
      if (e.key === "F11") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (e.key === "Escape" && isFullscreen.value) {
        e.preventDefault();
        void exitFullscreen();
      }
    });
    // 系统级退出全屏（如 Win+方向键）不会走 toggle，靠 resize 事件兜底同步状态
    void syncState();
    try {
      getCurrentWindow()
        .onResized(() => void syncState())
        .catch(() => {});
    } catch {
      // 非 Tauri 环境静默忽略
    }
  }

  return { isFullscreen, toggleFullscreen };
}
