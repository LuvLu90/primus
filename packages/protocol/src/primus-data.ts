// 扩展 → 前端的 primus:* 数据（第 6.6 节、附录 A）：setWidget("primus:<主题>", [JSON.stringify(PrimusData)])。

/** 上下文清单的数据主题（primus-context-stats，前端发 `/primus-context-stats` 后推送） */
export const CONTEXT_STATS_WIDGET = "primus:context-stats";
export const CONTEXT_STATS_COMMAND = "primus-context-stats";

/**
 * 上下文里已加载的内容分组。只列名称，不给 token 数：Core 不提供分项 token 统计，
 * 上下文的 token 数只以 Core 的 contextUsage 为准（不估算）
 */
export type ContextStatsGroupKey = "systemTools" | "mcpTools" | "skills" | "memoryFiles";

export interface ContextStatsGroup {
  key: ContextStatsGroupKey;
  /** 工具名、技能名或记忆文件路径，按名称排序 */
  items: string[];
}

/** 本会话实际调用过的一个工具 */
export interface ContextStatsUsedTool {
  name: string;
  /** 调用次数（当前分支的 assistant 消息里 toolCall 的个数） */
  count: number;
}

/** `primus:context-stats` 的 data：只读清单，不改动上下文，不含任何估算值 */
export interface ContextStatsData {
  /** 已声明给模型的工具、系统提示词里列出的技能与记忆文件（名称） */
  groups: ContextStatsGroup[];
  /**
   * 本会话（当前分支）实际调用过的工具，按次数从多到少。未启用、未调用的工具（延迟加载 / 只供代码模式 / 关闭）
   * 不列出：它们不在上下文里
   */
  usedTools: ContextStatsUsedTool[];
}

// ---------- primus-preview：AI 在右栏打开预览（附录 A） ----------

/** 预览工具名（primus-preview 注册的自定义工具） */
export const PREVIEW_TOOL = "preview";
/** 让前端在该会话的右栏打开预览的数据主题 */
export const PREVIEW_WIDGET = "primus:preview";

/**
 * 预览的内容类别（按扩展名，与右栏 file-preview.tsx 的渲染方式对应）：
 * folder 文件夹；text 等宽原样显示的文本；markdown 渲染后的 Markdown；image 图片（含 SVG）；
 * html 沙箱里渲染的网页；document Word / PowerPoint / PDF；spreadsheet Excel / CSV / TSV 表格；
 * media 音频 / 视频；other 没有内置预览的文件（右栏只给“用默认程序打开”）
 */
export type PreviewKind =
  | "folder"
  | "text"
  | "markdown"
  | "image"
  | "html"
  | "document"
  | "spreadsheet"
  | "media"
  | "other";

/**
 * 预览工具的结果状态：
 * shown 已在右栏打开；unsupported 文件存在但没有内置预览，右栏已打开、只显示“用默认程序打开”；
 * not_found 路径不存在；denied 被拒绝（受保护路径、网址、网络 / 设备路径、格式不正确、无权访问）；
 * too_large 超过预览上限，没有打开；no_ui 没有可显示预览的界面（例如没有桌面前端），没有打开
 */
export type PreviewStatus =
  | "shown"
  | "unsupported"
  | "not_found"
  | "denied"
  | "too_large"
  | "no_ui";

/** 预览上限（与薄壳 preview.rs / attachments.rs 一致） */
export const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;
export const PREVIEW_DOCUMENT_MAX_BYTES = 30 * 1024 * 1024;
export const PREVIEW_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PREVIEW_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

/** 预览工具结果的 details（同时给前端与程序化调用方） */
export interface PreviewToolDetails {
  status: PreviewStatus;
  /** 模型传入的原始路径 */
  input: string;
  /** 解析后的绝对路径（格式不正确时没有） */
  path?: string;
  /** 内容类别（路径存在时） */
  kind?: PreviewKind;
  /** 文件大小（字节；文件夹没有） */
  size?: number;
  /** too_large 时适用的上限（字节） */
  limit?: number;
  /** 文本类文件超过 1 MiB：右栏只显示开头 */
  truncated?: boolean;
  /** denied / not_found 等的具体原因（给模型看） */
  reason?: string;
}

/** `primus:preview` 的 data：在该会话所在标签的右栏打开 path */
export interface PreviewData {
  /** 每次请求唯一（工具调用 ID）：同一路径再次预览也重新打开 */
  id: string;
  /** 绝对路径 */
  path: string;
  kind: PreviewKind;
}

const PREVIEW_EXT: Record<Exclude<PreviewKind, "folder" | "text" | "other">, readonly string[]> = {
  markdown: ["md", "markdown", "mdx"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"],
  html: ["html", "htm", "xhtml"],
  document: ["docx", "pptx", "pdf"],
  spreadsheet: ["xlsx", "xlsm", "csv", "tsv"],
  media: [
    "mp3",
    "wav",
    "ogg",
    "oga",
    "m4a",
    "aac",
    "flac",
    "opus",
    "mp4",
    "webm",
    "ogv",
    "mov",
    "m4v",
  ],
};

/** 没有内置预览的已知二进制格式（旧版 Office、压缩包、可执行文件等）：不必读内容就归为 other */
const OTHER_EXT = new Set([
  "doc",
  "ppt",
  "xls",
  "zip",
  "7z",
  "rar",
  "gz",
  "tar",
  "exe",
  "dll",
  "msi",
  "iso",
  "bin",
]);

/**
 * 按文件名的扩展名判断预览类别（不区分大小写）。没有对应渲染方式的扩展名返回 text：
 * 是否真是文本由调用方按内容判断（含 NUL 等二进制内容时改为 other）
 */
export function previewKindOf(path: string): Exclude<PreviewKind, "folder"> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  for (const [kind, exts] of Object.entries(PREVIEW_EXT))
    if (exts.includes(ext)) return kind as Exclude<PreviewKind, "folder">;
  return OTHER_EXT.has(ext) ? "other" : "text";
}
