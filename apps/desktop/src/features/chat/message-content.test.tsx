import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewStore } from "@/features/files/preview-store";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { FileRefBase } from "./file-ref-actions";
import { MarkdownText, renderMarkdown } from "./message-content";

const t = strings.chat;

describe("回复中的链接", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("点击 https 链接先确认，确认后交给系统浏览器打开", async () => {
    const openExternal = vi.fn(async () => {});
    setPlatformForTesting({ ...createMockPlatform(), openExternal });
    render(<MarkdownText text="看 [文档](https://example.com/doc)" streaming={false} />);
    fireEvent.click(screen.getByRole("link", { name: `文档${t.linkExternal}` }));
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

describe("回复中的文件引用与网页链接", () => {
  afterEach(() => {
    setPlatformForTesting(undefined);
    vi.useRealTimers();
  });

  it("文件链接渲染成带类型图标、文件名与行号的按钮，完整路径在提示里", () => {
    render(
      <MarkdownText
        text="见 [chat-panel.tsx](apps/desktop/src/chat-panel.tsx#L42-L58)"
        streaming={false}
      />,
    );
    const ref = screen.getByRole("button", {
      name: t.fileRef.labelRange
        .replace("{name}", "chat-panel.tsx")
        .replace("{line}", "42")
        .replace("{end}", "58"),
    });
    expect(ref.textContent).toBe("chat-panel.tsx:42–58");
    // 悬停提示走统一 Tooltip（data-tooltip），不用原生 title
    expect(ref.getAttribute("title")).toBeNull();
    expect(ref.getAttribute("data-tooltip")).toBe("apps/desktop/src/chat-panel.tsx:42–58");
    expect(ref.dataset.path).toBe("apps/desktop/src/chat-panel.tsx");
    expect(ref.querySelector('[data-file-icon="react-ts"]')).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("链接文字与路径不同时显示链接文字", () => {
    render(<MarkdownText text="[发送逻辑](src/chat-panel.tsx:42)" streaming={false} />);
    const ref = screen.getByRole("button", {
      name: t.fileRef.labelLine.replace("{name}", "发送逻辑").replace("{line}", "42"),
    });
    expect(ref.textContent).toBe("发送逻辑:42");
  });

  it("行内代码里的路径渲染成文件引用，普通代码保持代码样式", () => {
    const html = renderMarkdown("改 `src/lib/strings.ts`，再跑 `pnpm test`，`console.log` 不算");
    expect(html).toContain('data-file-ref="src/lib/strings.ts"');
    expect(html).toContain("<code>pnpm test</code>");
    expect(html).toContain("<code>console.log</code>");
  });

  it("Windows 路径与 file:// 链接都识别", () => {
    const html = renderMarkdown(
      "[a](C:\\Users\\me\\a.ts) [b](file:///C:/Users/me/b.pdf) `D:\\data\\c.xlsx:3`",
    );
    expect(html).toContain('data-file-ref="C:\\Users\\me\\a.ts"');
    expect(html).toContain('data-file-ref="C:/Users/me/b.pdf"');
    expect(html).toContain('data-file-icon="pdf"');
    expect(html).toContain('data-file-ref="D:\\data\\c.xlsx:3"');
    expect(html).toContain('data-file-icon="table"');
  });

  it("网页链接保持文字链接，末尾带外链图标与屏幕阅读器提示", () => {
    render(<MarkdownText text="看 [文档](https://example.com/a.ts)" streaming={false} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/a.ts");
    expect(link.querySelector('[data-icon="external-link"]')).not.toBeNull();
    expect(link.textContent).toBe(`文档${t.linkExternal}`);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("外链文字里的行内代码不变成文件按钮，点击仍先确认外链", async () => {
    const openPath = vi.fn(async () => "opened" as const);
    const openExternal = vi.fn(async () => {});
    setPlatformForTesting({ ...createMockPlatform(), openPath, openExternal });
    render(<MarkdownText text="见 [`src/a.ts`](https://example.com/x)" streaming={false} />);
    const link = screen.getByRole("link");
    expect(link.querySelector("[data-file-ref]")).toBeNull();
    fireEvent.click(link.querySelector("code") as HTMLElement);
    expect(await screen.findByRole("button", { name: t.linkOpen })).not.toBeNull();
    expect(openPath).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("原型属性名当扩展名的链接也能渲染（通用文件图标）", () => {
    const html = renderMarkdown("[x](a.constructor) [y](b.__proto__)");
    expect(html).toContain('data-file-ref="a.constructor"');
    expect(html).toContain('data-file-ref="b.__proto__"');
    expect(html).toContain('data-file-icon="file"');
  });

  it("含空格（%20）的 file:// 地址渲染成文件引用", () => {
    const html = renderMarkdown("[报告](file:///home/me/My%20Project/report.md)");
    expect(html).toContain('data-file-ref="/home/me/My Project/report.md"');
    expect(html).not.toContain("<a");
  });

  it("识别不了的 file: 地址不生成链接", () => {
    const html = renderMarkdown("[根](file:///) [空](file://)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("data-file-ref");
  });

  it("不带协议的文件名不会被自动识别成网址", () => {
    const html = renderMarkdown("改 README.md、main.rs 与 app.py，见 www.example.com");
    expect(html).not.toContain('href="http://README.md"');
    expect(html).not.toContain("main.rs</a>");
    expect(html).not.toContain("app.py</a>");
  });

  it("文件引用里的内容会转义", () => {
    const html = renderMarkdown('[<img src=x onerror="1">](src/a&b.ts)');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("点击文件引用：相对路径按会话工作区解析、去掉行号后在右栏预览，不弹出链接确认", async () => {
    const openPath = vi.fn(async () => "opened" as const);
    const openExternal = vi.fn(async () => {});
    setPlatformForTesting({ ...createMockPlatform(), openPath, openExternal });
    render(
      <FileRefBase.Provider value={"C:\\work\\primus"}>
        <MarkdownText text="`src/a.ts:42`" streaming={false} />
      </FileRefBase.Provider>,
    );
    const ref = screen.getByRole("button");
    ref.focus();
    expect(document.activeElement).toBe(ref);
    fireEvent.click(ref);
    expect(usePreviewStore.getState().path).toBe("C:\\work\\primus\\src\\a.ts");
    expect(openPath).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: t.linkOpen })).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("绝对路径原样预览；文件夹也在右栏预览", async () => {
    const openPath = vi.fn(async () => "opened" as const);
    setPlatformForTesting({ ...createMockPlatform(), openPath });
    render(
      <MarkdownText text="[报告](file:///home/me/My%20Project/report.md#L3)" streaming={false} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(usePreviewStore.getState().path).toBe("/home/me/My Project/report.md");
    render(<MarkdownText text="`/home/me/docs/`" streaming={false} />);
    fireEvent.click(screen.getAllByRole("button")[1] as HTMLElement);
    expect(usePreviewStore.getState().path).toBe("/home/me/docs");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("没有工作区时相对路径无法定位：提示原因，不调用薄壳", async () => {
    const openPath = vi.fn(async () => "opened" as const);
    setPlatformForTesting({ ...createMockPlatform(), openPath });
    render(<MarkdownText text="`src/a.ts`" streaming={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      t.fileRef.noWorkspace.replace("{name}", "a.ts"),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("打不开时显示薄壳给出的原因", async () => {
    const openPath = vi.fn(async () => {
      throw "找不到文件：/w/src/gone.ts";
    });
    setPlatformForTesting({ ...createMockPlatform(), openPath });
    render(
      <FileRefBase.Provider value="/w">
        <MarkdownText text="`src/gone.ts`" streaming={false} />
      </FileRefBase.Provider>,
    );
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.fileRef.open }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      t.fileRef.openFailed
        .replace("{name}", "gone.ts")
        .replace("{reason}", "找不到文件：/w/src/gone.ts"),
    );
  });

  it("可执行文件改为在文件夹中显示时提示没有直接运行", async () => {
    const openPath = vi.fn(async () => "revealed" as const);
    setPlatformForTesting({ ...createMockPlatform(), openPath });
    render(<MarkdownText text={"`C:\\tools\\setup.exe`"} streaming={false} />);
    fireEvent.contextMenu(screen.getByRole("button"), { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.fileRef.open }));
    expect((await screen.findByRole("status")).textContent).toBe(
      t.fileRef.revealed.replace("{name}", "setup.exe"),
    );
  });

  it("右键菜单：在文件夹中显示、复制路径（带行号，短暂显示已复制）", async () => {
    const revealPath = vi.fn(async () => {});
    const openPath = vi.fn(async () => "opened" as const);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setPlatformForTesting({ ...createMockPlatform(), revealPath, openPath });
    render(
      <FileRefBase.Provider value="/w">
        <MarkdownText text="`src/a.ts:42`" streaming={false} />
      </FileRefBase.Provider>,
    );
    const ref = screen.getByRole("button");
    fireEvent.contextMenu(ref, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.fileRef.reveal }));
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith("/w/src/a.ts"));
    expect(openPath).not.toHaveBeenCalled();

    fireEvent.contextMenu(ref, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.fileRef.copy }));
    expect(writeText).toHaveBeenCalledWith("src/a.ts:42");
    await waitFor(() => expect(ref.getAttribute("aria-label")).toBe(t.fileRef.copied));
    expect(ref.hasAttribute("data-copied")).toBe(true);
    await waitFor(() => expect(ref.hasAttribute("data-copied")).toBe(false), { timeout: 2500 });
    expect(ref.getAttribute("aria-label")).toBe(
      t.fileRef.labelLine.replace("{name}", "a.ts").replace("{line}", "42"),
    );

    fireEvent.contextMenu(ref, { clientX: 20, clientY: 30 });
    fireEvent.click(await screen.findByRole("menuitem", { name: t.fileRef.open }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/w/src/a.ts"));
  });
});
