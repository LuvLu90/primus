// 附件类型：按扩展名决定图块的图标；只有 `image` 会被读取成图片发给模型（其余按路径引用）。

export type AttachmentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "video"
  | "other";

/** 薄壳 `attachment_image` 能解码的格式（与 Rust 端一致） */
const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const DOCUMENT = ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "pages", "epub"];
const SPREADSHEET = ["xls", "xlsx", "xlsm", "csv", "tsv", "ods", "numbers"];
const PRESENTATION = ["ppt", "pptx", "pps", "ppsx", "odp", "key"];
const CODE = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "lua",
  "dart",
  "scala",
  "r",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "sql",
  "yaml",
  "yml",
  "toml",
  "ini",
  "xml",
  "svg",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
];
const VIDEO = ["mp4", "mov", "m4v", "avi", "mkv", "webm", "wmv", "flv", "mpg", "mpeg"];

const BY_EXT = new Map<string, AttachmentKind>([
  ...IMAGE.map((e) => [e, "image"] as const),
  ...DOCUMENT.map((e) => [e, "document"] as const),
  ...SPREADSHEET.map((e) => [e, "spreadsheet"] as const),
  ...PRESENTATION.map((e) => [e, "presentation"] as const),
  ...CODE.map((e) => [e, "code"] as const),
  ...VIDEO.map((e) => [e, "video"] as const),
]);

/** 扩展名（小写，不含点）；没有扩展名时为空串。兼容 `\` 与 `/` 分隔的路径 */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 文件名或路径 → 附件类型 */
export function attachmentKind(name: string): AttachmentKind {
  return BY_EXT.get(extensionOf(name)) ?? "other";
}

/** MIME 类型 → 附件类型（剪贴板、拖放的内存文件） */
export function kindFromMime(mime: string): AttachmentKind {
  return mime.startsWith("image/") && IMAGE.some((e) => mime.endsWith(e === "jpg" ? "jpeg" : e))
    ? "image"
    : "other";
}
