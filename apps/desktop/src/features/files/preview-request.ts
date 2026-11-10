// Agent 调用预览工具（primus-preview 的 `preview`）后，扩展经 setWidget("primus:preview") 请求在右栏打开文件 / 文件夹。
// 请求记在发起它的会话 store 里（previewRequest）；这里只在该会话的标签是当前标签时打开预览，
// 后台标签的请求先保留，切回该标签时再打开，不抢当前标签的右栏、不切换标签。
import type { PreviewData } from "@primus/protocol";
import { useEffect, useRef } from "react";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import { showPreview } from "./preview-store";

/**
 * 处理一个会话的预览请求：`request` 为该会话最近一次请求，`tabId` 为会话所在标签（没有标签时视为当前）。
 * 每个请求（按 id）只打开一次。
 */
export function usePreviewRequest(
  request: PreviewData | undefined,
  tabId: string | undefined,
): void {
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!request || handled.current === request.id) return;
    if (tabId !== undefined && tabId !== activeTabId) return;
    handled.current = request.id;
    showPreview(request.path);
  }, [request, tabId, activeTabId]);
}
