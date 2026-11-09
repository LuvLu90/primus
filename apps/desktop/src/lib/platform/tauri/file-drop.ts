import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileDropSource } from "../file-drop";

// 原生拖放：Tauri 的位置是物理像素，换算成 CSS 像素（除以缩放比例）后交给组件做命中判断
export function createTauriFileDrop(): FileDropSource {
  return {
    listen: async (listener) => {
      const webview = getCurrentWebview();
      return webview.onDragDropEvent((event) => {
        const p = event.payload;
        const scale = window.devicePixelRatio || 1;
        if (p.type === "leave") {
          listener({ type: "leave", paths: [] });
          return;
        }
        const position = { x: p.position.x / scale, y: p.position.y / scale };
        listener({ type: p.type, paths: "paths" in p ? p.paths : [], position });
      });
    },
  };
}
