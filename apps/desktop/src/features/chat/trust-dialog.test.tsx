import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import type { WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { TrustDialog } from "./trust-dialog";

const t = strings.chat;
const ws: WorkspaceInfo = {
  path: "C:\\Users\\mock\\新项目",
  name: "新项目",
  trusted: false,
  needsTrust: true,
};

describe("项目信任确认", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("展示项目内容，选择信任后保存并返回已信任的工作区", async () => {
    const base = createMockPlatform();
    const workspaceTrust = vi.fn(async () => {});
    setPlatformForTesting({ ...base, workspaceTrust });
    const onDecided = vi.fn();
    render(<TrustDialog workspace={ws} onDecided={onDecided} onCancel={() => {}} />);

    expect(await screen.findByText(/guard\.ts/)).toBeTruthy();
    expect(screen.getByText(/review/)).toBeTruthy();
    expect(screen.getByText(/github/)).toBeTruthy();
    expect(screen.getByText(t.trustAgentsMd)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t.trustAccept }));
    await waitFor(() =>
      expect(onDecided).toHaveBeenCalledWith({ ...ws, trusted: true, needsTrust: false }),
    );
    expect(workspaceTrust).toHaveBeenCalledWith(ws.path, true, "mock");
  });

  it("读取项目内容失败时不能信任，但可以选择不信任", async () => {
    const base = createMockPlatform();
    const workspaceTrust = vi.fn(async () => {});
    setPlatformForTesting({
      ...base,
      workspaceTrust,
      workspaceInspect: async () => {
        throw new Error("拒绝访问");
      },
    });
    const onDecided = vi.fn();
    render(<TrustDialog workspace={ws} onDecided={onDecided} onCancel={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("拒绝访问");
    expect(
      (screen.getByRole("button", { name: t.trustAccept }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: t.trustReject }));
    await waitFor(() =>
      expect(onDecided).toHaveBeenCalledWith({ ...ws, trusted: false, needsTrust: false }),
    );
    expect(workspaceTrust).toHaveBeenCalledWith(ws.path, false, null);
  });

  it("内容无法完整读取（没有指纹）时只能不信任", async () => {
    const base = createMockPlatform();
    const details = await base.workspaceInspect(ws.path);
    setPlatformForTesting({
      ...base,
      workspaceInspect: async () => ({ ...details, fingerprint: null }),
    });
    render(<TrustDialog workspace={ws} onDecided={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText(t.trustIncomplete)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: t.trustAccept }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: t.trustReject }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("保存进行中按 Esc 不会取消", async () => {
    const base = createMockPlatform();
    let finish: () => void = () => {};
    setPlatformForTesting({
      ...base,
      workspaceTrust: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const onCancel = vi.fn();
    const onDecided = vi.fn();
    render(<TrustDialog workspace={ws} onDecided={onDecided} onCancel={onCancel} />);
    await screen.findByText(/guard\.ts/);
    fireEvent.click(screen.getByRole("button", { name: t.trustAccept }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: t.trustReject }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
  });

  it("保存失败时显示原因并重新读取内容，不关闭", async () => {
    const base = createMockPlatform();
    const workspaceInspect = vi.fn(base.workspaceInspect);
    setPlatformForTesting({
      ...base,
      workspaceInspect,
      workspaceTrust: async () => {
        throw new Error("磁盘已满");
      },
    });
    const onDecided = vi.fn();
    render(<TrustDialog workspace={ws} onDecided={onDecided} onCancel={() => {}} />);
    await screen.findByText(/guard\.ts/);
    fireEvent.click(screen.getByRole("button", { name: t.trustAccept }));
    expect((await screen.findByRole("alert")).textContent).toContain("磁盘已满");
    await waitFor(() => expect(workspaceInspect).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/guard\.ts/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("磁盘已满");
    expect(onDecided).not.toHaveBeenCalled();
  });
});
