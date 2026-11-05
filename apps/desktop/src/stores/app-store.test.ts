import { beforeEach, describe, expect, it } from "vitest";
import { BOTTOM_DRAWER, LEFT_PANEL, RIGHT_PANEL } from "@/components/layout/panel-layout";
import { initialAppState, useAppStore } from "./app-store";

describe("全局 store", () => {
  beforeEach(() => useAppStore.setState(initialAppState));

  it("默认只显示左栏（232px），右栏与底部抽屉收起", () => {
    const s = useAppStore.getState();
    expect(s.sessionsPanelOpen).toBe(true);
    expect(s.inspectorPanelOpen).toBe(false);
    expect(s.sessionsPanelWidth).toBe(232);
    expect(s.bottomDrawerOpen).toBe(false);
  });

  it("尺寸按各栏上下限夹住，非数值恢复默认", () => {
    const s = useAppStore.getState();
    s.setSessionsPanelWidth(10);
    expect(useAppStore.getState().sessionsPanelWidth).toBe(LEFT_PANEL.min);
    s.setInspectorPanelWidth(99999);
    expect(useAppStore.getState().inspectorPanelWidth).toBe(RIGHT_PANEL.max);
    s.setBottomDrawerHeight(Number.NaN);
    expect(useAppStore.getState().bottomDrawerHeight).toBe(BOTTOM_DRAWER.initial);
    s.setBottomDrawerHeight(333.6);
    expect(useAppStore.getState().bottomDrawerHeight).toBe(334);
  });

  it("可以分别收起左栏、展开和收起右栏", () => {
    useAppStore.getState().setSessionsPanelOpen(false);
    expect(useAppStore.getState().sessionsPanelOpen).toBe(false);
    expect(useAppStore.getState().inspectorPanelOpen).toBe(false);

    useAppStore.getState().setInspectorPanelOpen(true);
    expect(useAppStore.getState().inspectorPanelOpen).toBe(true);
    useAppStore.getState().setInspectorPanelOpen(false);
    expect(useAppStore.getState().inspectorPanelOpen).toBe(false);
  });
});
