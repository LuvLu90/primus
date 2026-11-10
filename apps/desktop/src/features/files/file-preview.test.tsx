import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { FilePreview } from "./file-preview";
import { showPreview, usePreviewStore } from "./preview-store";

const t = strings.preview;

// 渲染库在 jsdom 里只验证接入方式：传入的字节、容器与清理
const docx = vi.hoisted(() => ({
  renderAsync: vi.fn(
    async (_data: unknown, body: HTMLElement, _style?: HTMLElement, _options?: object) => {
      body.innerHTML =
        '<div class="docx-wrapper" style="background: gray"><section class="docx"><p>Word 正文</p></section></div>';
    },
  ),
}));
vi.mock("docx-preview", () => docx);

const pptx = vi.hoisted(() => {
  const destroy = vi.fn();
  return {
    destroy,
    RECOMMENDED_ZIP_LIMITS: { maxFiles: 1 },
    PptxViewer: {
      open: vi.fn(async (_data: unknown, container: HTMLElement, _options?: object) => {
        container.innerHTML = "<div>第 1 张幻灯片</div>";
        return { destroy };
      }),
    },
  };
});
vi.mock("@aiden0z/pptx-renderer", () => pptx);

function setup() {
  const platform = createMockPlatform();
  const bytes = new Uint8Array([80, 75, 3, 4]).buffer;
  const previewFile = vi.spyOn(platform, "previewFile");
  const previewFileBytes = vi.spyOn(platform, "previewFileBytes").mockResolvedValue(bytes);
  const openPath = vi.spyOn(platform, "openPath");
  setPlatformForTesting(platform);
  return { bytes, previewFile, previewFileBytes, openPath };
}

describe("右栏文件预览：显示打开后的样子", () => {
  beforeEach(() => {
    usePreviewStore.setState({ path: null, seq: 0 });
    docx.renderAsync.mockClear();
    pptx.PptxViewer.open.mockClear();
    pptx.destroy.mockClear();
  });
  afterEach(() => setPlatformForTesting(undefined));

  it("网页在无权限的沙箱 iframe 中渲染，而不是显示源码", async () => {
    const { previewFile } = setup();
    previewFile.mockResolvedValue({
      kind: "text",
      text: "<h1>你好</h1><script>alert(1)</script>",
      truncated: false,
      size: 10,
    });
    render(<FilePreview />);
    act(() => showPreview("C:/w/index.html"));
    const frame = (await screen.findByLabelText(t.webPage)) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>你好</h1>");
    expect(screen.queryByText(/<h1>/)).toBeNull();
  });

  it("截断的网页仍渲染，并提示只显示了开头", async () => {
    const { previewFile } = setup();
    previewFile.mockResolvedValue({ kind: "text", text: "<p>x</p>", truncated: true, size: 2e6 });
    render(<FilePreview />);
    act(() => showPreview("/w/big.htm"));
    expect(await screen.findByLabelText(t.webPage)).toBeTruthy();
    expect(screen.getByText(t.truncated)).toBeTruthy();
  });

  it("SVG 按图片显示", async () => {
    const { previewFile } = setup();
    previewFile.mockResolvedValue({ kind: "text", text: "<svg/>", truncated: false, size: 6 });
    render(<FilePreview />);
    act(() => showPreview("/w/logo.svg"));
    const img = (await screen.findByRole("img", { name: "logo.svg" })) as HTMLImageElement;
    expect(img.src.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("Word 读取整份字节后渲染为文档，去掉库自带的灰底", async () => {
    const { bytes, previewFile, previewFileBytes } = setup();
    render(<FilePreview />);
    act(() => showPreview("/w/报告.DOCX"));
    expect(await screen.findByText("Word 正文")).toBeTruthy();
    expect(previewFileBytes).toHaveBeenCalledWith("/w/报告.DOCX");
    expect(previewFile).not.toHaveBeenCalled();
    const [data, body, style, options] = docx.renderAsync.mock.calls[0] ?? [];
    expect(data).toBe(bytes);
    expect(style).toBe(body);
    expect(options).toMatchObject({ inWrapper: true, useBase64URL: true });
    const wrapper = screen.getByTestId("docx-host").querySelector<HTMLElement>(".docx-wrapper");
    expect(wrapper?.style.background).toBe("transparent");
    await waitFor(() => expect(screen.queryByText(t.rendering)).toBeNull());
  });

  it("PowerPoint 渲染为幻灯片：阻止外部媒体，关闭预览时销毁查看器", async () => {
    const { bytes } = setup();
    render(<FilePreview />);
    act(() => showPreview("/w/方案.pptx"));
    expect(await screen.findByText("第 1 张幻灯片")).toBeTruthy();
    const [data, , options] = pptx.PptxViewer.open.mock.calls[0] ?? [];
    expect(data).toBe(bytes);
    expect(options).toMatchObject({ externalMedia: "block", pdfjs: false, fitMode: "contain" });
    fireEvent.click(screen.getByRole("button", { name: t.close }));
    expect(pptx.destroy).toHaveBeenCalledTimes(1);
  });

  it("PDF 用 blob URL 交给 WebView2 的查看器，关闭时释放", async () => {
    setup();
    const create = vi.fn(() => "blob:primus/1");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    render(<FilePreview />);
    act(() => showPreview("/w/a.pdf"));
    const frame = (await screen.findByLabelText(t.pdf)) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("blob:primus/1");
    fireEvent.click(screen.getByRole("button", { name: t.close }));
    expect(revoke).toHaveBeenCalledWith("blob:primus/1");
  });

  it("文档渲染失败或读取失败时显示原因", async () => {
    const { previewFileBytes } = setup();
    docx.renderAsync.mockRejectedValueOnce(new Error("不是有效的 docx"));
    render(<FilePreview />);
    act(() => showPreview("/w/坏.docx"));
    expect((await screen.findByRole("alert")).textContent).toBe(`${t.renderFailed}不是有效的 docx`);
    previewFileBytes.mockRejectedValueOnce("文件超过 30 MB，无法预览，请用默认程序打开");
    act(() => showPreview("/w/大.pptx"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "文件超过 30 MB，无法预览，请用默认程序打开",
      ),
    );
  });

  it("旧版 Office 等其他二进制文件提示用默认程序打开", async () => {
    const { previewFile, previewFileBytes, openPath } = setup();
    previewFile.mockResolvedValue({ kind: "binary", size: 10 });
    render(<FilePreview />);
    act(() => showPreview("/w/旧.doc"));
    expect(await screen.findByText(t.binary)).toBeTruthy();
    expect(previewFileBytes).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: t.openExternal });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/w/旧.doc"));
  });

  it("代码文件仍按文本原样显示", async () => {
    setup();
    render(<FilePreview />);
    act(() => showPreview("/w/main.ts"));
    expect(await screen.findByText(/answer = 42/)).toBeTruthy();
  });
});
