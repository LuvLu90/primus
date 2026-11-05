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

  it("打开会话文件的标签只按路径匹配：复制出的会话（文件头 ID 相同）在新标签中打开", () => {
    store().openSession(session(1));
    const original = store().activeTabId;
    const copy = { path: "/s/copy.jsonl", id: "id-1", workspace: "/w" };
    expect(findTab(store().tabs, copy)).toBeUndefined();
    expect(store().openSession(copy)).toBe(true);
    expect(store().activeTabId).not.toBe(original);
    expect(store().tabs.find((t) => t.id === store().activeTabId)?.sessionPath).toBe(
      "/s/copy.jsonl",
    );
  });

  it("正在打开的新会话标签不算空标签：新会话按钮新建标签", () => {
    const [first] = store().tabs;
    if (!first) throw new Error("缺少初始标签");
    store().setOpening(first.id, true);
    expect(store().newTab()).toBe(true);
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).not.toBe(first.id);
    // 打开失败（结束打开中、仍没有会话 ID）后重新算作空标签
    store().setOpening(first.id, false);
    store().activate(first.id);
    store().closeTab(store().tabs[1]?.id ?? "");
    expect(store().newTab()).toBe(true);
    expect(store().tabs).toHaveLength(1);
  });

  it("标签已满且都在运行中时不再新增标签", () => {
    for (let i = 1; i <= MAX_TABS; i++) {
      store().openSession(session(i));
      store().setRunning(store().activeTabId, true);
    }
    // 初始空标签已被修剪掉，剩下的全部运行中
    expect(store().tabs).toHaveLength(MAX_TABS);
    expect(store().tabs.every((t) => t.running)).toBe(true);
    const active = store().activeTabId;
    expect(store().openSession(session(MAX_TABS + 1))).toBe(false);
    expect(store().newTab()).toBe(false);
    expect(store().tabs).toHaveLength(MAX_TABS);
    expect(store().activeTabId).toBe(active);
    // 已打开的会话仍可切换
    expect(store().openSession(session(1))).toBe(true);
  });

  it("新建或打开因标签已满被拒绝时记下提示；成功打开、关闭标签或有标签结束运行时清除", () => {
    for (let i = 1; i <= MAX_TABS; i++) {
      store().openSession(session(i));
      store().setRunning(store().activeTabId, true);
    }
    expect(store().tabsFull).toBe(false);
    expect(store().newTab()).toBe(false);
    expect(store().tabsFull).toBe(true);
    // 切到已打开的会话成功：提示清除
    expect(store().openSession(session(1))).toBe(true);
    expect(store().tabsFull).toBe(false);

    expect(store().openSession(session(MAX_TABS + 1))).toBe(false);
    expect(store().tabsFull).toBe(true);
    // 仍在运行的状态再设一次不清除
    store().setRunning(store().tabs[0]?.id ?? "", true);
    expect(store().tabsFull).toBe(true);
    store().setRunning(store().tabs[0]?.id ?? "", false);
    expect(store().tabsFull).toBe(false);

    store().setRunning(store().tabs[0]?.id ?? "", true);
    expect(store().newTab()).toBe(false);
    expect(store().tabsFull).toBe(true);
    store().closeTab(store().tabs[1]?.id ?? "");
    expect(store().tabsFull).toBe(false);
  });

  it("运行状态不变时不产生新的标签数组", () => {
    const before = store().tabs;
    store().setRunning(before[0]?.id ?? "", false);
    expect(store().tabs).toBe(before);
    store().activate("nope");
    expect(store().activeTabId).toBe(before[0]?.id);
  });
});

describe("tabsForDeletion", () => {
  it("按路径或会话 ID 找出要关掉的标签", async () => {
    const { tabsForDeletion } = await import("./sessions-store");
    const tab = (id: string, sessionPath: string | null, sessionId: string | null) =>
      ({ id, sessionPath, sessionId }) as Parameters<typeof tabsForDeletion>[0][number];
    const tabs = [
      tab("a", "/s/a.jsonl", "1"),
      tab("b", "/s/link.jsonl", "1"),
      tab("c", "/s/c.jsonl", "2"),
    ];
    expect(tabsForDeletion(tabs, { path: "/s/a.jsonl", id: "1" }).map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
