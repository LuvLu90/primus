import { create } from "zustand";
import {
  BOTTOM_DRAWER,
  clamp,
  LEFT_PANEL,
  type PanelLimits,
  RIGHT_PANEL,
} from "@/components/layout/panel-layout";
import type { WorkspaceInfo } from "@/lib/platform/types";

/** 权限模式：每次询问 / 自动编辑 / 完全访问（接入 Core 后由 primus-guard 执行） */
export type PermissionMode = "ask" | "edit" | "full";

// 全局 store（第 16.4 节）。目前只有主界面布局状态；工作区、设置、会话索引后续加入。
// 尺寸只按各栏自身上下限夹住；按视口的收缩在渲染时由 resolvePanelLayout 计算，不回写 store，
// 窗口放大后恢复为用户拖出的尺寸。
export interface AppState {
  /** 左栏：会话列表 */
  sessionsPanelOpen: boolean;
  sessionsPanelWidth: number;
  /** 右栏：变更 / 文件 / 计划 */
  inspectorPanelOpen: boolean;
  inspectorPanelWidth: number;
  /** 底部抽屉：终端 / 日志 */
  bottomDrawerOpen: boolean;
  bottomDrawerHeight: number;
  /** 当前工作区；未选择时也可以直接对话 */
  workspace: WorkspaceInfo | null;
  setWorkspace: (workspace: WorkspaceInfo | null) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  setSessionsPanelOpen: (open: boolean) => void;
  setSessionsPanelWidth: (width: number) => void;
  setInspectorPanelOpen: (open: boolean) => void;
  setInspectorPanelWidth: (width: number) => void;
  setBottomDrawerOpen: (open: boolean) => void;
  setBottomDrawerHeight: (height: number) => void;
}

export const initialAppState = {
  sessionsPanelOpen: true,
  sessionsPanelWidth: LEFT_PANEL.initial,
  // 右栏默认收起：打开应用时只显示会话列表与对话区，需要时再展开
  inspectorPanelOpen: false,
  inspectorPanelWidth: RIGHT_PANEL.initial,
  bottomDrawerOpen: false,
  bottomDrawerHeight: BOTTOM_DRAWER.initial,
  workspace: null as WorkspaceInfo | null,
  permissionMode: "ask" as PermissionMode,
} satisfies Partial<AppState>;

const within = (limits: PanelLimits, value: number) =>
  Number.isFinite(value) ? clamp(value, limits.min, limits.max) : limits.initial;

export const useAppStore = create<AppState>()((set) => ({
  ...initialAppState,
  setWorkspace: (workspace) => set({ workspace }),
  setPermissionMode: (permissionMode) => set({ permissionMode }),
  setSessionsPanelOpen: (open) => set({ sessionsPanelOpen: open }),
  setSessionsPanelWidth: (width) => set({ sessionsPanelWidth: within(LEFT_PANEL, width) }),
  setInspectorPanelOpen: (open) => set({ inspectorPanelOpen: open }),
  setInspectorPanelWidth: (width) => set({ inspectorPanelWidth: within(RIGHT_PANEL, width) }),
  setBottomDrawerOpen: (open) => set({ bottomDrawerOpen: open }),
  setBottomDrawerHeight: (height) => set({ bottomDrawerHeight: within(BOTTOM_DRAWER, height) }),
}));
