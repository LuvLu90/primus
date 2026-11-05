import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Platform,
  PlatformError,
  setPlatformForTesting,
  UPDATE_BUSY,
  UPDATE_CANCELLED,
  type UpdateStatus,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { UpdatePrompt } from "./update-prompt";
import { resetUpdateStoreForTesting, useUpdateStore } from "./update-store";

const t = strings.update;

const base: UpdateStatus = {
  currentVersion: "0.0.6",
  available: true,
  installKind: "msi",
  settings: { autoUpdate: true, channel: "stable" },
  phase: "idle",
  progress: null,
  pending: null,
  lastCheck: null,
  lastError: null,
};
const ready: UpdateStatus = { ...base, pending: { version: "0.0.7", notes: null } };
const readyText = t.ready.replace("{version}", "0.0.7");

/** 注入只实现更新命令的平台；返回推送状态的函数 */
function usePlatform(initial: UpdateStatus, overrides: Partial<Platform> = {}) {
  let push: (s: UpdateStatus) => void = () => {};
  setPlatformForTesting({
    updateWatch: async (onChange: (s: UpdateStatus) => void) => {
      push = onChange;
      onChange(initial);
    },
    ...overrides,
  } as Platform);
  return (s: UpdateStatus) => act(() => push(s));
}

describe("更新下载完成提示", () => {
  afterEach(() => {
    setPlatformForTesting(undefined);
    resetUpdateStoreForTesting();
  });

  it("没有待装版本时不显示；下载完成推送后显示", async () => {
    const push = usePlatform(base);
    render(<UpdatePrompt />);
    await waitFor(() => expect(useUpdateStore.getState().status).not.toBeNull());
    expect(screen.queryByText(readyText)).toBeNull();
    push(ready);
    expect(screen.getByRole("status").textContent).toBe(readyText);
    expect(screen.getByRole("button", { name: t.restartNow })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.nextLaunch })).toBeTruthy();
  });

  it("下次启动时更新：本次运行不再提示同一版本", async () => {
    const push = usePlatform(ready);
    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: t.nextLaunch }));
    expect(screen.queryByText(readyText)).toBeNull();
    push({ ...ready });
    expect(screen.queryByText(readyText)).toBeNull();
    // 更新的版本再次提示
    push({ ...base, pending: { version: "0.0.8", notes: null } });
    expect(screen.getByText(t.ready.replace("{version}", "0.0.8"))).toBeTruthy();
  });

  it("立即重启更新：无运行中的 Agent 时直接安装", async () => {
    const updateInstall = vi.fn(async () => {});
    usePlatform(ready, { updateInstall });
    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: t.restartNow }));
    await waitFor(() => expect(updateInstall).toHaveBeenCalledWith(undefined));
    expect(screen.queryByText(t.busyTitle)).toBeNull();
  });

  it("有运行中的 Agent 时先确认，确认后带 force 安装", async () => {
    const updateInstall = vi.fn(async (force?: boolean) => {
      if (!force) throw new PlatformError("有正在运行的 Agent", UPDATE_BUSY);
    });
    usePlatform(ready, { updateInstall });
    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: t.restartNow }));
    expect(await screen.findByText(t.busyTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.busyConfirm }));
    await waitFor(() => expect(updateInstall).toHaveBeenLastCalledWith(true));
  });

  it("确认框取消时不安装", async () => {
    const updateInstall = vi.fn(async () => {
      throw new PlatformError("有正在运行的 Agent", UPDATE_BUSY);
    });
    usePlatform(ready, { updateInstall });
    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: t.restartNow }));
    fireEvent.click(await screen.findByRole("button", { name: t.cancel }));
    await waitFor(() => expect(screen.queryByText(t.busyTitle)).toBeNull());
    expect(updateInstall).toHaveBeenCalledTimes(1);
  });

  it("取消管理员授权时显示原因，提示保留", async () => {
    usePlatform(ready, {
      updateInstall: async () => {
        throw new PlatformError("已取消管理员授权。更新包已保留", UPDATE_CANCELLED);
      },
    });
    render(<UpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: t.restartNow }));
    expect((await screen.findByRole("alert")).textContent).toContain("已取消管理员授权");
    expect(screen.getByText(readyText)).toBeTruthy();
  });
});
