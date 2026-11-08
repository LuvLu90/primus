"use client";

// 回复出错的错误卡片与自动重试提示。
// 参考成熟的告警 / 提示模式（Radix Callout、GitHub Flash、Vercel / Linear 的错误状态、Claude / ChatGPT 的回复失败）：
//   标题按类别 → 一句人话的解释与建议 → 操作（重试、检查模型渠道、检测连接）→ 元信息 → 可折叠的详细信息（可复制）。
// 颜色只用设计令牌（danger / warning / success 及其透明度），浅色深色一致；动画只用 step-in 与 motion-safe，尊重“减少动态效果”。
import type { AssistantMessage } from "@primus/protocol";
import {
  Activity,
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Gauge,
  KeyRound,
  type LucideIcon,
  RotateCcw,
  RotateCw,
  ServerCrash,
  Settings2,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
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
} from "./reply-error";

const t = strings.chat.replyError;

const ICONS: Record<ErrorCategory, LucideIcon> = {
  connection: WifiOff,
  auth: KeyRound,
  rateLimit: Gauge,
  server: ServerCrash,
  invalid: Ban,
  aborted: CircleStop,
  unknown: CircleAlert,
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
  "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
const primaryButton = cn(buttonBase, "bg-fg text-surface hover:bg-fg/85");
const secondaryButton = cn(buttonBase, "text-fg ring-1 ring-border ring-inset hover:bg-hover");

function Meta({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1">
      <dt className="shrink-0">{label}</dt>
      <dd
        className={cn("min-w-0 truncate text-fg/80 tabular-nums", mono && "font-mono text-[11px]")}
      >
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
  const Icon = ICONS[info.category];
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
        "step-in flex flex-col gap-2.5 rounded-xl border px-3.5 py-3 text-[13px]",
        warning ? "border-warning/25 bg-warning/[0.06]" : "border-danger/25 bg-danger/[0.05]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className={cn(
            "mt-px grid size-6 shrink-0 place-items-center rounded-full",
            warning ? "bg-warning/15 text-warning" : "bg-danger/12 text-danger",
          )}
        >
          <Icon size={13} strokeWidth={2.2} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={titleId} className="font-semibold text-fg">
              {strings.chat.replyFailed}：{copy.title}
            </h3>
            {info.reason && (
              <span className="rounded-full bg-danger/10 px-1.5 py-px text-[11px] text-danger">
                {t.reasons[info.reason]}
              </span>
            )}
            {retried && <span className="text-[11.5px] text-muted">{retried}</span>}
          </div>
          <p className="text-fg/80 leading-relaxed">
            {copy.hint}
            <span className="text-muted"> {copy.action}</span>
          </p>
        </div>
      </div>

      {(actions?.onRetry || (settingsHelps && actions?.onOpenSettings) || canProbe) && (
        <div className="flex flex-wrap items-center gap-1.5 pl-8.5">
          {actions?.onRetry && (
            <button type="button" className={primaryButton} onClick={actions.onRetry}>
              <RotateCcw aria-hidden size={13} />
              {t.retry}
            </button>
          )}
          {settingsHelps && actions?.onOpenSettings && (
            <button type="button" className={secondaryButton} onClick={actions.onOpenSettings}>
              <Settings2 aria-hidden size={13} />
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
              <Activity
                aria-hidden
                size={13}
                className={cn(probe.state === "running" && "motion-safe:animate-pulse")}
              />
              {probe.state === "running" ? t.probing : t.probe}
            </button>
          )}
        </div>
      )}

      {(probe.state === "ok" || probe.state === "failed") && (
        <p
          role="status"
          className="step-in flex items-start gap-1.5 pl-8.5 text-[12px] text-fg/80 leading-relaxed"
        >
          {probe.state === "ok" ? (
            <>
              <CircleCheck aria-hidden size={13} className="mt-0.5 shrink-0 text-success" />
              {fill(t.probeOk, { n: probe.count })}
            </>
          ) : (
            <>
              <CircleX aria-hidden size={13} className="mt-0.5 shrink-0 text-danger" />
              {t.probeFailed}：{probe.reason}
            </>
          )}
        </p>
      )}

      <div className="ml-8.5 flex flex-col gap-1.5 border-border border-t pt-2">
        <div className="flex items-center gap-2">
          <dl className="flex min-w-0 flex-1 flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted">
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
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((o) => !o)}
            className="-mr-1 inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[11.5px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {open ? t.hideDetails : t.details}
            <ChevronRight
              aria-hidden
              size={13}
              className={cn(
                "motion-safe:transition-[rotate] motion-safe:duration-200",
                open && "rotate-90",
              )}
            />
          </button>
        </div>
        {open && (
          <div
            id={detailsId}
            className="step-in relative rounded-lg bg-tile ring-1 ring-tile-ring ring-inset"
          >
            <div className="absolute top-1 right-1">
              <CopyButton text={report} label={t.copyDetails} size="sm" />
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 pr-9 font-mono text-[11.5px] text-fg/85 leading-relaxed">
              {message.errorMessage || copy.title}
            </pre>
            {diagnostics.length > 0 && (
              <div className="border-tile-ring border-t px-2.5 py-2">
                <p className="mb-1 text-[11px] text-muted">{t.diagnostics}</p>
                <ul className="flex flex-col gap-1.5">
                  {diagnostics.map((d, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 诊断记录随消息定稿，不会重排
                    <li key={i} className="font-mono text-[11px] text-fg/80">
                      <span>{diagnosticLine(d)}</span>
                      {d.details && (
                        <pre className="mt-0.5 whitespace-pre-wrap break-words text-muted">
                          {JSON.stringify(d.details, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
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
      className="step-in flex items-center gap-2.5 rounded-xl border border-warning/25 bg-warning/[0.06] px-3.5 py-2.5 text-[13px]"
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-full bg-warning/15 text-warning"
      >
        <RotateCw
          size={13}
          strokeWidth={2.2}
          className={cn(left === 0 && "motion-safe:animate-spin")}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-fg">
          <span className="font-semibold">{t.categories[info.category].title}</span>
          <span className="text-fg/80">
            {"，"}
            {left > 0 ? fill(t.retryIn, values) : `${fill(t.retrying, values)}…`}
          </span>
        </p>
        <p className="truncate text-[12px] text-muted" title={retry.errorMessage}>
          {retry.errorMessage}
        </p>
      </div>
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
