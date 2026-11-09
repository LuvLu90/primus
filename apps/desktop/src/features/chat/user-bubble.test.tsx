import { appendFileTags } from "@primus/protocol";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";
import { COPIED_MS } from "./copy-button";
import { UserBubble } from "./user-bubble";

const t = strings.chat;

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("用户消息的复制按钮", () => {
  it("复制正文，图标与名称换成“已复制”，约 1.5 秒后恢复", async () => {
    vi.useFakeTimers();
    render(<UserBubble index={0} text={"第一行\n第二行"} />);
    const bubble = screen.getByRole("article", { name: t.you });
    const button = within(bubble).getByRole("button", { name: t.copy });
    expect(button.getAttribute("title")).toBe(t.copy);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("第一行\n第二行");
    expect(within(bubble).getByRole("button", { name: t.copied }).getAttribute("title")).toBe(
      t.copied,
    );
    act(() => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(within(bubble).getByRole("button", { name: t.copy })).toBeTruthy();
  });

  it("只复制正文，不带附件的 <file> 引用（含内联内容）", async () => {
    const text = appendFileTags("看看这两个文件", [
      { path: "C:\\work\\a.png" },
      { path: "C:\\work\\notes.md", content: "# 笔记\n内容" },
    ]);
    render(<UserBubble index={2} text={text} />);
    // 附件仍显示成标签
    expect(screen.getByRole("list", { name: t.attachments.sent })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.copy }));
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("看看这两个文件");
  });

  it("只有附件没有正文时不显示复制按钮", () => {
    render(<UserBubble index={0} text={appendFileTags("", [{ path: "C:\\work\\a.png" }])} />);
    expect(screen.queryByRole("button", { name: t.copy })).toBeNull();
  });

  it("写入剪贴板失败时保持原样", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    render(<UserBubble index={0} text="你好" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.copy }));
    });
    expect(screen.getByRole("button", { name: t.copy })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.copied })).toBeNull();
  });

  it("操作行默认隐藏，悬停 / 焦点进入时显示，触屏常显，减少动态效果时不做过渡", () => {
    render(<UserBubble index={0} text="你好" />);
    const row = screen.getByRole("button", { name: t.copy }).parentElement;
    const cls = row?.className ?? "";
    for (const c of [
      "opacity-0",
      "group-hover/user:opacity-100",
      "focus-within:opacity-100",
      "[@media(hover:none)]:opacity-100",
      "motion-reduce:transition-none",
    ])
      expect(cls).toContain(c);
    expect(screen.getByRole("article", { name: t.you }).className).toContain("group/user");
  });
});
