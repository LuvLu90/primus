// 回复里的文件引用识别：Markdown 链接的地址、行内代码里的路径。
// 只做字符串判断，不访问文件系统；宁可漏判也不把网址、普通代码当成文件。
import type { IconName } from "@/components/icons";

export interface FileRef {
  /** 去掉行号、片段与 file:// 后的路径（保持原样的分隔符） */
  path: string;
  /** 显示用的名称：路径最后一段（文件夹不带末尾斜杠） */
  name: string;
  /** 起始行（1 起） */
  line?: number;
  /** 结束行；只有范围时才有，且大于 line */
  endLine?: number;
  /** 列（只在单行时有） */
  column?: number;
  /** 路径以斜杠结尾：文件夹 */
  isDir: boolean;
}

/** 有扩展名时按扩展名选文件图标 */
const ICON_BY_EXT: Record<string, IconName> = {};
const groups: [IconName, string][] = [
  [
    "file-code",
    "ts tsx js jsx mjs cjs mts cts json jsonc json5 rs py pyi rb go java kt kts swift c h cc cpp cxx hpp hh cs fs vb php lua dart scala clj ex exs erl hs ml zig nim r jl pl sh bash zsh fish ps1 psm1 psd1 bat cmd vue svelte astro html htm css scss sass less styl xml xsl yaml yml toml ini cfg conf env lock gradle cmake mk sql graphql gql proto wxs wxi nsi plist sln csproj vcxproj props targets patch diff dockerfile tf hcl prisma",
  ],
  ["file-text", "md mdx markdown txt text log rst adoc org tex bib srt vtt"],
  ["file-doc", "doc docx odt rtf pages wps"],
  ["file-pdf", "pdf"],
  ["file-image", "png jpg jpeg gif webp bmp svg ico icns tif tiff heic avif psd ai sketch fig"],
  ["file-sheet", "csv tsv xls xlsx xlsm ods numbers parquet"],
  [
    "file-zip",
    "zip 7z rar tar gz tgz bz2 xz zst msi msix dmg pkg deb rpm appx cab jar war whl nupkg",
  ],
  ["file-video", "mp4 mov mkv avi webm wmv flv m4v mp3 wav flac aac ogg m4a opus"],
  ["file-slides", "ppt pptx odp key"],
  // 可执行文件、库与数据文件：认作文件，用通用图标
  ["file", "exe dll so dylib lib bin dat db sqlite wasm pdb"],
];
for (const [icon, list] of groups) for (const ext of list.split(" ")) ICON_BY_EXT[ext] = icon;

/** 不带扩展名但一看就是文件的名字 */
const KNOWN_BARE = new Set([
  "makefile",
  "dockerfile",
  "license",
  "readme",
  "changelog",
  "gemfile",
  "rakefile",
  "procfile",
  "justfile",
  "cargo.lock",
]);

/** 文件引用的图标 */
export function fileRefIcon(ref: Pick<FileRef, "name" | "isDir">): IconName {
  if (ref.isDir) return "folder";
  const lower = ref.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext =
    dot > 0 ? lower.slice(dot + 1) : lower === "dockerfile" || lower === "makefile" ? lower : "";
  if (ext === "makefile") return "file-code";
  return ICON_BY_EXT[ext] ?? "file";
}

/** 名称是否带一个合理的扩展名（字母开头，1–10 位字母数字） */
function extOf(name: string): string | null {
  const m = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name);
  return m && m.index > 0 ? (m[1] as string).toLowerCase() : null;
}

/** 网址或其他协议（mailto:、tel:、javascript:…）；Windows 盘符（C:）不算 */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]+:/;
const WIN_ABS = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\/\s]+[\\/]/;

interface Position {
  line?: number;
  endLine?: number;
  column?: number;
}

/** 解析行号片段：L42、L42-L58、L42-58、L42C7 */
function parseHashLines(hash: string): Position | null {
  const m = /^L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/i.exec(hash);
  if (!m) return null;
  return position(m[1], m[3], m[2]);
}

function position(start?: string, end?: string, col?: string): Position {
  const line = start ? Number(start) : undefined;
  if (!line) return {};
  const endLine = end ? Number(end) : undefined;
  if (endLine && endLine > line) return { line, endLine };
  return col && Number(col) > 0 ? { line, column: Number(col) } : { line };
}

/** 去掉路径末尾的 :42、:42:7、:42-58，返回路径与行号 */
function splitColonLines(raw: string): { path: string; pos: Position } {
  const m = /:(\d+)(?:-(\d+)|:(\d+))?$/.exec(raw);
  if (!m || m.index === 0) return { path: raw, pos: {} };
  const path = raw.slice(0, m.index);
  // C:1 这类只有盘符的不算
  if (/^[A-Za-z]$/.test(path)) return { path: raw, pos: {} };
  return { path, pos: position(m[1], m[2], m[3]) };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function build(path: string, pos: Position): FileRef | null {
  const isDir = /[\\/]$/.test(path) && path.length > 1;
  const trimmed = isDir ? path.replace(/[\\/]+$/, "") : path;
  const name = trimmed.split(/[\\/]/).pop() ?? "";
  if (!name || name === "." || name === ".." || name === "~") return null;
  return { path, name, isDir, ...pos };
}

/** 控制字符、Windows 不允许的字符不行；空格只允许出现在 Windows 绝对路径里（C:\\Program Files\\…） */
function plausibleChars(p: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 排除控制字符
  if (/[\u0000-\u001f<>"|*]/.test(p)) return false;
  if (/\s/.test(p) && !WIN_ABS.test(p) && !/^file:/i.test(p)) return false;
  return true;
}

/** 是否像路径：绝对路径、~/、./、../、@/ 别名，或含分隔符 */
const hasSep = (p: string) => /[\\/]/.test(p);
const isAnchored = (p: string) =>
  WIN_ABS.test(p) || UNC.test(p) || /^(?:~|\.{1,2}|@)?[\\/]/.test(p);

/**
 * Markdown 链接地址 → 文件引用。接受相对 / 绝对路径、file://、Windows 路径，
 * 可带 `:42`、`:42:7`、`:42-58` 或 `#L42`、`#L42-L58`；http(s)、mailto 等协议和纯锚点 `#x` 不算。
 */
export function fileRefFromHref(href: string): FileRef | null {
  let raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("//")) return null;
  if (/^file:/i.test(raw)) {
    raw = safeDecode(raw.replace(/^file:(?:\/\/(?:localhost)?)?/i, ""));
    // file:///C:/x → C:/x
    if (/^\/[A-Za-z]:[\\/]/.test(raw)) raw = raw.slice(1);
  } else {
    if (SCHEME.test(raw) && !WIN_ABS.test(raw)) {
      // chat-panel.tsx:42 也满足 “协议:” 的形状：只有冒号后面全是行号时才当路径
      if (!/^[^:/\\]+\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?:[-:]\d+)?$/.test(raw)) return null;
    }
    if (/^www\./i.test(raw)) return null;
    raw = safeDecode(raw);
  }
  if (!plausibleChars(raw)) return null;
  let pos: Position = {};
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) {
    pos = parseHashLines(raw.slice(hashAt + 1)) ?? {};
    raw = raw.slice(0, hashAt);
  }
  if (!pos.line) {
    const split = splitColonLines(raw);
    raw = split.path;
    pos = split.pos;
  }
  if (!raw) return null;
  return build(raw, pos);
}

/**
 * 行内代码 → 文件引用。比链接严格：不能有空白和代码符号；
 * 有分隔符时要有扩展名（或以斜杠结尾 / 是绝对路径且至少两段）；
 * 只有文件名时扩展名必须是常见文件类型（`console.log`、`rows.filter` 不算）。
 */
export function fileRefFromCode(code: string): FileRef | null {
  const text = code.trim();
  if (!text || text.length > 260 || text !== code) return null;
  if (/^file:/i.test(text)) return fileRefFromHref(text);
  if (!plausibleChars(text) || /[()'`=,;&$!^{}]/.test(text)) return null;
  if (SCHEME.test(text) && !WIN_ABS.test(text) && !/^[^:/\\]+\.[A-Za-z]\w*:\d/.test(text))
    return null;
  let raw = text;
  let pos: Position = {};
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) {
    const lines = parseHashLines(raw.slice(hashAt + 1));
    if (!lines) return null;
    pos = lines;
    raw = raw.slice(0, hashAt);
  } else {
    const split = splitColonLines(raw);
    raw = split.path;
    pos = split.pos;
  }
  if (!raw || /^\.+$/.test(raw)) return null;
  if (/[\\/]{2,}/.test(raw.replace(/^\\\\/, ""))) return null;
  const ref = build(raw, pos);
  if (!ref) return null;
  const ext = extOf(ref.name);
  if (ref.isDir) return hasSep(raw.slice(0, -1)) || isAnchored(raw) || raw.length > 1 ? ref : null;
  if (hasSep(raw)) {
    if (ext) return ref;
    if (KNOWN_BARE.has(ref.name.toLowerCase())) return ref;
    // 无扩展名：只认锚定的绝对 / 相对路径，且至少两段（/compact 这类斜杠命令不算）
    const segments = raw.split(/[\\/]/).filter(Boolean);
    return isAnchored(raw) && segments.length >= 2 ? ref : null;
  }
  if (KNOWN_BARE.has(ref.name.toLowerCase())) return ref;
  if (!ext || ext === "log" || !(ext in ICON_BY_EXT)) return null;
  return ref;
}

/** 行号的显示文字：`:42`、`:42:7`、`:42–58` */
export function fileRefLineLabel(ref: FileRef): string {
  if (!ref.line) return "";
  if (ref.endLine) return `:${ref.line}–${ref.endLine}`;
  return ref.column ? `:${ref.line}:${ref.column}` : `:${ref.line}`;
}

/** 复制到剪贴板的文字：路径加行号（编辑器能直接跳转的 `path:42` 形式） */
export function fileRefCopyText(ref: FileRef): string {
  if (!ref.line) return ref.path;
  return ref.column ? `${ref.path}:${ref.line}:${ref.column}` : `${ref.path}:${ref.line}`;
}
