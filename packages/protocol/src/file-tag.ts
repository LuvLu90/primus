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

/**
 * 从 `at` 开始解析一个标签，返回所有可能的结束位置（不是合法标签时为空）。内联内容本身可能含独占一行的 `</file>`，
 * 这样的位置都是候选，由 parseBlock 选出能让后面也解析成功的那一个
 */
function parseTagAt(text: string, at: number): { tag: FileTag; end: number }[] {
  if (!text.startsWith(OPEN, at)) return [];
  const nameEnd = text.indexOf('">', at + OPEN.length);
  if (nameEnd < 0) return [];
  const path = text.slice(at + OPEN.length, nameEnd);
  if (!path || path.includes("\n")) return [];
  const bodyStart = nameEnd + 2;
  if (text.startsWith(CLOSE, bodyStart)) return [{ tag: { path }, end: bodyStart + CLOSE.length }];
  // 内联标签：`>\n内容\n</file>`；`</file>` 后面必须紧跟换行或结尾
  if (text[bodyStart] !== "\n") return [];
  const found: { tag: FileTag; end: number }[] = [];
  for (
    let close = text.indexOf(`\n${CLOSE}`, bodyStart);
    close >= 0;
    close = text.indexOf(`\n${CLOSE}`, close + 1)
  ) {
    const end = close + 1 + CLOSE.length;
    if (end === text.length || text[end] === "\n")
      found.push({ tag: { path, content: text.slice(bodyStart + 1, close) }, end });
  }
  return found;
}

/**
 * 从 `at` 开始解析连续的标签直到正文结尾；中途遇到别的内容返回 undefined。
 * `failed` 记下已确定解析不下去的位置，避免回溯时重复尝试
 */
function parseBlock(text: string, at: number, failed = new Set<number>()): FileTag[] | undefined {
  if (at >= text.length) return [];
  if (failed.has(at)) return undefined;
  // 优先取最近的结束位置，后面解析不下去时再试更远的（内容里含独占一行的 `</file>`）
  for (const parsed of parseTagAt(text, at)) {
    let i = parsed.end;
    while (text[i] === "\n" || text[i] === "\r") i++;
    const rest = parseBlock(text, i, failed);
    if (rest) return [parsed.tag, ...rest];
  }
  failed.add(at);
  return undefined;
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
    if (files && files.length > 0) return { message: text.slice(0, at).replace(/\s+$/, ""), files };
  }
  return { message: text, files: [] };
}
