"use client";

// 输入框附件的状态与读取队列。
// - 图片逐张排队读取（一张读完再读下一张）：本地路径交给薄壳 `attachment_image`，剪贴板/拖放的内存图片在 WebView 里解码。
// - 其他文件立即落地（无进度环），发送时按路径引用。
// - 当前模型不看图：不读取图片；有路径的图片按路径引用（图块标“按路径”），内存图片无法发送（显示原因）。
//   换回能看图的模型时，未读的图片重新进入队列。
// - 进度环只跟随真实阶段（排队 0 → 开始读取 → 解码/编码完成 → 100），不编造百分比。
// - 读取中移除即取消：迟到的结果被丢弃，队列立即读下一张。同一路径重复添加会去重。
import type { ImageContent } from "@primus/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform } from "@/lib/platform";
import type { AttachmentImage } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { type AttachmentKind, attachmentKind, kindFromMime } from "./attachment-kind";
import { type BlobStage, type ReadImageResult, readImageBlob } from "./read-image-blob";

const t = strings.chat.attachments;

export type AttachmentStatus = "queued" | "reading" | "ready" | "error";

export interface Attachment {
  id: string;
  /** 本地路径；剪贴板/拖放的内存图片没有 */
  path?: string;
  name: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** 进度环（0–100），只按真实阶段推进 */
  progress?: number;
  /** 缩略图 data URL（只在内存） */
  thumb?: string;
  /** 读取好的图片，发送时放进 prompt 的 `images` */
  image?: ImageContent;
  error?: string;
  /** 内存图片的原始数据 */
  blob?: Blob;
  /** 正在播放移除动画：不再参与发送与队列，动画结束后删除 */
  removing?: boolean;
  /** 同一批添加中的序号（进场动画错开） */
  order: number;
}

/** 界面显示用：叠加了“当前模型是否看图”的派生状态 */
export interface AttachmentView extends Attachment {
  /** 当前模型不看图，这张图片将按路径引用 */
  byPath: boolean;
  /** 排队或读取中（显示进度环与加载点） */
  busy: boolean;
}

/** 进度环的阶段值 */
export const STAGE = { queued: 0, reading: 15, decoded: 60, encoded: 90, done: 100 } as const;
/** 图片最长边（发给模型前缩小） */
export const MAX_IMAGE_EDGE = 2048;
/** 进度环画满后再交接（加载点消失、删除键出现），与环的过渡时长一致 */
const HANDOFF_MS = 300;

export interface UseAttachmentsOptions {
  /** 当前模型能看图 */
  imagesSupported: boolean;
  /** 提交中：禁止移除（发送成功后才清空） */
  locked?: boolean;
  /** 测试可注入：读取本地图片（默认薄壳 attachment_image） */
  readPath?: (path: string, maxEdge: number) => Promise<AttachmentImage>;
  /** 测试可注入：读取内存图片（默认 WebView 画布） */
  readBlob?: (
    blob: Blob,
    maxEdge: number,
    onStage?: (stage: BlobStage) => void,
  ) => Promise<ReadImageResult>;
}

const defaultReadPath = (path: string, maxEdge: number) =>
  getPlatform().then((p) => p.attachmentImage(path, maxEdge));

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useAttachments({
  imagesSupported,
  locked = false,
  readPath = defaultReadPath,
  readBlob = readImageBlob,
}: UseAttachmentsOptions) {
  const [items, setItems] = useState<Attachment[]>([]);
  const nextId = useRef(1);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // 正在读取的那一张：令牌不同（被移除、被替换）时丢弃迟到的结果
  const active = useRef<{ id: string; token: symbol } | null>(null);
  const handoff = useRef<ReturnType<typeof setTimeout>>(undefined);
  const readers = useRef({ readPath, readBlob });
  readers.current = { readPath, readBlob };

  const update = useCallback((id: string, patch: Partial<Attachment>) => {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const addPaths = useCallback((paths: string[]) => {
    setItems((prev) => {
      const seen = new Set(prev.filter((a) => !a.removing && a.path).map((a) => a.path));
      const added: Attachment[] = [];
      for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        const kind = attachmentKind(path);
        added.push({
          id: `att-${nextId.current++}`,
          path,
          name: baseName(path),
          kind,
          status: kind === "image" ? "queued" : "ready",
          progress: kind === "image" ? STAGE.queued : undefined,
          order: added.length,
        });
      }
      return added.length > 0 ? [...prev, ...added] : prev;
    });
  }, []);

  /** 剪贴板 / 拖放的内存文件：只接受图片（没有路径的其他文件无法引用） */
  const addBlobs = useCallback((files: Array<Blob & { name?: string }>) => {
    const images = files.filter((f) => kindFromMime(f.type) === "image");
    if (images.length === 0) return 0;
    setItems((prev) => {
      const pasted = prev.filter((a) => !a.path).length;
      const added = images.map<Attachment>((blob, i) => {
        // 剪贴板里的截图通常叫 image.png：换成“粘贴的图片 N”
        const generic = !blob.name || /^image\.\w+$/i.test(blob.name);
        const ext = blob.type === "image/png" ? "png" : "jpg";
        return {
          id: `att-${nextId.current++}`,
          name: generic ? `${t.pasted} ${pasted + i + 1}.${ext}` : (blob.name ?? ""),
          kind: "image",
          status: "queued",
          progress: STAGE.queued,
          blob,
          order: i,
        };
      });
      return [...prev, ...added];
    });
    return images.length;
  }, []);

  /** 开始移除（播放动画）；提交中不允许 */
  const remove = useCallback((id: string) => {
    if (lockedRef.current) return;
    if (active.current?.id === id) active.current = null;
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, removing: true } : a)));
  }, []);

  /** 移除动画结束：从状态里删掉 */
  const finalizeRemove = useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id || !a.removing));
  }, []);

  /** 发送成功后清空：全部播放移除动画，进行中的读取作废 */
  const clear = useCallback(() => {
    active.current = null;
    setItems((prev) => prev.map((a) => (a.removing ? a : { ...a, removing: true })));
  }, []);

  // 读取队列：一次只读一张；当前模型不看图、或提交中（附件已定，切换模型的瞬间不应开始读取）时暂停
  useEffect(() => {
    if (!imagesSupported || locked) return;
    if (items.some((a) => a.status === "reading" && !a.removing)) return;
    const next = items.find((a) => a.kind === "image" && a.status === "queued" && !a.removing);
    if (!next) return;
    const token = Symbol(next.id);
    active.current = { id: next.id, token };
    const current = () => active.current?.token === token;
    update(next.id, { status: "reading", progress: STAGE.reading, error: undefined });
    const { readPath: byPath, readBlob: byBlob } = readers.current;
    const run: Promise<ReadImageResult> = next.blob
      ? byBlob(next.blob, MAX_IMAGE_EDGE, (stage) => {
          if (current()) update(next.id, { progress: STAGE[stage] });
        })
      : byPath(next.path ?? "", MAX_IMAGE_EDGE).then((r) => ({
          image: { type: "image", mimeType: r.mimeType, data: r.data },
          thumb: r.thumb,
        }));
    run
      .then(({ image, thumb }) => {
        if (!current()) return;
        // 先把环画满，环的过渡结束后再落地（加载点与删除键交接）
        update(next.id, { progress: STAGE.done, image, thumb });
        clearTimeout(handoff.current);
        handoff.current = setTimeout(() => {
          if (!current()) return;
          active.current = null;
          update(next.id, { status: "ready" });
        }, HANDOFF_MS);
      })
      .catch((e: unknown) => {
        if (!current()) return;
        active.current = null;
        update(next.id, { status: "error", progress: STAGE.done, error: errorText(e) });
      });
  }, [items, imagesSupported, locked, update]);

  useEffect(() => () => clearTimeout(handoff.current), []);

  const views = useMemo<AttachmentView[]>(
    () =>
      items.map((a) => {
        if (a.kind !== "image" || imagesSupported || a.status === "reading")
          return { ...a, byPath: false, busy: a.status === "queued" || a.status === "reading" };
        // 当前模型不看图：有路径的按路径引用，内存图片无法发送
        if (a.path) return { ...a, status: "ready", byPath: true, busy: false };
        return { ...a, status: "error", error: t.unsupportedPasted, byPath: false, busy: false };
      }),
    [items, imagesSupported],
  );

  const live = items.filter((a) => !a.removing);
  /** 还有图片在排队或读取：禁止发送 */
  const pending =
    imagesSupported &&
    live.some((a) => a.kind === "image" && (a.status === "queued" || a.status === "reading"));
  // 只统计能发送的附件：有路径的，或当前模型能看图、且没有读取失败的内存图片（否则会发出空消息）
  const hasContent = live.some(
    (a) => a.path !== undefined || (imagesSupported && a.status !== "error"),
  );

  /** 发送内容：能看图时图片放进 `images`，其余（以及不看图时的图片）按路径引用 */
  const build = useCallback((): { images: ImageContent[]; paths: string[] } => {
    const images: ImageContent[] = [];
    const paths: string[] = [];
    for (const a of items) {
      if (a.removing) continue;
      if (a.kind === "image" && imagesSupported && a.status === "ready" && a.image)
        images.push(a.image);
      else if (a.path) paths.push(a.path);
    }
    return { images, paths };
  }, [items, imagesSupported]);

  return {
    items: views,
    addPaths,
    addBlobs,
    remove,
    finalizeRemove,
    clear,
    pending,
    hasContent,
    build,
  };
}
