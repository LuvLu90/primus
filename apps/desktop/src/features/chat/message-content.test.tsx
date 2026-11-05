import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { MarkdownText, renderMarkdown } from "./message-content";

const t = strings.chat;

describe("回复中的链接", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("点击 https 链接先确认，确认后交给系统浏览器打开", async () => {
    const openExternal = vi.fn(async () => {});
    setPlatformForTesting({ ...createMockPlatform(), openExternal });
    render(<MarkdownText text="看 [文档](https://example.com/doc)" streaming={false} />);
    fireEvent.click(screen.getByRole("link", { name: "文档" }));
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: t.linkOpen }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://example.com/doc"));
    await waitFor(() => expect(screen.queryByRole("button", { name: t.linkOpen })).toBeNull());
  });

  it("取消时不打开", async () => {
    const openExternal = vi.fn(async () => {});
    setPlatformForTesting({ ...createMockPlatform(), openExternal });
    render(<MarkdownText text="https://example.com" streaming={false} />);
    fireEvent.click(screen.getByRole("link"));
    fireEvent.click(await screen.findByRole("button", { name: t.linkCancel }));
    await waitFor(() => expect(screen.queryByRole("button", { name: t.linkOpen })).toBeNull());
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("离开主页（路由后退等）时关闭确认框", async () => {
    setPlatformForTesting(createMockPlatform());
    const view = render(<MarkdownText text="https://example.com" streaming={false} />);
    fireEvent.click(screen.getByRole("link"));
    expect(await screen.findByRole("button", { name: t.linkOpen })).toBeTruthy();
    vi.mocked(usePathname).mockReturnValue("/settings");
    // 组件是 memo：真实环境里 usePathname 走路由上下文会触发重渲染，这里换一下 props 代替
    view.rerender(<MarkdownText text="https://example.com " streaming={false} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: t.linkOpen })).toBeNull());
  });

  it("不渲染图片，避免加载远程资源", () => {
    expect(renderMarkdown("![x](https://example.com/a.png)")).not.toContain("<img");
  });
});
