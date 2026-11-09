// 右栏预览的当前文件（全局唯一）：点击回复里的文件引用、或一轮结束时 Agent 最后写出的文件，都在右栏打开。
import { create } from "zustand";
import { useAppStore } from "@/stores/app-store";

interface PreviewState {
  /** 预览中的文件绝对路径；没有时为 null */
  path: string | null;
  /** 每次打开递增：同一路径再次打开时重新读取（文件可能已被改写） */
  seq: number;
  clear: () => void;
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  path: null,
  seq: 0,
  clear: () => set({ path: null }),
}));

/** 在右栏预览文件：右栏收起时一并展开 */
export function showPreview(path: string): void {
  usePreviewStore.setState((s) => ({ path, seq: s.seq + 1 }));
  const app = useAppStore.getState();
  if (!app.inspectorPanelOpen) app.setInspectorPanelOpen(true);
}
