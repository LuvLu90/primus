import type { PreviewData } from "@primus/protocol";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createInitialSessionsState, useSessionsStore } from "@/features/sessions/sessions-store";
import { useAppStore } from "@/stores/app-store";
import { usePreviewRequest } from "./preview-request";
import { usePreviewStore } from "./preview-store";

const req = (id: string, path: string): PreviewData => ({ id, path, kind: "text" });
const setActive = (activeTabId: string) => useSessionsStore.setState({ activeTabId });

describe("Agent 的预览请求", () => {
  beforeEach(() => {
    useSessionsStore.setState(createInitialSessionsState());
    usePreviewStore.setState({ path: null, seq: 0 });
    useAppStore.getState().setInspectorPanelOpen(false);
    setActive("a");
  });

  it("当前标签：在右栏打开（右栏收起时展开），同一请求只打开一次", () => {
    const { rerender } = renderHook(({ r }) => usePreviewRequest(r, "a"), {
      initialProps: { r: req("1", "/w/x.md") },
    });
    expect(usePreviewStore.getState().path).toBe("/w/x.md");
    expect(useAppStore.getState().inspectorPanelOpen).toBe(true);
    const seq = usePreviewStore.getState().seq;
    rerender({ r: req("1", "/w/x.md") });
    expect(usePreviewStore.getState().seq).toBe(seq);
    // 同一路径的新请求重新打开（文件可能已改写）
    rerender({ r: req("2", "/w/x.md") });
    expect(usePreviewStore.getState().seq).toBe(seq + 1);
  });

  it("后台标签：不动当前标签的右栏，切回该标签时再打开", () => {
    usePreviewStore.setState({ path: "/w/current.ts", seq: 5 });
    renderHook(() => usePreviewRequest(req("1", "/w/bg.md"), "b"));
    expect(usePreviewStore.getState().path).toBe("/w/current.ts");
    expect(useSessionsStore.getState().activeTabId).toBe("a");
    act(() => setActive("b"));
    expect(usePreviewStore.getState().path).toBe("/w/bg.md");
    // 再切走、切回不重复打开
    act(() => setActive("a"));
    usePreviewStore.setState({ path: "/w/other.ts" });
    act(() => setActive("b"));
    expect(usePreviewStore.getState().path).toBe("/w/other.ts");
  });

  it("没有请求时什么也不做", () => {
    renderHook(() => usePreviewRequest(undefined, "a"));
    expect(usePreviewStore.getState().path).toBeNull();
  });
});
