"use client";

// 右栏“打开后的样子”：网页、Word、PowerPoint、PDF 的渲染视图。
// - 网页：沙箱 iframe（srcdoc，不给任何权限：不运行脚本、不弹窗、不提交表单、与 App 不同源）。srcdoc 继承 App 的 CSP，
//   外链脚本、远程图片与相对路径资源不会加载（样式与内联图片正常）。
// - Word：docx-preview；PowerPoint：@aiden0z/pptx-renderer。两者体积大，按需动态加载，不进启动包。
// - PDF：blob URL 交给 WebView2 自带的 PDF 查看器（CSP 的 frame-src 放行 blob:）。
// - Excel（.xlsx / .xlsm）：@cj-tech-master/excelts 解析（按需动态加载），sheet-view 显示为带行列号的网格与工作表标签。
// - 音频 / 视频、GIF / ICO / AVIF 图片：整份字节做成 blob URL 交给 <audio> / <video> / <img>
//   （CSP 的 media-src、img-src 放行 blob:），播放 / 解码失败时提示用默认程序打开。
import { useEffect, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { readWorkbook, type Sheet } from "./sheet-model";
import { SheetBook } from "./sheet-view";

const t = strings.preview;

const reasonOf = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

type RenderState = { state: "rendering" } | { state: "done" } | { state: "error"; reason: string };

function RenderStatus({ status }: { status: RenderState }) {
  if (status.state === "rendering")
    return <p className="px-4 py-3 text-sm text-muted">{t.rendering}</p>;
  if (status.state === "error")
    return (
      <p role="alert" className="px-4 py-3 text-sm text-danger">
        {t.renderFailed}
        {status.reason}
      </p>
    );
  return null;
}

/** 网页：沙箱 iframe 渲染 HTML 源码 */
export function HtmlView({ html }: { html: string }) {
  return (
    // biome-ignore lint/a11y/useIframeTitle: 原生 title 会成为悬停提示（check:no-title 禁止），可访问名称用 aria-label
    <iframe
      aria-label={t.webPage}
      // 空 sandbox：不同源、无脚本、无表单、无弹窗、不能导航顶层窗口
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={html}
      className="size-full border-0 bg-page scheme-light"
    />
  );
}

/** PDF：blob URL 交给 WebView2 的 PDF 查看器 */
export function PdfView({ data }: { data: ArrayBuffer }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data]);
  if (!url) return null;
  return (
    // biome-ignore lint/a11y/useIframeTitle: 原生 title 会成为悬停提示（check:no-title 禁止），可访问名称用 aria-label
    <iframe aria-label={t.pdf} src={url} className="size-full border-0 bg-page" />
  );
}

/** 字节 → blob URL（卸载或换数据时释放） */
function useBlobUrl(data: ArrayBuffer, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([data], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [data, mime]);
  return url;
}

/** 音频 / 视频 / 图片：blob URL 交给原生元素；失败时提示 */
export function BlobMediaView({
  kind,
  data,
  mime,
  name,
}: {
  kind: "image" | "audio" | "video";
  data: ArrayBuffer;
  mime: string;
  name: string;
}) {
  const url = useBlobUrl(data, mime);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <p role="alert" className="px-4 py-3 text-sm text-danger">
        {kind === "image" ? t.imageFailed : t.mediaFailed}
      </p>
    );
  if (!url) return null;
  const onError = () => setFailed(true);
  if (kind === "image")
    return (
      <div className="scroll-thin size-full overflow-auto px-4 py-3">
        {/* biome-ignore lint/performance/noImgElement: 静态导出、本地 blob URL，不需要 next/image */}
        <img src={url} alt={name} onError={onError} className="mx-auto max-w-full" />
      </div>
    );
  if (kind === "audio")
    return (
      <div className="flex size-full items-center justify-center px-4">
        {/* biome-ignore lint/a11y/useMediaCaption: 本地文件预览，没有字幕轨 */}
        <audio src={url} controls aria-label={name} onError={onError} className="w-full" />
      </div>
    );
  return (
    <div className="flex size-full items-center justify-center">
      {/* biome-ignore lint/a11y/useMediaCaption: 本地文件预览，没有字幕轨 */}
      <video
        src={url}
        controls
        playsInline
        aria-label={name}
        onError={onError}
        className="max-h-full max-w-full"
      />
    </div>
  );
}

/** Word 页面的外边距（docx-preview 包装层左右各 30px） */
const DOCX_GUTTER = 60;

/** Word：渲染为分页的文档，按右栏宽度整体缩放（与 Word “适应页宽”一致） */
export function DocxView({ data }: { data: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<RenderState>({ state: "rendering" });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let alive = true;
    let observer: ResizeObserver | undefined;
    import("docx-preview")
      .then(({ renderAsync }) =>
        renderAsync(data, el, el, {
          inWrapper: true,
          breakPages: true,
          // 图片用 data URL（CSP 的 img-src 允许 data:）
          useBase64URL: true,
          renderChanges: false,
          renderComments: false,
        }),
      )
      .then(
        () => {
          if (!alive) return;
          const wrapper = el.querySelector<HTMLElement>(".docx-wrapper");
          if (wrapper) {
            // 去掉库自带的灰色底，页面直接放在右栏纸面上
            wrapper.style.background = "transparent";
            const fitWidth = () => {
              const page = wrapper.querySelector<HTMLElement>("section.docx");
              const pageWidth = page?.offsetWidth ?? 0;
              if (pageWidth > 0 && el.clientWidth > 0)
                wrapper.style.zoom = String(
                  Math.min(1, el.clientWidth / (pageWidth + DOCX_GUTTER)),
                );
            };
            fitWidth();
            if (typeof ResizeObserver !== "undefined") {
              observer = new ResizeObserver(fitWidth);
              observer.observe(el);
            }
          }
          setStatus({ state: "done" });
        },
        (e: unknown) => alive && setStatus({ state: "error", reason: reasonOf(e) }),
      );
    return () => {
      alive = false;
      observer?.disconnect();
      el.replaceChildren();
    };
  }, [data]);
  return (
    <div className="scroll-thin size-full overflow-auto">
      <RenderStatus status={status} />
      <div ref={host} data-testid="docx-host" />
    </div>
  );
}

/** PowerPoint：逐张渲染幻灯片（适应右栏宽度，滚动时按需挂载） */
export function PptxView({ data }: { data: ArrayBuffer }) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<RenderState>({ state: "rendering" });
  useEffect(() => {
    const el = host.current;
    const root = scroller.current;
    if (!el || !root) return;
    const abort = new AbortController();
    let viewer: { destroy(): void } | undefined;
    import("@aiden0z/pptx-renderer")
      .then(({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) =>
        PptxViewer.open(data, el, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          fitMode: "contain",
          scrollContainer: root,
          // 文件来自 Agent（不可信）：不加载外部链接的媒体；不需要 PDF.js 兜底
          externalMedia: "block",
          pdfjs: false,
          lazyMedia: true,
          lazySlides: true,
          listOptions: { windowed: true, initialSlides: 3, batchSize: 3 },
          signal: abort.signal,
        }),
      )
      .then(
        (v) => {
          if (abort.signal.aborted) {
            v.destroy();
            return;
          }
          viewer = v;
          setStatus({ state: "done" });
        },
        (e: unknown) => !abort.signal.aborted && setStatus({ state: "error", reason: reasonOf(e) }),
      );
    return () => {
      abort.abort();
      viewer?.destroy();
      el.replaceChildren();
    };
  }, [data]);
  return (
    // 内边距放在滚动容器上：查看器按宿主宽度适应，宿主自身不能带内边距
    <div ref={scroller} className="scroll-thin size-full overflow-auto p-3">
      <RenderStatus status={status} />
      <div ref={host} data-testid="pptx-host" />
    </div>
  );
}

/** Excel：解析工作簿后像在 Excel 中打开一样显示（工作表标签、列字母与行号） */
export function XlsxView({ data }: { data: ArrayBuffer }) {
  const [status, setStatus] = useState<RenderState>({ state: "rendering" });
  const [sheets, setSheets] = useState<Sheet[]>([]);
  useEffect(() => {
    let alive = true;
    setStatus({ state: "rendering" });
    readWorkbook(data).then(
      (next) => {
        if (!alive) return;
        setSheets(next);
        setStatus({ state: "done" });
      },
      (e: unknown) => alive && setStatus({ state: "error", reason: reasonOf(e) }),
    );
    return () => {
      alive = false;
    };
  }, [data]);
  if (status.state !== "done") return <RenderStatus status={status} />;
  return <SheetBook sheets={sheets} />;
}
