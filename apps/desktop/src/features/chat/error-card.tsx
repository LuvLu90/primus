"use client";

// 回复出错的错误卡片与自动重试提示。
// 参考成熟的告警 / 提示模式（Radix Callout、GitHub Flash、Vercel / Linear 的错误状态、Claude / ChatGPT 的回复失败）：
//   一行：图标 + 标题（悬停看建议）→ 操作（重试、检查模型渠道、检测连接）→ 展开详细信息（元信息 + 原始错误，可复制）。
// 颜色只用设计令牌（danger / warning / success 及其透明度），浅色深色一致；动画只用 step-in 与 motion-safe，尊重“减少动态效果”。
import type { AssistantMessage } from "@primus/protocol";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { SessionState } from "@/stores/session-store";
import { CopyButton } from "./copy-button";
import {
  classifyError,
  diagnosticLine,
  type ErrorCategory,
  errorReport,
  formatClock,
  formatDuration,
  redactSecrets,
} from "./reply-error";

const t = strings.chat.replyError;

const ICONS: Record<ErrorCategory, IconName> = {
  connection: "wifi-off",
  auth: "key",
  rateLimit: "gauge",
  server: "server",
  invalid: "ban",
  aborted: "stop-circle",
  unknown: "alert-circle",
};

/** 限流与中止是“等一等 / 自己停的”，用警示色；其余用危险色 */
const WARNING: ReadonlySet<ErrorCategory> = new Set(["rateLimit", "aborted"]);

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

export interface ErrorActions {
  /** 重新发送上一条消息（只在最后一轮、空闲时提供） */
  onRetry?: () => void;
  /** 打开设置的模型渠道 */
  onOpenSettings?: () => void;
}

const buttonBase =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
const primaryButton = cn(buttonBase, "bg-fg text-surface hover:bg-fg/85");
const secondaryButton = cn(buttonBase, "text-fg ring-1 ring-border ring-inset hover:bg-hover");

function Meta({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt className="shrink-0">{label}</dt>
      <dd className={cn("min-w-0 truncate text-fg/80 tabular-nums", mono && "font-mono text-2xs")}>
        {children}
      </dd>
    </div>
  );
}

type Probe =
  | { state: "idle" }
  | { state: "running" }
  | { state: "ok"; count: number }
  | { state: "failed"; reason: string };

/** 用已有的 provider_fetch_models 探测同一个渠道（Core 丢掉了连接错误的底层原因） */
function useProbe(provider: string) {
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const run = () => {
    setProbe({ state: "running" });
    getPlatform()
      .then((p) => p.providerFetchModels({ id: provider }))
      .then(
        (models) => setProbe({ state: "ok", count: models.length }),
        (e: unknown) =>
          setProbe({ state: "failed", reason: e instanceof Error ? e.message : String(e) }),
      );
  };
  return { probe, run };
}

export function ErrorCard({
  message,
  providerName,
  retryResult,
  actions,
}: {
  message: AssistantMessage;
  /** 渠道显示名（没有时用渠道 ID） */
  providerName?: string;
  retryResult?: SessionState["retryResult"];
  actions?: ErrorActions;
}) {
  const info = classifyError(message.errorMessage);
  const copy = t.categories[info.category];
  const warning = WARNING.has(info.category);
  const [open, setOpen] = useState(false);
  const { probe, run } = useProbe(message.provider);
  const titleId = useId();
  const detailsId = useId();
  const canProbe =
    (info.category === "connection" || info.category === "auth") && Boolean(message.provider);
  const settingsHelps = info.category !== "rateLimit" && info.category !== "aborted";
  const retried =
    retryResult && !retryResult.success
      ? retryResult.finalError === "Retry cancelled"
        ? t.retryCancelled
        : fill(t.retried, { n: retryResult.attempt })
      : undefined;
  const report = errorReport(
    message,
    {
      title: copy.title,
      provider: t.provider,
      model: t.model,
      status: t.status,
      duration: t.duration,
      time: t.time,
    },
    providerName,
  );
  const diagnostics = message.diagnostics ?? [];

  return (
    <section
      aria-labelledby={titleId}
      data-category={info.category}
      className={cn(
        "step-in flex flex-col gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
        warning ? "border-warning/25 bg-warning/[0.06]" : "border-danger/25 bg-danger/[0.05]",
      )}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon
          name={ICONS[info.category]}
          size="sm"
          className={cn("shrink-0", warning ? "text-warning" : "text-danger")}
        />
        <h3 id={titleId} title={copy.hint} className="min-w-0 truncate font-medium text-fg">
          {strings.chat.replyFailed}：{copy.title}
        </h3>
        {info.reason && (
          <span className="rounded-full bg-danger/10 px-1.5 py-px text-2xs text-danger">
            {t.reasons[info.reason]}
          </span>
        )}
        {retried && <span className="text-2xs text-muted">{retried}</span>}
        <span className="flex-1" />
        {actions?.onRetry && (
          <button type="button" className={primaryButton} onClick={actions.onRetry}>
            <Icon name="retry" size="sm" />
            {t.retry}
          </button>
        )}
        {settingsHelps && actions?.onOpenSettings && (
          <button type="button" className={secondaryButton} onClick={actions.onOpenSettings}>
            {t.openSettings}
          </button>
        )}
        {canProbe && (
          <button
            type="button"
            className={secondaryButton}
            onClick={run}
            disabled={probe.state === "running"}
          >
            {probe.state === "running" ? t.probing : t.probe}
          </button>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={open ? t.hideDetails : t.details}
          title={open ? t.hideDetails : t.details}
          onClick={() => setOpen((o) => !o)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Icon
            name="chevron-right"
            size="sm"
            className={cn(
              "motion-safe:transition-[rotate] motion-safe:duration-200",
              open && "rotate-90",
            )}
          />
        </button>
      </div>

      {(probe.state === "ok" || probe.state === "failed") && (
        <p role="status" className="step-in flex items-center gap-1.5 text-xs text-fg/80">
          {probe.state === "ok" ? (
            <>
              <Icon name="check-circle" size="sm" className="shrink-0 text-success" />
              {fill(t.probeOk, { n: probe.count })}
            </>
          ) : (
            <>
              <Icon name="x-circle" size="sm" className="shrink-0 text-danger" />
              {t.probeFailed}：{probe.reason}
            </>
          )}
        </p>
      )}

      {open && (
        <div
          id={detailsId}
          className="step-in relative mb-1 rounded-md bg-tile ring-1 ring-tile-ring ring-inset"
        >
          <div className="absolute top-1 right-1">
            <CopyButton text={report} label={t.copyDetails} size="sm" />
          </div>
          <dl className="flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 pt-2 pr-9 text-2xs text-muted">
            {message.provider && <Meta label={t.provider}>{providerName || message.provider}</Meta>}
            {message.model && (
              <Meta label={t.model} mono>
                {message.model}
              </Meta>
            )}
            {info.status !== undefined && <Meta label={t.status}>{info.status}</Meta>}
            {message.durationMs !== undefined && (
              <Meta label={t.duration}>{formatDuration(message.durationMs)}</Meta>
            )}
            {message.timestamp > 0 && <Meta label={t.time}>{formatClock(message.timestamp)}</Meta>}
          </dl>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-2xs text-fg/85 leading-relaxed">
            {message.errorMessage ? redactSecrets(message.errorMessage) : copy.title}
          </pre>
          {diagnostics.length > 0 && (
            <ul className="flex flex-col gap-1.5 border-tile-ring border-t px-2.5 py-2">
              {diagnostics.map((d, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 诊断记录随消息定稿，不会重排
                <li key={i} className="font-mono text-2xs text-fg/80">
                  <span>{diagnosticLine(d)}</span>
                  {d.details && (
                    <pre className="mt-0.5 whitespace-pre-wrap break-words text-muted">
                      {redactSecrets(JSON.stringify(d.details, null, 2))}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** 每隔一段时间刷新的当前时间（倒计时用）；停用时不计时 */
function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** Core 正在自动重试：倒计时 + 停止重试（abort_retry） */
export function RetryNotice({
  retry,
  onStop,
}: {
  retry: NonNullable<SessionState["retry"]>;
  onStop?: () => Promise<boolean>;
}) {
  const [stopping, setStopping] = useState(false);
  const now = useNow(true);
  const left = Math.max(0, Math.ceil((retry.at + retry.delayMs - now) / 1000));
  const info = classifyError(retry.errorMessage);
  const values = { seconds: left, attempt: retry.attempt, max: retry.maxAttempts };
  // 换了一次重试（新的 auto_retry_start）：恢复按钮
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在新一次重试开始时复位
  useEffect(() => setStopping(false), [retry.at]);
  return (
    <div
      role="status"
      aria-live="polite"
      title={retry.errorMessage && redactSecrets(retry.errorMessage)}
      className="step-in flex min-h-7 items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-xs"
    >
      <Icon
        name="refresh"
        size="sm"
        className={cn("shrink-0 text-warning", left === 0 && "motion-safe:animate-spin")}
      />
      <p className="min-w-0 flex-1 truncate text-fg">
        <span className="font-medium">{t.categories[info.category].title}</span>
        <span className="text-fg/80">
          {"，"}
          {left > 0 ? fill(t.retryIn, values) : `${fill(t.retrying, values)}…`}
        </span>
      </p>
      {onStop && (
        <button
          type="button"
          className={secondaryButton}
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            void onStop().then((ok) => {
              if (!ok) setStopping(false);
            });
          }}
        >
          {stopping ? t.stoppingRetry : t.stopRetry}
        </button>
      )}
    </div>
  );
}
