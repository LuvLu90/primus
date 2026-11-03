import { beforeEach, describe, expect, it } from "vitest";
import { createInitialSessionsState, findTab, MAX_TABS, useSessionsStore } from "./sessions-store";

const store = () => useSessionsStore.getState();
const session = (n: number) => ({ path: `/s/${n}.jsonl`, id: `id-${n}`, workspace: "/w" });

describe("会话标签", () => {
  beforeEach(() => useSessionsStore.setState(createInitialSessionsState()));

  it("初始只有一个空标签；新会话复用尚未打开的空标签", () => {
    const [first] = store().tabs;
    store().newTab();
    expect(store().tabs).toHaveLength(1);
    expect(store().activeTabId).toBe(first?.id);
  });

  it("打开历史会话新建标签；再次打开同一会话切回原标签", () => {
    store().openSession(session(1));
    const opened = store().tabs.at(-1);
    expect(opened).toMatchObject({ sessionPath: "/s/1.jsonl", sessionId: "id-1", workspace: "/w" });
    expect(store().activeTabId).toBe(opened?.id);
    store().newTab();
    store().openSession(session(1));
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).toBe(opened?.id);
  });

  it("新会话打开后按会话 ID 与列表条目对上，之后新会话按钮新建标签", () => {
    const [first] = store().tabs;
    if (!first) throw new Error("缺少初始标签");
    store().markOpened(first.id, { sessionId: "primus-1", workspace: "" });
    expect(findTab(store().tabs, { path: "/s/x.jsonl", id: "primus-1" })?.id).toBe(first.id);
    expect(store().tabs[0]?.workspace).toBe("");
    store().newTab();
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).not.toBe(first.id);
  });

  it("关闭当前标签切到相邻标签；关掉最后一个换成新的空标签", () => {
    store().openSession(session(1));
    store().openSession(session(2));
    const [, a, b] = store().tabs;
    store().closeTab(b?.id ?? "");
    expect(store().activeTabId).toBe(a?.id);
    for (const tab of store().tabs) store().closeTab(tab.id);
    expect(store().tabs).toHaveLength(1);
    expect(store().tabs[0]?.sessionPath).toBeNull();
    // 关闭不存在的标签无影响
    const before = store().tabs;
    store().closeTab("nope");
    expect(store().tabs).toBe(before);
  });

  it("超出上限时关闭最早打开、不在当前也不在运行中的标签", () => {
    store().openSession(session(1));
    const running = store().activeTabId;
    store().setRunning(running, true);
    for (let i = 2; i <= MAX_TABS + 1; i++) store().openSession(session(i));
    const tabs = store().tabs;
    expect(tabs).toHaveLength(MAX_TABS);
    // 初始空标签最早且空闲，先被关掉；运行中的保留
    expect(tabs.some((t) => t.sessionPath === null)).toBe(false);
    expect(tabs.some((t) => t.id === running)).toBe(true);
  });

  it("运行状态不变时不产生新的标签数组", () => {
    const before = store().tabs;
    store().setRunning(before[0]?.id ?? "", false);
    expect(store().tabs).toBe(before);
    store().activate("nope");
    expect(store().activeTabId).toBe(before[0]?.id);
  });
});
