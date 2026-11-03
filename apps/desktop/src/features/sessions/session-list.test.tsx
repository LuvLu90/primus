import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, type SessionSummary, setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { relativeTime, SessionList } from "./session-list";
import { createInitialSessionsState, useSessionsStore } from "./sessions-store";

const t = strings.sessions;
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);

const summary = (n: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  path: `/data/sessions/${n}.jsonl`,
  id: `id-${n}`,
  name: null,
  title: `第 ${n} 个会话`,
  workspace: "/w",
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - n * 60_000,
  messageCount: 2,
  archived: false,
  ...extra,
});

/** 在 mock 平台上替换会话索引相关命令 */
function withIndex(overrides: Partial<Platform>) {
  const platform = { ...createMockPlatform(), ...overrides };
  setPlatformForTesting(platform);
  return platform;
}

describe("会话列表", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // jsdom 没有布局：给滚动容器一个可见高度，虚拟列表才会渲染行
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(640);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(232);
    useSessionsStore.setState(createInitialSessionsState());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPlatformForTesting(undefined);
  });

  it("列出会话（会话名优先，其次首条消息），点击在新标签中打开", async () => {
    withIndex({
      sessionList: async () => ({
        items: [summary(1, { name: "登录排查" }), summary(2), summary(3, { title: "" })],
      }),
    });
    render(<SessionList />);
    expect(await screen.findByRole("button", { name: /^登录排查/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^第 2 个会话/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`^${t.untitled}`) })).toBeTruthy();
    expect(screen.getByText("1 分钟前")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^第 2 个会话/ }));
    const { tabs, activeTabId } = useSessionsStore.getState();
    expect(tabs.find((x) => x.id === activeTabId)?.sessionPath).toBe("/data/sessions/2.jsonl");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^第 2 个会话/ }).getAttribute("aria-current"),
      ).toBe("true"),
    );
  });

  it("没有会话时显示空状态；加载失败时显示错误并可重试", async () => {
    let fail = true;
    const sessionList = vi.fn(async () => {
      if (fail) throw new Error("索引不可用");
      return { items: [] };
    });
    withIndex({ sessionList });
    render(<SessionList />);
    expect((await screen.findByRole("alert")).textContent).toContain("索引不可用");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    expect(await screen.findByText(t.empty)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("索引变化时重新拉取列表", async () => {
    let listener: (() => void) | undefined;
    let items = [summary(1)];
    withIndex({
      sessionList: async () => ({ items }),
      sessionWatch: async (cb) => {
        listener = () => cb({ seq: 1 });
      },
    });
    render(<SessionList />);
    await screen.findByRole("button", { name: /^第 1 个会话/ });
    items = [summary(5), summary(1)];
    await waitFor(() => expect(listener).toBeDefined());
    act(() => listener?.());
    expect(await screen.findByRole("button", { name: /^第 5 个会话/ })).toBeTruthy();
  });

  it("滚到列表末尾附近时加载下一页，按路径去重", async () => {
    const sessionList = vi.fn(async (_ws: string | null, cursor?: string) =>
      cursor
        ? { items: [summary(5), summary(6)] }
        : { items: [1, 2, 3, 4, 5].map((n) => summary(n)), nextCursor: "c1" },
    );
    withIndex({ sessionList });
    render(<SessionList />);
    expect(await screen.findByRole("button", { name: /^第 6 个会话/ })).toBeTruthy();
    expect(sessionList).toHaveBeenCalledWith(null, "c1");
    expect(screen.getAllByRole("button", { name: /^第 5 个会话/ })).toHaveLength(1);
  });

  it("搜索：输入后显示搜索结果（含已归档），清空后回到列表", async () => {
    const sessionSearch = vi.fn(async () => [summary(9, { archived: true, title: "数据库迁移" })]);
    withIndex({ sessionList: async () => ({ items: [summary(1)] }), sessionSearch });
    render(<SessionList />);
    await screen.findByRole("button", { name: /^第 1 个会话/ });
    const box = screen.getByRole("searchbox", { name: strings.layout.searchSessions });
    fireEvent.change(box, { target: { value: "迁移" } });
    expect(await screen.findByRole("button", { name: /^数据库迁移/ })).toBeTruthy();
    expect(screen.getByText(`· ${t.archived}`)).toBeTruthy();
    expect(sessionSearch).toHaveBeenCalledWith(null, "迁移");
    expect(screen.getByRole("list", { name: t.searchResults })).toBeTruthy();

    sessionSearch.mockResolvedValueOnce([]);
    fireEvent.change(box, { target: { value: "没有的词" } });
    expect(await screen.findByText(t.noResults)).toBeTruthy();
    fireEvent.change(box, { target: { value: "" } });
    expect(await screen.findByRole("button", { name: /^第 1 个会话/ })).toBeTruthy();
  });

  it("删除前确认，确认后移到回收站；打开中的会话不能删除", async () => {
    const sessionDelete = vi.fn(async () => {});
    withIndex({ sessionList: async () => ({ items: [summary(1), summary(2)] }), sessionDelete });
    useSessionsStore.getState().openSession(summary(2));
    render(<SessionList />);
    await screen.findByRole("button", { name: /^第 1 个会话/ });

    // 打开中的会话：删除项禁用，提供关闭
    fireEvent.keyDown(screen.getByRole("button", { name: `${t.moreActions}：第 2 个会话` }), {
      key: "Enter",
    });
    expect(
      (await screen.findByRole("menuitem", { name: t.delete })).getAttribute("data-disabled"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: t.closeTab }));
    expect(useSessionsStore.getState().tabs.some((x) => x.sessionPath)).toBe(false);

    fireEvent.keyDown(screen.getByRole("button", { name: `${t.moreActions}：第 1 个会话` }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.delete }));
    expect(await screen.findByRole("dialog", { name: t.deleteTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.deleteConfirm }));
    await waitFor(() => expect(sessionDelete).toHaveBeenCalledWith("/data/sessions/1.jsonl"));
  });

  it("归档与删除失败时显示原因", async () => {
    const sessionArchive = vi.fn(async () => {
      throw new Error("会话不在索引中");
    });
    withIndex({ sessionList: async () => ({ items: [summary(1)] }), sessionArchive });
    render(<SessionList />);
    fireEvent.keyDown(
      await screen.findByRole("button", { name: `${t.moreActions}：第 1 个会话` }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: t.archive }));
    expect((await screen.findByRole("alert")).textContent).toContain("会话不在索引中");
    expect(sessionArchive).toHaveBeenCalledWith("/data/sessions/1.jsonl", true);
  });
});

describe("相对时间", () => {
  it("按分钟、小时、天显示，超过 30 天显示日期", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    expect(relativeTime(now - 10_000, now)).toBe(t.justNow);
    expect(relativeTime(now + 10_000, now)).toBe(t.justNow);
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
    expect(relativeTime(Date.UTC(2026, 0, 5, 12), now)).toBe("2026-01-05");
  });
});
