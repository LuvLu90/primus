// primus-attach：把输入框附件展开成 Core 原生的 `<file>` 引用（与 CLI `@file` 参数的 file-processor 一致）。
// 前端发送时在正文之后附上空标签 `<file name="绝对路径"></file>`（图片同时放进 prompt.images），
// 这里在 Core 的 `input` 事件（模板展开之前）里逐个检查：
//   - 文本文件、非空、不超过上限（与 read 工具单次返回的上限一致）：内联成 `<file name="…">\n内容\n</file>`
//   - 图片、二进制（含 NUL、不是合法 UTF-8、PDF/ZIP/OLE 文件头）、超出上限、读不到：保持空标签，模型按路径用工具读取
// 与 CLI 的差别：CLI 不判断二进制（xlsx 会被当乱码内联），这里不内联二进制；标签放在正文之后（会话标题取消息开头）。

import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  appendFileTags,
  FILE_INLINE_MAX_BYTES,
  FILE_INLINE_MAX_LINES,
  type FileTag,
  splitFileTags,
} from "@primus/protocol";

/** 扩展 API 中这里用到的部分（类型不从上游包导入，见 AGENTS.md 第 2.2 节） */
interface InputEvent {
  text: string;
  images?: unknown[];
  source?: string;
}
type InputResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: unknown[] };
interface AttachApi {
  on?: (
    event: "input",
    handler: (event: InputEvent, ctx: { cwd?: string } | undefined) => Promise<InputResult>,
  ) => void;
}

/** 二进制文件头：PDF、ZIP（xlsx/docx/pptx 等）、OLE（xls/doc/ppt）、常见图片 */
const BINARY_MAGIC: readonly number[][] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // PK..
  [0xd0, 0xcf, 0x11, 0xe0], // OLE
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x52, 0x49, 0x46, 0x46], // RIFF（WebP 等）
  [0x42, 0x4d], // BMP
];

const startsWith = (buf: Uint8Array, magic: readonly number[]) =>
  buf.length >= magic.length && magic.every((b, i) => buf[i] === b);

/** 按内容判断能否当文本内联：返回去掉 BOM 的文本；二进制返回 undefined */
export function decodeText(buf: Uint8Array): string | undefined {
  if (BINARY_MAGIC.some((m) => startsWith(buf, m))) return undefined;
  if (buf.includes(0)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

/** 读取一个附件：能内联时返回内容，否则返回 undefined（保持空标签） */
export async function readInline(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > FILE_INLINE_MAX_BYTES) return undefined;
    const handle = await open(path, "r");
    try {
      const buf = new Uint8Array(info.size);
      const { bytesRead } = await handle.read(buf, 0, info.size, 0);
      const text = decodeText(buf.subarray(0, bytesRead));
      if (text === undefined || text.split("\n").length > FILE_INLINE_MAX_LINES) return undefined;
      return text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** 展开消息末尾的空标签；没有可展开的标签时返回 undefined */
export async function expandAttachments(
  text: string,
  cwd: string,
  read: (path: string) => Promise<string | undefined> = readInline,
): Promise<string | undefined> {
  const { message, files } = splitFileTags(text);
  if (files.length === 0) return undefined;
  let changed = false;
  const expanded: FileTag[] = [];
  for (const file of files) {
    if (file.content !== undefined) {
      expanded.push(file);
      continue;
    }
    const content = await read(isAbsolute(file.path) ? file.path : resolve(cwd, file.path));
    if (content === undefined) expanded.push(file);
    else {
      changed = true;
      expanded.push({ path: file.path, content });
    }
  }
  return changed ? appendFileTags(message, expanded) : undefined;
}

export default function attach(pi: unknown): void {
  const api = pi as AttachApi | null | undefined;
  if (typeof api?.on !== "function") return;
  api.on("input", async (event, ctx) => {
    // 只处理用户输入（桌面端经 RPC 发送）；扩展自己发出的消息不改
    if (event?.source === "extension" || typeof event?.text !== "string")
      return { action: "continue" };
    const text = await expandAttachments(event.text, ctx?.cwd ?? process.cwd());
    return text === undefined
      ? { action: "continue" }
      : { action: "transform", text, images: event.images };
  });
}
