"use client";

// 右栏文件预览（只读）：Markdown 渲染、图片显示、其余文本按等宽原样显示；二进制文件只给“用默认程序打开”。
// 文本走薄壳 preview_file（最多 1 MiB），图片走 attachment_image（内存中缩小，不写文件）。
import { useEffect, useState } from "react";
import { FileIcon, Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { fileIconForName } from "@/features/chat/file-ref";
import { FileRefBase } from "@/features/chat/file-ref-actions";
import { MarkdownText } from "@/features/chat/message-content";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { usePreviewStore } from "./preview-store";

const t = strings.preview;

/** 图片预览的最长边（px） */
const IMAGE_EDGE = 2048;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

type Loaded =
  | { state: "loading" }
  | { state: "text"; text: string; truncated: boolean }
  | { state: "image"; src: string }
  | { state: "binary" }
  | { state: "error"; reason: string };

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const dirName = (path: string) => path.replace(/[\\/][^\\/]*$/, "") || path;
const reasonOf = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
/** attachment_image 的超限错误是为“发送图片”写的，预览时换成预览自己的说法；其他错误保留原因 */
const IMAGE_TOO_LARGE = /^图片超过 \d+ MB/;
const imageReasonOf = (e: unknown) => {
  const reason = reasonOf(e);
  return IMAGE_TOO_LARGE.test(reason) ? t.imageTooLarge : reason;
};

function useLoaded(path: string, seq: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq 变化（再次打开同一文件）时重新读取
  useEffect(() => {
    // 换文件时组件按路径重建、从“读取中”开始；同一文件重新读取期间保留当前内容（与滚动位置），
    // 只用新结果替换，过期请求的结果丢弃
    let alive = true;
    const set = (next: Loaded) => alive && setLoaded(next);
    getPlatform()
      .then(async (p): Promise<Loaded> => {
        if (IMAGE_EXT.test(path)) {
          const img = await p.attachmentImage(path, IMAGE_EDGE).catch((e: unknown) => {
            throw new Error(imageReasonOf(e));
          });
          return { state: "image", src: `data:${img.mimeType};base64,${img.data}` };
        }
        const r = await p.previewFile(path);
        return r.kind === "text"
          ? { state: "text", text: r.text, truncated: r.truncated }
          : { state: "binary" };
      })
      .then(set, (e: unknown) => set({ state: "error", reason: reasonOf(e) }));
    return () => {
      alive = false;
    };
  }, [path, seq]);
  return loaded;
}

const iconButton =
  "grid aspect-square size-7 shrink-0 place-items-center rounded-lg text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover";

export function FilePreview() {
  const path = usePreviewStore((s) => s.path);
  const seq = usePreviewStore((s) => s.seq);
  const clear = usePreviewStore((s) => s.clear);
  if (!path)
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Icon name="file-text" size="xl" />
      </div>
    );
  return <PreviewBody key={path} path={path} seq={seq} onClose={clear} />;
}

function PreviewBody({ path, seq, onClose }: { path: string; seq: number; onClose: () => void }) {
  const loaded = useLoaded(path, seq);
  const name = baseName(path);
  const run = (action: (p: Awaited<ReturnType<typeof getPlatform>>) => Promise<unknown>) =>
    void getPlatform()
      .then(action)
      .catch(() => {});
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-9 shrink-0 items-center gap-1.5 pr-1 pl-2">
        <FileIcon name={fileIconForName(name)} size="sm" className="shrink-0" />
        <Tooltip content={path}>
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{name}</h2>
        </Tooltip>
        <Tooltip content={t.openExternal}>
          <button
            type="button"
            aria-label={t.openExternal}
            onClick={() => run((p) => p.openPath(path))}
            className={iconButton}
          >
            <Icon name="external-link" size="sm" />
          </button>
        </Tooltip>
        <Tooltip content={t.reveal}>
          <button
            type="button"
            aria-label={t.reveal}
            onClick={() => run((p) => p.revealPath(path))}
            className={iconButton}
          >
            <Icon name="folder-open" size="sm" />
          </button>
        </Tooltip>
        <Tooltip content={t.close}>
          <button type="button" aria-label={t.close} onClick={onClose} className={iconButton}>
            <Icon name="x" size="sm" />
          </button>
        </Tooltip>
      </header>
      <section
        aria-label={name}
        aria-busy={loaded.state === "loading"}
        className="scroll-thin min-h-0 flex-1 overflow-auto rounded-xl bg-surface px-4 py-3 ring-1 ring-border"
      >
        {loaded.state === "text" &&
          (MARKDOWN_EXT.test(path) ? (
            // 文档里的相对路径从文件所在文件夹算起
            <FileRefBase.Provider value={dirName(path)}>
              <MarkdownText text={loaded.text} streaming={false} className="text-sm text-ink" />
            </FileRefBase.Provider>
          ) : (
            <pre className="whitespace-pre font-mono text-xs leading-relaxed text-ink">
              {loaded.text}
            </pre>
          ))}
        {loaded.state === "text" && loaded.truncated && (
          <p className="mt-3 text-2xs text-muted">{t.truncated}</p>
        )}
        {loaded.state === "image" && (
          // biome-ignore lint/performance/noImgElement: 静态导出、本地 data URL，不需要 next/image
          <img src={loaded.src} alt={name} className="mx-auto max-w-full" />
        )}
        {loaded.state === "binary" && <p className="text-sm text-muted">{t.binary}</p>}
        {loaded.state === "error" && (
          <p role="alert" className="text-sm text-danger">
            {loaded.reason}
          </p>
        )}
      </section>
    </div>
  );
}
