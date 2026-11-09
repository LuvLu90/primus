// 回复里的文件引用识别：Markdown 链接的地址、行内代码里的路径。
// 只做字符串判断，不访问文件系统；宁可漏判也不把网址、普通代码当成文件。
import type { FileIconName } from "@/components/icons";

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

/** 有扩展名时按扩展名选彩色文件类型图标（Map 查表：constructor、__proto__ 这类扩展名不会命中原型属性） */
const ICON_BY_EXT = new Map<string, FileIconName>();
const groups: [FileIconName, string][] = [
  // 代码
  ["typescript", "ts mts cts"],
  ["react-ts", "tsx"],
  ["javascript", "js mjs cjs"],
  ["react", "jsx"],
  ["json", "json jsonc json5"],
  ["rust", "rs"],
  ["python", "py pyi"],
  ["ruby", "rb"],
  ["go", "go"],
  ["java", "java"],
  ["c", "c h"],
  ["cpp", "cc cpp cxx hpp hh"],
  ["csharp", "cs"],
  ["swift", "swift"],
  ["php", "php"],
  ["lua", "lua"],
  ["dart", "dart"],
  ["scala", "scala"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["html", "html htm"],
  ["css", "css less styl"],
  ["sass", "scss sass"],
  ["console", "sh bash zsh fish bat cmd"],
  ["powershell", "ps1 psm1 psd1"],
  ["xml", "xml xsl wxs wxi plist csproj vcxproj props targets"],
  ["yaml", "yaml yml"],
  ["toml", "toml"],
  ["settings", "ini cfg conf env sln nsi cmake gradle tf hcl prisma"],
  ["lock", "lock"],
  ["makefile", "mk"],
  ["database", "sql db sqlite"],
  ["graphql", "graphql gql"],
  ["diff", "patch diff"],
  ["docker", "dockerfile"],
  // 没有专属图标的语言：认作文件，用通用图标
  ["file", "kt kts fs vb clj ex exs erl hs ml zig nim r jl pl astro proto"],
  // 文档
  ["markdown", "md mdx markdown"],
  ["document", "txt text rst adoc org bib srt vtt"],
  ["log", "log"],
  ["tex", "tex"],
  ["word", "doc docx odt rtf pages wps"],
  ["pdf", "pdf"],
  ["table", "csv tsv xls xlsx xlsm ods numbers parquet"],
  ["powerpoint", "ppt pptx odp key"],
  // 媒体、字体、归档与安装包
  ["image", "png jpg jpeg gif webp bmp ico icns tif tiff heic avif psd ai sketch fig"],
  ["svg", "svg"],
  ["video", "mp4 mov mkv avi webm wmv flv m4v"],
  ["audio", "mp3 wav flac aac ogg m4a opus"],
  ["font", "ttf otf woff woff2"],
  ["zip", "zip 7z rar tar gz tgz bz2 xz zst cab deb rpm jar war whl nupkg"],
  ["exe", "exe msi msix dmg pkg appx"],
  // 库与数据文件：认作文件，用通用图标
  ["file", "dll so dylib lib bin dat wasm pdb"],
];
for (const [icon, list] of groups) for (const ext of list.split(" ")) ICON_BY_EXT.set(ext, icon);

/** 不带扩展名但一看就是文件的名字（小写）→ 图标 */
const KNOWN_BARE = new Map<string, FileIconName>([
  ["makefile", "makefile"],
  ["dockerfile", "docker"],
  ["license", "license"],
  ["readme", "readme"],
  ["changelog", "document"],
  ["gemfile", "ruby"],
  ["rakefile", "ruby"],
  ["procfile", "settings"],
  ["justfile", "makefile"],
  ["cargo.lock", "lock"],
]);

/** 以点开头的配置文件（.gitignore、.env…）→ 图标 */
const DOTFILES = new Map<string, FileIconName>([
  [".gitignore", "git"],
  [".gitattributes", "git"],
  [".gitmodules", "git"],
  [".env", "settings"],
  [".editorconfig", "settings"],
  [".npmrc", "settings"],
  [".dockerignore", "docker"],
]);

/** 按文件名选彩色文件类型图标（附件、工具行与文件引用共用）；认不出的用通用 file */
export function fileIconForName(fileName: string): FileIconName {
  const lower = fileName.toLowerCase();
  const bare = KNOWN_BARE.get(lower) ?? DOTFILES.get(lower);
  if (bare) return bare;
  const dot = lower.lastIndexOf(".");
  return (dot > 0 && ICON_BY_EXT.get(lower.slice(dot + 1))) || "file";
}

/** 文件引用的图标 */
export function fileRefIcon(ref: Pick<FileRef, "name" | "isDir">): FileIconName {
  return ref.isDir ? "folder" : fileIconForName(ref.name);
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

/**
 * 控制字符、Windows 不允许的字符不行；空格只允许出现在 Windows 绝对路径（C:\\Program Files\\…）
 * 与 file:// 地址（`allowSpace`，已解码的 `My%20Project`）里
 */
function plausibleChars(p: string, allowSpace = false): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 排除控制字符
  if (/[\u0000-\u001f<>"|*]/.test(p)) return false;
  if (/\s/.test(p) && !allowSpace && !WIN_ABS.test(p) && !/^file:/i.test(p)) return false;
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
  // 先按原文分出 #片段再解码：文件名里编码的 %23 解码成 # 后不能被当成片段
  let hash: string | null = null;
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) {
    hash = raw.slice(hashAt + 1);
    raw = raw.slice(0, hashAt);
  }
  const isFileUri = /^file:/i.test(raw);
  if (isFileUri) {
    // 只接受本机地址：file:///x、file://localhost/x、file:/x；file://server/share 是网络引用，不算
    const m = /^file:(?:\/\/([^/\\]*))?(.*)$/is.exec(raw);
    const authority = m?.[1] ?? "";
    let rest = m?.[2] ?? "";
    if (/^[A-Za-z]:$/.test(authority)) rest = authority + rest;
    else if (authority && authority.toLowerCase() !== "localhost") return null;
    raw = safeDecode(rest);
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
  if (!plausibleChars(raw, isFileUri)) return null;
  let pos: Position = {};
  if (hash !== null) pos = parseHashLines(safeDecode(hash)) ?? {};
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
  if (!ext || ext === "log" || !ICON_BY_EXT.has(ext)) return null;
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

/**
 * 打开文件用的路径：绝对路径（含 Windows 盘符、`/`、`~/`）原样交给薄壳；相对路径按会话工作区 `base` 拼接，
 * 折叠 `.` 与 `..`，分隔符跟随工作区（Windows 工作区用反斜杠）。行号在识别时已去掉（`ref.path` 不带）。
 * 无法定位时返回 null：相对路径但没有工作区、`@/` 这类打包别名、`~user/`。
 */
export function resolveFileRefPath(path: string, base: string | null): string | null {
  // 文件夹去掉末尾斜杠；只剩根（`/`、`C:\`）时保留
  const trimmed = path.replace(/[\\/]+$/, "");
  const p = trimmed && !/^[A-Za-z]:$/.test(trimmed) ? trimmed : path;
  if (WIN_ABS.test(p) || UNC.test(p) || /^[\\/]/.test(p) || p === "~" || /^~[\\/]/.test(p))
    return p;
  if (p.startsWith("@") || p.startsWith("~")) return null;
  if (!base) return null;
  const windows = WIN_ABS.test(base) || /^[\\/]{2}/.test(base);
  const sep = windows ? "\\" : "/";
  const lead = /^[\\/]{2}/.test(base) ? sep + sep : base.startsWith("/") ? "/" : "";
  const segments = base.split(/[\\/]+/).filter(Boolean);
  // 不能退到根之上：盘符（C:）或 UNC 的 \\服务器\共享 保留
  const floor = WIN_ABS.test(base) ? 1 : lead.length === 2 ? 2 : 0;
  for (const part of p.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length > floor) segments.pop();
    } else segments.push(part);
  }
  return lead + segments.join(sep);
}
