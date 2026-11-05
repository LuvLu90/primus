import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetUpdateStoreForTesting } from "@/features/update/update-store";
import {
  type Platform,
  PlatformError,
  setPlatformForTesting,
  type UpdateStatus,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { UpdateSettings, updateStateText } from "./update-settings";

const tu = strings.settings.update;

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

describe("设置·更新", () => {
  afterEach(() => {
    setPlatformForTesting(undefined);
    resetUpdateStoreForTesting();
  });

  it("显示当前版本，自动更新默认打开，通道为稳定版", async () => {
    usePlatform(base);
    render(<UpdateSettings />);
    expect(await screen.findByText("0.0.6")).toBeTruthy();
    expect((screen.getByRole("switch", { name: tu.autoUpdate }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(
      screen.getByRole("tab", { name: tu.channels.stable }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText(tu.unavailableHint)).toBeNull();
  });

  it("修改开关与通道写入设置", async () => {
    const updateSettingsSet = vi.fn(async (patch: Partial<UpdateStatus["settings"]>) => ({
      ...base,
      settings: { ...base.settings, ...patch },
    }));
    usePlatform(base, { updateSettingsSet });
    render(<UpdateSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: tu.autoUpdate }));
    await waitFor(() => expect(updateSettingsSet).toHaveBeenCalledWith({ autoUpdate: false }));
    await waitFor(() =>
      expect(
        (screen.getByRole("switch", { name: tu.autoUpdate }) as HTMLInputElement).checked,
      ).toBe(false),
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: tu.channels.beta }));
    await waitFor(() => expect(updateSettingsSet).toHaveBeenLastCalledWith({ channel: "beta" }));
  });

  it("立即检查：没有新版本时显示已是最新", async () => {
    const updateCheck = vi.fn(async () => ({ ...base, lastCheck: 1 }));
    usePlatform(base, { updateCheck });
    render(<UpdateSettings />);
    fireEvent.click(await screen.findByRole("button", { name: tu.checkNow }));
    expect(await screen.findByText(tu.upToDate)).toBeTruthy();
    expect(updateCheck).toHaveBeenCalled();
  });

  it("检查失败显示原因", async () => {
    usePlatform(base, {
      updateCheck: async () => {
        throw new PlatformError("网络不可用", "failed");
      },
    });
    render(<UpdateSettings />);
    fireEvent.click(await screen.findByRole("button", { name: tu.checkNow }));
    expect((await screen.findByRole("alert")).textContent).toContain("网络不可用");
  });

  it("下载进度与待装版本；有待装版本时可立即重启更新", async () => {
    const updateInstall = vi.fn(async () => {});
    const push = usePlatform(base, { updateInstall });
    render(<UpdateSettings />);
    await screen.findByText("0.0.6");
    push({ ...base, phase: "downloading", progress: { downloaded: 50, total: 200 } });
    expect(screen.getByText(tu.downloadingPercent.replace("{n}", "25"))).toBeTruthy();
    expect((screen.getByRole("button", { name: tu.checkNow }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    push({ ...base, pending: { version: "0.0.7", notes: null } });
    const ready = tu.pendingReady.replace("{version}", "0.0.7");
    expect(screen.getAllByText(ready).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: strings.update.restartNow }));
    await waitFor(() => expect(updateInstall).toHaveBeenCalled());
  });

  it("未启用自动更新的构建：说明原因并禁用立即检查", async () => {
    usePlatform({ ...base, available: false });
    render(<UpdateSettings />);
    expect(await screen.findByText(tu.unavailableHint)).toBeTruthy();
    expect((screen.getByRole("button", { name: tu.checkNow }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("状态说明文案", () => {
    expect(updateStateText({ ...base, phase: "checking" }, false)).toBe(tu.checking);
    expect(updateStateText({ ...base, phase: "downloading" }, false)).toBe(tu.downloading);
    expect(updateStateText({ ...base, lastError: "超时" }, false)).toBe(
      tu.lastError.replace("{message}", "超时"),
    );
    expect(updateStateText(base, false)).toBeNull();
    expect(updateStateText(base, true)).toBe(tu.upToDate);
  });
});
