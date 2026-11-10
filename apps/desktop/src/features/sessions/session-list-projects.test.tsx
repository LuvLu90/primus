import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Platform, type SessionSummary, setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { SessionList } from "./session-list";
import { initialSessionListPrefs, useSessionListPrefs } from "./session-list-prefs";
import { createInitialSessionsState, useSessionsStore } from "./sessions-store";

// 左栏项目行的“项目操作”菜单：置顶、编辑、归档聊天、移除项目，以及展开状态的本地保存
const t = strings.sessions;
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);
const A = "D:\\code\\alpha";
const B = "D:\\code\\beta";

const summary = (n: number, workspace: string, extra: Partial<SessionSummary> = {}) => ({
  path: `/data/sessions/${n}.jsonl`,
  id: `id-${n}`,
  name: null,
  title: `第 ${n} 个会话`,
  workspace,
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - n * 60_000,
  messageCount: 2,
  archived: false,
  ...extra,
});

function withIndex(overrides: Partial<Platform>) {
  const platform = { ...createMockPlatform(), ...overrides };
  setPlatformForTesting(platform);
  return platform;
}

const twoProjects = () =>
  withIndex({
    sessionList: async () => ({ items: [summary(1, A), summary(2, B), summary(3, A)] }),
  });

/** 打开某个项目的“项目操作”菜单并点其中一项 */
async function projectMenu(name: string, item: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `${t.projectActions}：${name}` }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** 项目行按显示顺序的名称（项目行与“项目”分组标题带 aria-expanded；菜单按钮另有 aria-haspopup） */
const projectNames = () =>
  [...document.querySelectorAll("button[aria-expanded]:not([aria-haspopup])")]
    .map((b) => b.textContent)
    .filter((x) => x !== t.projects);

/** 只清内存中的偏好（setState 会顺带写回本地存储，先存下再放回去） */
function resetMemoryOnly() {
  const saved = localStorage.getItem("primus.sessionList");
  useSessionListPrefs.setState(initialSessionListPrefs);
  if (saved !== null) localStorage.setItem("primus.sessionList", saved);
}

describe("项目操作", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(640);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(232);
    useSessionsStore.setState(createInitialSessionsState());
    localStorage.clear();
    useSessionListPrefs.setState(initialSessionListPrefs);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setPlatformForTesting(undefined);
  });

  it("菜单分组：置顶、编辑 / 在资源管理器中打开 / 归档聊天 / 移除项目", async () => {
    twoProjects();
    render(<SessionList />);
    fireEvent.keyDown(await screen.findByRole("button", { name: `${t.projectActions}：alpha` }), {
      key: "Enter",
    });
    await screen.findByRole("menuitem", { name: t.pinProject });
    expect(screen.getAllByRole("menuitem").map((x) => x.textContent)).toEqual([
      t.pinProject,
      t.editProject,
      t.revealProject,
      t.archiveProject,
      t.removeProject,
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(3);
  });

  it("置顶：项目排到最前并显示标记，再点取消置顶；保存在本地", async () => {
    twoProjects();
    render(<SessionList />);
    await screen.findByRole("button", { name: "alpha" });
    expect(projectNames()).toEqual(["alpha", "beta"]);
    await projectMenu("beta", t.pinProject);
    await waitFor(() => expect(projectNames()).toEqual(["beta", "alpha"]));
    expect(screen.getByRole("img", { name: t.pinned })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("primus.sessionList") ?? "{}").state.pinned).toEqual([
      "d:/code/beta",
    ]);
    await projectMenu("beta", t.unpinProject);
    await waitFor(() => expect(projectNames()).toEqual(["alpha", "beta"]));
    expect(screen.queryByRole("img", { name: t.pinned })).toBeNull();
  });

  it("编辑：改显示名称，留空恢复为文件夹名", async () => {
    twoProjects();
    render(<SessionList />);
    await projectMenu("alpha", t.editProject);
    const dialog = await screen.findByRole("dialog", { name: t.editTitle });
    const input = screen.getByRole("textbox", { name: t.editName });
    expect(input.getAttribute("placeholder")).toBe("alpha");
    fireEvent.change(input, { target: { value: "  阿尔法  " } });
    fireEvent.click(screen.getByRole("button", { name: t.save }));
    expect(await screen.findByRole("button", { name: "阿尔法" })).toBeTruthy();
    expect(dialog.isConnected).toBe(false);

    await projectMenu("阿尔法", t.editProject);
    const again = await screen.findByRole("textbox", { name: t.editName });
    expect((again as HTMLInputElement).value).toBe("阿尔法");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.submit(again);
    expect(await screen.findByRole("button", { name: "alpha" })).toBeTruthy();
  });

  it("归档聊天：确认后归档该项目全部会话（含未加载的后续页），不动别的项目", async () => {
    const sessionArchive = vi.fn(async () => {});
    const sessionList = vi.fn(async (workspace: string | null, cursor?: string) => {
      if (workspace === A)
        return cursor
          ? { items: [summary(9, A)] }
          : { items: [summary(1, A), summary(3, A)], nextCursor: "next" };
      return { items: [summary(1, A), summary(2, B), summary(3, A)] };
    });
    withIndex({ sessionList, sessionArchive });
    render(<SessionList />);
    await projectMenu("alpha", t.archiveProject);
    expect(
      await screen.findByRole("dialog", {
        name: t.archiveProjectTitle.replace("{name}", "alpha"),
      }),
    ).toBeTruthy();
    expect(sessionArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: t.archiveProjectConfirm }));
    await waitFor(() => expect(sessionArchive).toHaveBeenCalledTimes(3));
    expect(sessionArchive.mock.calls.map((c) => (c as unknown[])[0]).sort()).toEqual([
      "/data/sessions/1.jsonl",
      "/data/sessions/3.jsonl",
      "/data/sessions/9.jsonl",
    ]);
    expect(sessionList).toHaveBeenCalledWith(A, "next");
  });

  it("归档聊天部分失败时报出失败个数与原因", async () => {
    const sessionArchive = vi.fn(async (path: string) => {
      if (path.endsWith("3.jsonl")) throw new Error("会话不在索引中");
    });
    withIndex({
      sessionList: async () => ({ items: [summary(1, A), summary(3, A)] }),
      sessionArchive,
    });
    render(<SessionList />);
    await projectMenu("alpha", t.archiveProject);
    fireEvent.click(await screen.findByRole("button", { name: t.archiveProjectConfirm }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("1");
    expect(alert.textContent).toContain("会话不在索引中");
  });

  it("移除项目：从左栏隐藏（会话不删除）；之后有新活动时重新出现", async () => {
    let items = [summary(1, A), summary(2, B)];
    const platform = withIndex({ sessionList: async () => ({ items }) });
    const sessionDelete = vi.spyOn(platform, "sessionDelete");
    const { unmount } = render(<SessionList />);
    await projectMenu("beta", t.removeProject);
    await waitFor(() => expect(screen.queryByRole("button", { name: "beta" })).toBeNull());
    expect(screen.getByRole("button", { name: "alpha" })).toBeTruthy();
    expect(sessionDelete).not.toHaveBeenCalled();
    unmount();

    // 移除之后在该文件夹里又对话了：项目回到列表
    items = [summary(2, B, { updatedAt: NOW + 60_000 }), summary(1, A)];
    render(<SessionList />);
    expect(await screen.findByRole("button", { name: "beta" })).toBeTruthy();
  });

  it("展开 / 折叠状态与“项目”分组的收起保存在本地，重新打开后恢复", async () => {
    twoProjects();
    const { unmount } = render(<SessionList />);
    fireEvent.click(await screen.findByRole("button", { name: "alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "beta" }).getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
    unmount();

    // 内存中的状态清掉，只靠本地存储恢复
    resetMemoryOnly();
    const second = render(<SessionList />);
    const alpha = await screen.findByRole("button", { name: "alpha" });
    await waitFor(() => expect(alpha.getAttribute("aria-expanded")).toBe("false"));
    expect(screen.getByRole("button", { name: "beta" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: t.projects }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "alpha" })).toBeNull());
    second.unmount();

    resetMemoryOnly();
    render(<SessionList />);
    await screen.findByRole("button", { name: t.projects });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t.projects }).getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );
    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
  });

  it("运行中：会话行显示转圈图标；项目折叠时项目行也显示，展开后只在会话行", async () => {
    twoProjects();
    useSessionsStore.setState({
      tabs: [
        {
          id: "tab-run",
          sessionPath: "/data/sessions/3.jsonl",
          sessionId: "id-3",
          workspace: A,
          running: true,
          opening: false,
        },
      ],
      activeTabId: "tab-run",
    });
    render(<SessionList />);
    const alpha = await screen.findByRole("button", { name: /^alpha/ });
    // 当前标签所在的项目默认展开：转圈在会话行上
    await waitFor(() => expect(alpha.getAttribute("aria-expanded")).toBe("true"));
    // 只有运行中的那个会话行有转圈（别的会话、项目行都没有）
    const spinners = () => screen.queryAllByRole("img", { name: t.running });
    expect(spinners().map((x) => x.closest("button")?.textContent)).toEqual(["第 3 个会话"]);

    fireEvent.click(alpha);
    await waitFor(() => expect(alpha.getAttribute("aria-expanded")).toBe("false"));
    expect(spinners().map((x) => x.closest("button"))).toEqual([alpha]);
    // 转圈只是图标：带动画类，减少动态效果时由样式停住
    expect(within(alpha).getByRole("img", { name: t.running }).getAttribute("class")).toContain(
      "session-spinner",
    );
  });
});
