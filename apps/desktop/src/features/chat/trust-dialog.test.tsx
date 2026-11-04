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
    expect(workspaceTrust).toHaveBeenCalledWith(ws.path, true);
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
    expect(workspaceTrust).toHaveBeenCalledWith(ws.path, false);
  });

  it("保存失败时显示原因，不关闭", async () => {
    const base = createMockPlatform();
    setPlatformForTesting({
      ...base,
      workspaceTrust: async () => {
        throw new Error("磁盘已满");
      },
    });
    const onDecided = vi.fn();
    render(<TrustDialog workspace={ws} onDecided={onDecided} onCancel={() => {}} />);
    await screen.findByText(/guard\.ts/);
    fireEvent.click(screen.getByRole("button", { name: t.trustAccept }));
    expect((await screen.findByRole("alert")).textContent).toContain("磁盘已满");
    expect(onDecided).not.toHaveBeenCalled();
  });
});
