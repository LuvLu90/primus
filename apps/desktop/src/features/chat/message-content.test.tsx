import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("不渲染图片，避免加载远程资源", () => {
    expect(renderMarkdown("![x](https://example.com/a.png)")).not.toContain("<img");
  });
});
