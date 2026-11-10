// 右栏预览的当前文件或文件夹（全局唯一）：点击回复里的文件引用、或一轮结束时 Agent 最后写出的文件，都在右栏打开。
// 在文件夹预览里点开子项时记下来处，标题栏的“返回”回到上一个位置。
import { create } from "zustand";
import { useAppStore } from "@/stores/app-store";

/** “返回”最多记住的位置数 */
const MAX_BACK = 50;

interface PreviewState {
  /** 预览中的文件或文件夹绝对路径；没有时为 null */
  path: string | null;
  /** 每次打开递增：同一路径再次打开时重新读取（文件可能已被改写） */
  seq: number;
  /** 在预览内部逐级打开前的位置（最近的在最后）；从预览外打开时清空 */
  back: string[];
  clear: () => void;
}

export const usePreviewStore = create<PreviewState>()((set) => ({
  path: null,
  seq: 0,
  back: [],
  clear: () => set({ path: null, back: [] }),
}));

/** 在右栏预览文件或文件夹：右栏收起时一并展开 */
export function showPreview(path: string): void {
  usePreviewStore.setState((s) => ({ path, seq: s.seq + 1, back: [] }));
  const app = useAppStore.getState();
  if (!app.inspectorPanelOpen) app.setInspectorPanelOpen(true);
}

/** 在预览内部打开（文件夹里的子项、面包屑、上一级）：记下当前位置供“返回” */
export function navigatePreview(path: string): void {
  usePreviewStore.setState((s) => ({
    path,
    seq: s.seq + 1,
    back: s.path && s.path !== path ? [...s.back, s.path].slice(-MAX_BACK) : s.back,
  }));
}

/** 返回上一个位置；没有时不动 */
export function previewBack(): void {
  usePreviewStore.setState((s) => {
    const prev = s.back.at(-1);
    if (!prev) return s;
    return { path: prev, seq: s.seq + 1, back: s.back.slice(0, -1) };
  });
}
