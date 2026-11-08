// 附件的文件引用标签：与 Core 命令行 `@file` 参数的原生格式一致（coding-agent/src/cli/file-processor.ts）。
//   空标签     `<file name="绝对路径"></file>`        只给路径，模型按需用工具读取（图片、二进制、超出上限的文本）
//   内联标签   `<file name="绝对路径">\n内容\n</file>`  文本文件在大小上限内直接带上内容
// 前端发送时只写空标签（附在消息正文之后），第一方扩展 primus-attach 在 Core 的 `input` 事件里
// 把能内联的文本文件展开成内联标签（技术方案第 8.3 节、附录 A）。时间线显示时再解析回附件标签。

/** 内联文本的上限：与 Core `read` 工具单次返回的上限一致（DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES） */
export const FILE_INLINE_MAX_BYTES = 50 * 1024;
export const FILE_INLINE_MAX_LINES = 2000;

/** 一个文件引用；`content` 缺省表示空标签（只有路径） */
export interface FileTag {
  path: string;
  content?: string;
}

const OPEN = '<file name="';
const CLOSE = "</file>";

/** 一个标签（末尾不带换行）。路径里的 `"` 无法表示（Windows 路径不允许出现），按原样写入 */
export function formatFileTag(tag: FileTag): string {
  return tag.content === undefined
    ? `${OPEN}${tag.path}">${CLOSE}`
    : `${OPEN}${tag.path}">\n${tag.content}\n${CLOSE}`;
}

/** 消息正文 + 附件标签：标签放在正文之后（会话标题与搜索取首条用户消息的开头），每个标签一行 */
export function appendFileTags(message: string, tags: readonly FileTag[]): string {
  if (tags.length === 0) return message;
  const block = tags.map(formatFileTag).join("\n");
  return message ? `${message}\n\n${block}` : block;
}

/** 从 `at` 开始解析一个标签；不是合法标签时返回 undefined */
function parseTagAt(text: string, at: number): { tag: FileTag; end: number } | undefined {
  if (!text.startsWith(OPEN, at)) return undefined;
  const nameEnd = text.indexOf('">', at + OPEN.length);
  if (nameEnd < 0) return undefined;
  const path = text.slice(at + OPEN.length, nameEnd);
  if (!path || path.includes("\n")) return undefined;
  const bodyStart = nameEnd + 2;
  if (text.startsWith(CLOSE, bodyStart)) return { tag: { path }, end: bodyStart + CLOSE.length };
  // 内联标签：`>\n内容\n</file>`；内容本身可能含 `</file>`，取后面紧跟换行或结尾的那一个
  if (text[bodyStart] !== "\n") return undefined;
  let close = text.indexOf(`\n${CLOSE}`, bodyStart);
  while (close >= 0) {
    const end = close + 1 + CLOSE.length;
    if (end === text.length || text[end] === "\n") {
      return { tag: { path, content: text.slice(bodyStart + 1, close) }, end };
    }
    close = text.indexOf(`\n${CLOSE}`, close + 1);
  }
  return undefined;
}

/** 从 `at` 开始解析连续的标签直到正文结尾；中途遇到别的内容返回 undefined */
function parseBlock(text: string, at: number): FileTag[] | undefined {
  const tags: FileTag[] = [];
  let i = at;
  while (i < text.length) {
    const parsed = parseTagAt(text, i);
    if (!parsed) return undefined;
    tags.push(parsed.tag);
    i = parsed.end;
    while (text[i] === "\n" || text[i] === "\r") i++;
  }
  return tags.length > 0 ? tags : undefined;
}

/**
 * 拆出消息末尾的附件标签（`appendFileTags` 的逆操作）。只认正文之后、一直到结尾都是标签的那一段：
 * 正文中间提到的 `<file …>` 不算附件
 */
export function splitFileTags(text: string): { message: string; files: FileTag[] } {
  const candidates: number[] = [];
  if (text.startsWith(OPEN)) candidates.push(0);
  for (let i = text.indexOf(`\n\n${OPEN}`); i >= 0; i = text.indexOf(`\n\n${OPEN}`, i + 1))
    candidates.push(i + 2);
  for (const at of candidates) {
    const files = parseBlock(text, at);
    if (files) return { message: text.slice(0, at).replace(/\s+$/, ""), files };
  }
  return { message: text, files: [] };
}
