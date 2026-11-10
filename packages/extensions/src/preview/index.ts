// primus-preview：自定义工具 `preview`，让模型在桌面端右栏打开文件或文件夹的预览（技术方案附录 A）。
// 工具只检查路径（不读内容给模型），再经 setWidget("primus:preview") 让前端在该会话所在标签的右栏打开；
// 结果不是笼统的“已完成”，而是结构化状态（packages/protocol 的 PreviewStatus）：
//   shown        已在右栏打开（附带类别与解析后的绝对路径）
//   unsupported  文件存在但没有内置预览：右栏已打开，用户只看到“用默认程序打开”
//   not_found    路径不存在
//   denied       受保护路径（与 primus-guard 相同的规则）、网址、网络 / 设备路径、格式不正确或无权访问
//   too_large    超过预览上限（与薄壳 preview.rs / attachments.rs 一致），没有打开
//   no_ui        没有可显示预览的界面（hasUI 为 false），没有打开
// 路径校验对照薄壳 open_path::check_path（预览命令都经它校验）：长度、控制字符、网址、网络 / 设备路径。
// 工具声明只读、不联网，primus-guard 按注解直接放行，不弹确认。

import { open, stat } from "node:fs/promises";
import {
  PREVIEW_DOCUMENT_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_MEDIA_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TOOL,
  PREVIEW_WIDGET,
  type PreviewData,
  type PreviewKind,
  type PreviewStatus,
  type PreviewToolDetails,
  previewKindOf,
} from "@primus/protocol";
import { isProtectedPath, realPath, resolveToolPath } from "../guard/index.ts";

/** 路径的最大长度（字符），与 open_path.rs 的 MAX_LEN 一致 */
const MAX_LEN = 4096;
/** 判断未知扩展名的文件是不是文本：读开头这么多字节找 NUL */
const SNIFF_BYTES = 8192;

/** 给模型看的文案（集中管理） */
const TEXT = {
  description:
    "在用户桌面应用的右栏打开文件或文件夹的预览（只给用户看，不把内容返回给你）。返回结构化状态：shown / unsupported / not_found / denied / too_large / no_ui。",
  pathParam: "要预览的文件或文件夹：相对当前工作目录，或绝对路径",
  snippet: "在用户的右栏预览中打开文件或文件夹",
  guidelines: [
    "用户要求查看 / 打开某个文件或文件夹，或你完成了一个交付物（报告、文档、网页、表格、图片等）需要给用户看时，调用 preview 在右栏打开它。",
    "不要每次写文件后都调用 preview；一轮里只预览最终要给用户看的那一个。preview 不返回文件内容，需要读内容请用 read。",
  ],
  status: {
    shown: "已在右栏打开预览",
    unsupported: "文件存在，但右栏没有这类文件的内置预览，用户只看到“用默认程序打开”",
    not_found: "路径不存在",
    denied: "不允许预览",
    too_large: "文件超过预览上限，没有打开",
    no_ui: "当前没有可显示预览的界面，没有打开",
  } satisfies Record<PreviewStatus, string>,
  reason: {
    format: "路径格式不正确",
    url: "只能预览本机文件，不能预览网址",
    network: "不支持网络路径或设备路径",
    protected: "受保护的路径（.env、.git、~/.ssh、应用数据目录）",
    special: "不是普通文件（设备、管道等）",
  },
} as const;

/** 网址或其他协议（`http:`、`mailto:`…）；Windows 盘符（`C:`）与 `file://` 不算（后者按本机路径解析） */
function hasScheme(raw: string): boolean {
  if (/^file:\/\//i.test(raw)) return false;
  if (raw.includes("://")) return true;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  return m?.[1] !== undefined && m[1].length > 1;
}

/** 网络路径（`\\server\share`、`//server/share`）与设备路径（`\\?\`、`\\.\`） */
const isNetworkOrDevice = (p: string) => /^[\\/]{2}/.test(p);

export interface PreviewEnv {
  platform: NodeJS.Platform;
  home?: string;
  env: Record<string, string | undefined>;
  real?: (p: string) => string;
}

const defaultEnv = (): PreviewEnv => ({ platform: process.platform, env: process.env });

/** 开头是否含 NUL（按二进制处理，与 preview.rs 一致） */
async function looksBinary(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** 该类别的大小上限：超过不打开；文本类只显示开头 1 MiB，不算超限 */
function limitOf(kind: PreviewKind, path: string): number | undefined {
  if (kind === "document") return PREVIEW_DOCUMENT_MAX_BYTES;
  // .xlsx / .xlsm 整份字节渲染；.csv / .tsv 按文本读取开头
  if (kind === "spreadsheet")
    return /\.xlsm?$/i.test(path) ? PREVIEW_DOCUMENT_MAX_BYTES : undefined;
  // SVG 按文本读取；GIF / ICO / AVIF 整份字节（与文档同一上限）；其余图片走 attachment_image
  if (kind === "image") {
    if (/\.svg$/i.test(path)) return undefined;
    return /\.(gif|ico|avif)$/i.test(path) ? PREVIEW_DOCUMENT_MAX_BYTES : PREVIEW_IMAGE_MAX_BYTES;
  }
  // 音频 / 视频整份字节交给播放器
  if (kind === "media") return PREVIEW_MEDIA_MAX_BYTES;
  return undefined;
}

/** 文本方式读取（右栏最多显示开头 1 MiB）的类别 */
const TEXT_READ = (kind: PreviewKind, path: string) =>
  kind === "text" ||
  kind === "markdown" ||
  kind === "html" ||
  (kind === "spreadsheet" && /\.(csv|tsv)$/i.test(path)) ||
  (kind === "image" && /\.svg$/i.test(path));

/**
 * 检查一次预览请求：不打开预览，只给出状态。`hasUI` 为 false 时，本来能打开的（shown / unsupported）改为 no_ui；
 * 不存在、被拒绝、超限的照实报告。
 */
export async function inspectPreview(
  input: string,
  cwd: string,
  hasUI: boolean,
  pe: PreviewEnv = defaultEnv(),
): Promise<PreviewToolDetails> {
  const raw = typeof input === "string" ? input.trim() : "";
  const denied = (reason: string, path?: string): PreviewToolDetails => ({
    status: "denied",
    input: raw,
    ...(path === undefined ? {} : { path }),
    reason,
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 与 open_path.rs 一样拒绝控制字符
  if (!raw || [...raw].length > MAX_LEN || /[\u0000-\u001f\u007f]/.test(raw))
    return denied(TEXT.reason.format);
  if (hasScheme(raw)) return denied(TEXT.reason.url);
  if (isNetworkOrDevice(raw)) return denied(TEXT.reason.network);
  const path = resolveToolPath(raw, cwd, pe.platform, pe.home);
  if (isNetworkOrDevice(path)) return denied(TEXT.reason.network, path);
  const real = realPath(path, pe.real);
  if (isNetworkOrDevice(real)) return denied(TEXT.reason.network, path);
  if (
    isProtectedPath(path, pe.env, pe.platform, pe.home) ||
    isProtectedPath(real, pe.env, pe.platform, pe.home)
  )
    return denied(TEXT.reason.protected, path);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { status: "not_found", input: raw, path, reason: TEXT.status.not_found };
    return denied(`无法访问：${(e as Error).message}`, path);
  }
  const ready = (
    status: "shown" | "unsupported",
    details: Omit<PreviewToolDetails, "status" | "input" | "path">,
  ) =>
    ({
      status: hasUI ? status : "no_ui",
      input: raw,
      path,
      ...details,
    }) satisfies PreviewToolDetails;

  if (info.isDirectory()) return ready("shown", { kind: "folder" });
  const size = Number(info.size);
  if (!info.isFile()) return ready("unsupported", { kind: "other", reason: TEXT.reason.special });

  let kind: PreviewKind = previewKindOf(path);
  if (kind === "text") {
    try {
      if (size > 0 && (await looksBinary(path))) kind = "other";
    } catch (e) {
      return denied(`无法访问：${(e as Error).message}`, path);
    }
  }
  if (kind === "other") return ready("unsupported", { kind, size });
  const limit = limitOf(kind, path);
  if (limit !== undefined && size > limit)
    return { status: "too_large", input: raw, path, kind, size, limit };
  return ready("shown", {
    kind,
    size,
    ...(TEXT_READ(kind, path) && size > PREVIEW_TEXT_MAX_BYTES ? { truncated: true } : {}),
  });
}

const MiB = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10} MiB`;

/** 给模型的一行结果：以状态开头，便于模型区分 */
export function previewText(d: PreviewToolDetails): string {
  const parts = [`[${d.status}] ${TEXT.status[d.status]}`];
  if (d.kind) parts.push(`类别 ${d.kind}`);
  if (d.size !== undefined && d.limit !== undefined)
    parts.push(`大小 ${MiB(d.size)}，上限 ${MiB(d.limit)}`);
  if (d.truncated) parts.push(`超过 ${MiB(PREVIEW_TEXT_MAX_BYTES)}，右栏只显示开头`);
  if (d.reason && d.reason !== TEXT.status[d.status]) parts.push(d.reason);
  return `${parts.join("；")}：${d.path ?? d.input}`;
}

/** 失败（没有打开预览）的状态：结果标为错误，模型据此调整 */
const FAILED = new Set<PreviewStatus>(["not_found", "denied", "too_large", "no_ui"]);

/** 扩展 API 中这里用到的部分（类型不从上游包导入，见 AGENTS.md 第 2.2 节） */
interface ToolContext {
  hasUI?: boolean;
  cwd?: string;
  ui?: { setWidget?: (key: string, lines: string[] | undefined) => void };
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: PreviewToolDetails;
  isError?: boolean;
}
interface PreviewApi {
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
    execute: (
      toolCallId: string,
      params: { path: string },
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ToolContext,
    ) => Promise<ToolResult>;
  }) => void;
}

/** 工具参数（JSON Schema；Core 对非 TypeBox 的 schema 按 JSON Schema 校验） */
export const PREVIEW_PARAMETERS = {
  type: "object",
  properties: { path: { type: "string", description: TEXT.pathParam } },
  required: ["path"],
  additionalProperties: false,
} as const;

/** 执行一次预览：检查路径，能打开时推 primus:preview 给前端 */
export async function runPreview(
  toolCallId: string,
  params: { path: string },
  ctx: ToolContext,
  pe?: PreviewEnv,
): Promise<ToolResult> {
  // 没有 setWidget 的上下文同样算没有界面
  const hasUI = ctx.hasUI === true && typeof ctx.ui?.setWidget === "function";
  const details = await inspectPreview(params?.path, ctx.cwd ?? process.cwd(), hasUI, pe);
  if ((details.status === "shown" || details.status === "unsupported") && details.path) {
    const data: PreviewData = {
      id: toolCallId,
      path: details.path,
      kind: details.kind ?? "other",
    };
    ctx.ui?.setWidget?.(PREVIEW_WIDGET, [JSON.stringify({ v: 1, type: "preview", data })]);
  }
  return {
    content: [{ type: "text", text: previewText(details) }],
    details,
    ...(FAILED.has(details.status) ? { isError: true } : {}),
  };
}

export default function preview(pi: unknown): void {
  const api = pi as Partial<PreviewApi> | null | undefined;
  if (typeof api?.registerTool !== "function") return;
  api.registerTool({
    name: PREVIEW_TOOL,
    label: "预览",
    description: TEXT.description,
    promptSnippet: TEXT.snippet,
    promptGuidelines: [...TEXT.guidelines],
    parameters: PREVIEW_PARAMETERS,
    // 只读、不联网：primus-guard 按注解直接放行（受保护路径由工具自己拒绝）
    annotations: { readOnlyHint: true, openWorldHint: false },
    execute: (toolCallId, params, _signal, _onUpdate, ctx) => runPreview(toolCallId, params, ctx),
  });
}
