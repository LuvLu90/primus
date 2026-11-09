// 剪贴板 / 拖放进来的内存图片：在 WebView 里解码、按最长边缩小并编码，结果只留在内存（约束 C2）。
import type { ImageContent } from "@primus/protocol";
import { strings } from "@/lib/strings";

/** 读取阶段的真实进度：解码完成、编码完成（由调用方映射到进度环） */
export type BlobStage = "decoded" | "encoded";

export interface ReadImageResult {
  image: ImageContent;
  /** 缩略图 data URL（短边约 112px） */
  thumb: string;
}

const THUMB_EDGE = 112;

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}

/** 画布上是否有不完全不透明的像素（透明 WebP / GIF 编码成 JPEG 时透明处会变黑） */
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, w, h);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  } catch {
    // 读不到像素时按不透明处理
  }
  return false;
}

/**
 * 解码 → 按最长边 `maxEdge` 缩小 → PNG 原样保持 PNG（截图、带透明），带透明像素的其他格式也编码为 PNG，其余编码为 JPEG。
 * 解码失败、浏览器不支持 createImageBitmap 或画布不可用时拒绝。
 */
export async function readImageBlob(
  blob: Blob,
  maxEdge: number,
  onStage?: (stage: BlobStage) => void,
): Promise<ReadImageResult> {
  if (typeof createImageBitmap !== "function")
    throw new Error(strings.chat.attachments.imageUnsupported);
  const bitmap = await createImageBitmap(blob);
  try {
    onStage?.("decoded");
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(strings.chat.attachments.imageUnsupported);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const keepPng =
      blob.type === "image/png" ||
      (blob.type !== "image/jpeg" && hasTransparency(ctx, canvas.width, canvas.height));
    const mimeType = keepPng ? "image/png" : "image/jpeg";
    const url = canvas.toDataURL(mimeType, 0.85);
    onStage?.("encoded");
    const short = Math.min(canvas.width, canvas.height);
    const t = Math.min(1, THUMB_EDGE / short);
    const thumbCanvas = canvasOf(canvas.width * t, canvas.height * t);
    thumbCanvas.getContext("2d")?.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = thumbCanvas.toDataURL(mimeType, 0.8);
    return {
      image: { type: "image", mimeType, data: url.slice(url.indexOf(",") + 1) },
      thumb,
    };
  } finally {
    bitmap.close();
  }
}
