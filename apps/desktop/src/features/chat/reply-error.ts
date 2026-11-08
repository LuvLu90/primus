// 回复出错时的错误归类与元信息（纯函数，界面在 error-card.tsx）。
// Core 的 AssistantMessage 只给出 `errorMessage` 文本，没有结构化的状态码与原因：
//   - 有 HTTP 状态码时文本为 `{provider} API error ({status}): …`（ai/src/utils/error-body.ts），这里从文本解析；
//   - 连接错误只剩 SDK 的 `Connection error.`，底层原因（ECONNREFUSED 等）被丢掉，只有文本里带上时才识别得出。
import type { AssistantMessage } from "@primus/protocol";

export type ErrorCategory =
  | "connection"
  | "auth"
  | "rateLimit"
  | "server"
  | "invalid"
  | "aborted"
  | "unknown";

/** 连接错误的具体原因（文本里带上底层错误码时才有） */
export type ConnectionReason = "dns" | "refused" | "certificate" | "timeout" | "reset";

export interface ErrorInfo {
  category: ErrorCategory;
  /** 从错误文本解析出的 HTTP 状态码 */
  status?: number;
  reason?: ConnectionReason;
}

/**
 * 从错误文本里找 HTTP 状态码：`API error (429)`、`429 Too Many Requests`、`status 503`、`HTTP 401` 等。
 * 只认 400–599，避免把端口号、token 数之类的数字当成状态码
 */
export function parseHttpStatus(text: string): number | undefined {
  const patterns = [
    /\berror \((\d{3})\)/i,
    /\((\d{3})\)\s*:/,
    /\b(?:status(?: code)?|http)\s*[:=]?\s*(\d{3})\b/i,
    /^(\d{3})\s+[A-Za-z]/,
    /\b(\d{3}) (?:Bad Request|Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Overloaded)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const code = m ? Number(m[1]) : Number.NaN;
    if (code >= 400 && code <= 599) return code;
  }
  return undefined;
}

const REASONS: [RegExp, ConnectionReason][] = [
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i, "dns"],
  [/ECONNREFUSED|connection refused/i, "refused"],
  [/certificate|CERT_|self[- ]signed|SSL|TLS/i, "certificate"],
  [/ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout/i, "timeout"],
  [/ECONNRESET|socket hang up|connection reset/i, "reset"],
];

const CONNECTION =
  /connection error|network|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|certificate|timed? ?out|timeout/i;
const RATE_LIMIT = /rate.?limit|too many requests|quota|insufficient_quota|resource.?exhausted/i;
const AUTH =
  /api key|apikey|unauthori[sz]ed|authentication|invalid.{0,20}(?:key|token)|permission|forbidden|credential/i;
const SERVER = /overloaded|internal server error|bad gateway|service unavailable|server error/i;
const INVALID =
  /invalid|bad request|not found|unsupported|context.{0,20}(?:length|window)|too long|maximum context/i;

export function connectionReason(text: string): ConnectionReason | undefined {
  for (const [re, reason] of REASONS) if (re.test(text)) return reason;
  return undefined;
}

/** 按状态码与文本归类 */
export function classifyError(errorMessage: string | undefined): ErrorInfo {
  const text = errorMessage ?? "";
  const status = parseHttpStatus(text);
  if (status !== undefined) {
    const category: ErrorCategory =
      status === 401 || status === 403
        ? "auth"
        : status === 429
          ? "rateLimit"
          : status >= 500
            ? "server"
            : status === 408
              ? "connection"
              : "invalid";
    return { category, status };
  }
  if (/\babort/i.test(text)) return { category: "aborted" };
  if (RATE_LIMIT.test(text)) return { category: "rateLimit" };
  if (AUTH.test(text)) return { category: "auth" };
  if (SERVER.test(text)) return { category: "server" };
  if (CONNECTION.test(text)) return { category: "connection", reason: connectionReason(text) };
  if (INVALID.test(text)) return { category: "invalid" };
  return { category: "unknown" };
}

/** 耗时：1 秒以内用毫秒，1 分钟以内保留一位小数，更长用 分 秒 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 本地时间 `HH:MM:SS` */
export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** 一条诊断记录的单行摘要 */
export function diagnosticLine(d: NonNullable<AssistantMessage["diagnostics"]>[number]): string {
  const err = d.error;
  const head = err ? `${err.name ? `${err.name}: ` : ""}${err.message}` : "";
  const code = err?.code !== undefined ? ` (${err.code})` : "";
  return `[${d.type}] ${head}${code}`.trim();
}

/** “复制详细信息”的纯文本：便于贴给渠道方或反馈问题（不含密钥：Core 的错误文本与诊断已脱敏） */
export function errorReport(
  message: AssistantMessage,
  labels: {
    title: string;
    provider: string;
    model: string;
    status: string;
    duration: string;
    time: string;
  },
  providerName?: string,
): string {
  const info = classifyError(message.errorMessage);
  const lines = [
    labels.title,
    `${labels.provider}: ${providerName && providerName !== message.provider ? `${providerName} (${message.provider})` : message.provider}`,
    `${labels.model}: ${message.model}${message.api ? ` · ${message.api}` : ""}`,
  ];
  if (info.status !== undefined) lines.push(`${labels.status}: ${info.status}`);
  if (message.durationMs !== undefined)
    lines.push(`${labels.duration}: ${formatDuration(message.durationMs)}`);
  if (message.timestamp) lines.push(`${labels.time}: ${new Date(message.timestamp).toISOString()}`);
  if (message.responseId) lines.push(`responseId: ${message.responseId}`);
  lines.push("", message.errorMessage ?? "");
  for (const d of message.diagnostics ?? []) {
    lines.push("", diagnosticLine(d));
    if (d.details) lines.push(JSON.stringify(d.details, null, 2));
  }
  return lines.join("\n").trimEnd();
}
