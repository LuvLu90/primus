import { Workbook } from "@cj-tech-master/excelts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  afterEach(() => {
    setPlatformForTesting(undefined);
    vi.restoreAllMocks();
  });

  /** 表格按行虚拟滚动：jsdom 没有布局，给滚动容器一屏高度 */
  const withViewport = () =>
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(640);

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

  it("Excel 像打开后一样显示：列字母、行号、格式化后的值，底部标签切换工作表", async () => {
    const { previewFileBytes } = setup();
    withViewport();
    const wb = new Workbook();
    const ws = wb.addWorksheet("销售");
    ws.addRow(["产品", "金额"]);
    ws.addRow(["苹果", 1234.5]);
    ws.getCell("B2").numFmt = "#,##0.00";
    ws.mergeCells("A3:B3");
    ws.getCell("A3").value = "合计";
    wb.addWorksheet("第二页").getCell("A1").value = "你好";
    const buf = (await wb.xlsx.writeBuffer()) as Uint8Array;
    previewFileBytes.mockResolvedValue(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    render(<FilePreview />);
    act(() => showPreview("/w/报表.xlsm"));
    const grid = await screen.findByRole("region", { name: t.spreadsheet });
    expect(previewFileBytes).toHaveBeenCalledWith("/w/报表.xlsm");
    for (const label of ["A", "B", "1", "2", "3", "产品", "1,234.50", "合计"])
      expect(within(grid).getByText(label)).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: t.sheets });
    const first = within(tabs).getByRole("tab", { name: "销售" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(tabs).getByRole("tab", { name: "第二页" }));
    expect(await screen.findByText("你好")).toBeTruthy();
    expect(screen.queryByText("产品")).toBeNull();
    expect(first.getAttribute("aria-selected")).toBe("false");
  });

  it("CSV 显示为表格（不显示工作表标签），只读了开头时提示", async () => {
    const { previewFile, previewFileBytes } = setup();
    withViewport();
    previewFile.mockResolvedValue({
      kind: "text",
      text: '名称,数量\n"苹果, 红",3\n半',
      truncated: true,
      size: 2e6,
    });
    render(<FilePreview />);
    act(() => showPreview("/w/清单.csv"));
    const grid = await screen.findByRole("region", { name: t.spreadsheet });
    expect(within(grid).getByText("苹果, 红")).toBeTruthy();
    expect(within(grid).getByText("A")).toBeTruthy();
    expect(within(grid).queryByText("半")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText(t.truncated)).toBeTruthy();
    expect(previewFileBytes).not.toHaveBeenCalled();
  });

  it("工作簿解析失败时显示原因", async () => {
    const { previewFileBytes } = setup();
    previewFileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    render(<FilePreview />);
    act(() => showPreview("/w/坏.xlsx"));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      new RegExp(`^${t.renderFailed}.+`),
    );
  });

  it("旧版 Office 等其他二进制文件提示用默认程序打开", async () => {
    const { previewFile, previewFileBytes, openPath } = setup();
    previewFile.mockResolvedValue({ kind: "binary", size: 10 });
    render(<FilePreview />);
    act(() => showPreview("/w/旧.doc"));
    expect(await screen.findByText(t.binary)).toBeTruthy();
    act(() => showPreview("/w/旧表.xls"));
    await waitFor(() => expect(previewFile).toHaveBeenCalledWith("/w/旧表.xls"));
    expect(await screen.findByText(t.binary)).toBeTruthy();
    act(() => showPreview("/w/旧.doc"));
    await screen.findByText(t.binary);
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

  it("JSON 格式化显示（数字原样），可切换到源码再切回", async () => {
    const { previewFile } = setup();
    const raw = '{"a":1,"big":12345678901234567890}';
    previewFile.mockResolvedValue({ kind: "text", text: raw, truncated: false, size: raw.length });
    render(<FilePreview />);
    act(() => showPreview("/w/data.json"));
    const pretty = '{\n  "a": 1,\n  "big": 12345678901234567890\n}';
    await waitFor(() => expect(document.querySelector("pre")?.textContent).toBe(pretty));
    const toggle = screen.getByRole("button", { name: t.showSource });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(document.querySelector("pre")?.textContent).toBe(raw);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(document.querySelector("pre")?.textContent).toBe(pretty);
  });

  it("Markdown 渲染，可切换到源码；普通代码文件没有切换按钮", async () => {
    const { previewFile } = setup();
    previewFile.mockResolvedValueOnce({
      kind: "text",
      text: "# 标题\n\n正文",
      truncated: false,
      size: 10,
    });
    const view = render(<FilePreview />);
    act(() => showPreview("/w/README.md"));
    expect(await screen.findByRole("heading", { name: "标题" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.showSource }));
    expect(document.querySelector("pre")?.textContent).toBe("# 标题\n\n正文");
    expect(screen.queryByRole("heading", { name: "标题" })).toBeNull();
    view.unmount();

    render(<FilePreview />);
    act(() => showPreview("/w/main.ts"));
    await screen.findByText(/answer = 42/);
    expect(screen.queryByRole("button", { name: t.showSource })).toBeNull();
  });

  it("音频、视频与 GIF 读取整份字节，用 blob URL 播放 / 显示，关闭时释放", async () => {
    const { previewFileBytes, previewFile } = setup();
    const create = vi.fn((_blob: Blob) => "blob:media");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    render(<FilePreview />);
    act(() => showPreview("C:\\w\\歌.mp3"));
    await waitFor(() => expect(document.querySelector("audio")).not.toBeNull());
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("aria-label")).toBe("歌.mp3");
    expect(audio.getAttribute("src")).toBe("blob:media");
    expect(previewFileBytes).toHaveBeenCalledWith("C:\\w\\歌.mp3");
    expect(create.mock.calls[0]?.[0]?.type).toBe("audio/mpeg");

    act(() => showPreview("C:\\w\\clip.webm"));
    await waitFor(() =>
      expect(document.querySelector("video")?.getAttribute("aria-label")).toBe("clip.webm"),
    );
    expect(revoke).toHaveBeenCalledWith("blob:media");

    act(() => showPreview("C:\\w\\动图.gif"));
    const img = (await screen.findByRole("img", { name: "动图.gif" })) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:media");
    expect(previewFile).not.toHaveBeenCalled();

    // 解码失败：提示用默认程序打开
    fireEvent.error(img);
    expect((await screen.findByRole("alert")).textContent).toBe(t.imageFailed);
  });

  it("文件夹列出文件：文件夹在前，点文件夹进入、点文件预览，返回回到上一个位置", async () => {
    const { previewFile } = setup();
    const platform = createMockPlatform();
    const previewDir = vi.fn(async (path: string) => ({
      entries:
        path === "D:\\w"
          ? [
              { name: "src", dir: true, size: null, modifiedMs: null, hidden: false },
              { name: ".git", dir: true, size: null, modifiedMs: null, hidden: true },
              { name: "a.ts", dir: false, size: 1536, modifiedMs: null, hidden: false },
            ]
          : [],
      total: path === "D:\\w" ? 3 : 0,
      truncated: false,
    }));
    previewFile.mockImplementation(async (path: string) =>
      /\.ts$/.test(path)
        ? { kind: "text", text: "export {}", truncated: false, size: 9 }
        : { kind: "directory" },
    );
    setPlatformForTesting({ ...platform, previewFile, previewDir });
    withViewport();
    render(<FilePreview />);
    act(() => showPreview("D:\\w"));
    const list = await screen.findByRole("list", { name: t.folder.list });
    // 隐藏项默认不显示
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["src", "a.ts1.5 KB"]);
    fireEvent.click(screen.getByRole("button", { name: t.folder.showHidden.replace("{n}", "1") }));
    expect(within(list).getAllByRole("button")).toHaveLength(3);

    // 进入子文件夹：空文件夹提示；面包屑可回到上一级
    fireEvent.click(within(list).getByRole("button", { name: /^src/ }));
    expect(await screen.findByText(t.folder.empty)).toBeTruthy();
    expect(previewDir).toHaveBeenLastCalledWith("D:\\w\\src");
    expect(usePreviewStore.getState().path).toBe("D:\\w\\src");
    const crumbs = screen.getByRole("navigation", { name: t.folder.path });
    expect(within(crumbs).getByText("src").getAttribute("aria-current")).toBe("location");
    fireEvent.click(within(crumbs).getByRole("button", { name: "w" }));
    await screen.findByRole("list", { name: t.folder.list });

    // 点文件在右栏预览，返回回到文件夹
    fireEvent.click(screen.getByRole("button", { name: /^a\.ts/ }));
    expect(await screen.findByText("export {}")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.back }));
    await waitFor(() => expect(usePreviewStore.getState().path).toBe("D:\\w"));
    await screen.findByRole("list", { name: t.folder.list });
    // 上一级：D:\ 是根目录，再往上不可用
    fireEvent.click(screen.getByRole("button", { name: t.folder.up }));
    await waitFor(() => expect(usePreviewStore.getState().path).toBe("D:\\"));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: t.folder.up }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
  });

  it("文件夹超过显示上限时提示", async () => {
    const { previewFile } = setup();
    previewFile.mockResolvedValue({ kind: "directory" });
    const entries = Array.from({ length: 3 }, (_, i) => ({
      name: `f${i}`,
      dir: false,
      size: 0,
      modifiedMs: null,
      hidden: false,
    }));
    setPlatformForTesting({
      ...createMockPlatform(),
      previewFile,
      previewDir: async () => ({ entries, total: 2500, truncated: true }),
    });
    render(<FilePreview />);
    act(() => showPreview("/w/big"));
    expect(
      await screen.findByText(
        t.folder.truncated.replace("{shown}", "3").replace("{total}", "2500"),
      ),
    ).toBeTruthy();
  });
});
