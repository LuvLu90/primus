import { create } from "zustand";
import type { SessionSummary } from "@/lib/platform/types";

// 多会话（第 10.1、16.2 节，ADR 0006）：每个打开的会话是一个标签，中央区为每个标签挂一个 ChatPanel，
// 非当前标签隐藏而不卸载（Core 进程与时间线都保留）。这里只记标签本身，会话内容在各自的会话 store。

/** 同时挂载的标签上限；超出时关闭最早打开、不在当前、也不在运行中的标签 */
export const MAX_TABS = 8;

export interface ChatTab {
  id: string;
  /** 打开的历史会话文件；新会话为 null（首次发送时由薄壳新建） */
  sessionPath: string | null;
  /** 新会话打开后薄壳给出的会话 ID，用来把会话列表中的条目与这个标签对上 */
  sessionId: string | null;
  /** 会话的工作区：历史会话取索引中的工作区，新会话在打开时锁定；null 表示尚未确定 */
  workspace: string | null;
  /** 正在运行（agent_start 到 agent_settled）：不会因标签上限被关闭 */
  running: boolean;
}

export interface SessionsState {
  tabs: ChatTab[];
  activeTabId: string;
  /** 新会话：已有尚未打开的空标签时直接切到它，否则新建 */
  newTab: () => void;
  /** 打开历史会话：已在某个标签中则切过去，否则新建标签 */
  openSession: (session: Pick<SessionSummary, "path" | "id" | "workspace">) => void;
  activate: (tabId: string) => void;
  /** 关闭标签（卸载其 ChatPanel，随之关闭会话）；关掉最后一个时换成一个新的空标签 */
  closeTab: (tabId: string) => void;
  /** 会话已打开：记下会话 ID 与工作区 */
  markOpened: (tabId: string, opened: { sessionId: string | null; workspace: string }) => void;
  setRunning: (tabId: string, running: boolean) => void;
}

let nextTab = 1;
const newTabState = (): ChatTab => ({
  id: `tab-${nextTab++}`,
  sessionPath: null,
  sessionId: null,
  workspace: null,
  running: false,
});

/** 列表条目对应的标签（按会话文件路径或会话 ID） */
export function findTab(
  tabs: readonly ChatTab[],
  session: Pick<SessionSummary, "path" | "id">,
): ChatTab | undefined {
  return tabs.find(
    (t) =>
      (t.sessionPath !== null && t.sessionPath === session.path) ||
      (t.sessionId !== null && t.sessionId === session.id),
  );
}

/** 超出上限时去掉最早打开、不在当前、不在运行中的标签 */
function trim(tabs: ChatTab[], activeTabId: string): ChatTab[] {
  const result = tabs.slice();
  while (result.length > MAX_TABS) {
    const i = result.findIndex((t) => t.id !== activeTabId && !t.running);
    if (i < 0) break;
    result.splice(i, 1);
  }
  return result;
}

const isBlank = (t: ChatTab) => t.sessionPath === null && t.sessionId === null;

export function createInitialSessionsState(): Pick<SessionsState, "tabs" | "activeTabId"> {
  const first = newTabState();
  return { tabs: [first], activeTabId: first.id };
}

export const useSessionsStore = create<SessionsState>()((set, get) => ({
  ...createInitialSessionsState(),

  newTab: () => {
    const blank = get().tabs.find(isBlank);
    if (blank) {
      set({ activeTabId: blank.id });
      return;
    }
    const tab = newTabState();
    set((s) => ({ tabs: trim([...s.tabs, tab], tab.id), activeTabId: tab.id }));
  },

  openSession: (session) => {
    const existing = findTab(get().tabs, session);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const tab: ChatTab = {
      ...newTabState(),
      sessionPath: session.path,
      sessionId: session.id,
      workspace: session.workspace,
    };
    set((s) => ({ tabs: trim([...s.tabs, tab], tab.id), activeTabId: tab.id }));
  },

  activate: (tabId) => {
    if (get().tabs.some((t) => t.id === tabId)) set({ activeTabId: tabId });
  },

  closeTab: (tabId) =>
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === tabId);
      if (i < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      if (tabs.length === 0) {
        const blank = newTabState();
        return { tabs: [blank], activeTabId: blank.id };
      }
      // 关掉当前标签时切到它右边的标签（没有则左边）
      const neighbor = tabs[Math.min(i, tabs.length - 1)];
      const activeTabId = s.activeTabId === tabId && neighbor ? neighbor.id : s.activeTabId;
      return { tabs, activeTabId };
    }),

  markOpened: (tabId, { sessionId, workspace }) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, sessionId: t.sessionId ?? sessionId, workspace } : t,
      ),
    })),

  setRunning: (tabId, running) =>
    set((s) =>
      s.tabs.some((t) => t.id === tabId && t.running !== running)
        ? { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, running } : t)) }
        : s,
    ),
}));
