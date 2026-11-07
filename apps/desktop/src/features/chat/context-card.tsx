"use client";

// 底栏模型按钮右侧的上下文按钮：小圆环 + 百分比；点开是“上下文卡片”。
// 卡片：上下文窗口占用（分段条，可展开看明细）、本会话用量（输入/输出/缓存命中/费用，打开时刷新）、
// 自动压缩开关与“立即压缩”。
// Core 只给出上下文总量（get_session_stats 的 contextUsage），没有可信的分项来源：默认只画一段“已用”，
// 展开后列出已用与可用空间；分项留作 `breakdown`（例如将来由扩展估算），有数据时才按分项着色。不编造数字。
import type { ContextUsage, SessionStats } from "@primus/protocol";
import { ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import { type CSSProperties, useState } from "react";
import { useGlassStyle } from "@/components/layout/glass-panel";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Switch } from "@/components/ui/switch";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.chat;
const c = strings.chat.contextCard;

/** 上下文分项（估算值，显示时标“约”）；`tokens` 之和不应超过已用总量 */
export interface ContextBreakdownItem {
  key: string;
  label: string;
  tokens: number;
}
export type ContextBreakdown = ContextBreakdownItem[];

const CHART = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

/** 1.2k / 128k / 1M：token 数的紧凑写法 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(Math.round(n));
}

function formatPercent(p: number): string {
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** 占用越高越醒目：75% 起警示色，90% 起危险色 */
function tone(percent: number) {
  if (percent >= 90) return { stroke: "stroke-danger", bg: "bg-danger" };
  if (percent >= 75) return { stroke: "stroke-warning", bg: "bg-warning" };
  return { stroke: "stroke-accent", bg: "bg-accent" };
}

export interface ContextCardProps {
  usage?: ContextUsage;
  sessionUsage?: Pick<SessionStats, "tokens" | "cost">;
  autoCompaction?: boolean;
  compacting?: boolean;
  /** 会话已打开：压缩与自动压缩开关可用 */
  connected: boolean;
  /** 运行中不能压缩 */
  busy?: boolean;
  /** 打开卡片时调用（刷新用量） */
  onOpen?: () => void;
  onCompact: () => void;
  onAutoCompactionChange: (enabled: boolean) => void;
  /** 可选分项（扩展接口）；没有时只显示已用与可用空间 */
  breakdown?: ContextBreakdown;
}

export function ContextButton(props: ContextCardProps) {
  const { usage } = props;
  const known = usage?.percent != null && usage.tokens != null;
  const percent = known ? Math.min(100, Math.max(0, usage?.percent ?? 0)) : 0;
  const shown = known ? formatPercent(percent) : "—";
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  return (
    <Popover.Root onOpenChange={(open) => open && props.onOpen?.()}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${t.context} ${shown}`}
          className="flex h-8 items-center gap-1.5 rounded-full px-2 text-[12px] tabular-nums text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg"
        >
          <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="-rotate-90">
            <circle
              cx="7"
              cy="7"
              r={r}
              fill="none"
              strokeWidth="2"
              className="stroke-track-strong"
            />
            <circle
              cx="7"
              cy="7"
              r={r}
              fill="none"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - percent / 100)}
              className={cn(
                "transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none",
                tone(percent).stroke,
              )}
            />
          </svg>
          <span>{shown}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          className="glass-pop z-50 outline-none [--glass-origin:var(--radix-popover-content-transform-origin)]"
        >
          <ContextCard {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ContextCard({
  usage,
  sessionUsage,
  autoCompaction,
  compacting,
  connected,
  busy,
  onCompact,
  onAutoCompactionChange,
  breakdown,
}: ContextCardProps) {
  const glass = useGlassStyle(0.3);
  const [expanded, setExpanded] = useState(false);
  const known = usage?.tokens != null && usage.percent != null;
  const used = known ? (usage?.tokens ?? 0) : 0;
  const ctxWindow = usage?.contextWindow ?? 0;
  const percent = known ? Math.min(100, Math.max(0, usage?.percent ?? 0)) : 0;
  const free = Math.max(0, ctxWindow - used);
  const pct = (n: number) => (ctxWindow > 0 ? (n / ctxWindow) * 100 : 0);
  const segments =
    breakdown && breakdown.length > 0 && known
      ? breakdown.map((b, i) => ({ ...b, color: CHART[i % CHART.length] ?? "bg-accent" }))
      : null;

  return (
    <GlassSurface blur={30} radius={18} {...glass}>
      <div
        role="dialog"
        aria-label={c.title}
        className="flex w-[330px] flex-col px-4 pt-3.5 pb-3 text-[13px] text-fg"
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? c.collapse : c.expand}
          onClick={() => setExpanded((v) => !v)}
          className="-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-0.5 text-left outline-none focus-visible:bg-hover"
        >
          <span className="font-semibold">{c.title}</span>
          <span className="flex-1" />
          <span className="text-[12px] tabular-nums text-muted">
            {usage
              ? `${known ? formatTokens(used) : "—"} / ${formatTokens(ctxWindow)}（${known ? formatPercent(percent) : "—"}）`
              : c.noData}
          </span>
          <ChevronDown
            aria-hidden
            size={13}
            className="ctx-chevron text-muted"
            data-open={expanded || undefined}
          />
        </button>
        <div
          aria-hidden
          className="mt-2.5 mb-1 flex h-2 gap-[2px] overflow-hidden rounded-[4px] bg-track-strong"
        >
          {segments
            ? segments.map((s, i) => (
                <span
                  key={s.key}
                  className={cn("ctx-seg block h-full", s.color)}
                  style={{ width: `${pct(s.tokens)}%`, "--i": i } as CSSProperties}
                />
              ))
            : known && (
                <span
                  className={cn("ctx-seg block h-full rounded-[4px]", tone(percent).bg)}
                  style={{ width: `${percent}%` }}
                />
              )}
        </div>
        <div className="ctx-expand" data-open={expanded || undefined} inert={!expanded}>
          <ul className="min-h-0 overflow-hidden pt-1">
            {!known ? (
              <li className="ctx-row flex h-[22px] items-center text-[12px] text-muted">
                {usage ? c.unknownAfterCompact : c.noData}
              </li>
            ) : (
              <>
                {(
                  segments ?? [
                    { key: "used", label: c.used, tokens: used, color: tone(percent).bg },
                  ]
                ).map((s, i) => (
                  <ContextRow
                    key={s.key}
                    index={i}
                    color={s.color}
                    label={s.label}
                    value={`${segments ? `${c.approx} ` : ""}${formatTokens(s.tokens)}`}
                    percent={pct(s.tokens)}
                  />
                ))}
                <ContextRow
                  index={(segments?.length ?? 1) + 0}
                  color="bg-track-strong"
                  label={c.free}
                  value={formatTokens(free)}
                  percent={pct(free)}
                />
              </>
            )}
          </ul>
        </div>
        <div className="my-2.5 h-px bg-border" />
        <p className="font-semibold">{c.usageTitle}</p>
        <dl className="mt-2 grid grid-cols-4 gap-1.5">
          <Stat
            label={c.input}
            value={sessionUsage ? formatTokens(sessionUsage.tokens.input) : "—"}
          />
          <Stat
            label={c.output}
            value={sessionUsage ? formatTokens(sessionUsage.tokens.output) : "—"}
          />
          <Stat
            label={c.cacheRead}
            value={sessionUsage ? formatTokens(sessionUsage.tokens.cacheRead) : "—"}
          />
          <Stat label={c.cost} value={sessionUsage ? formatCost(sessionUsage.cost) : "—"} />
        </dl>
        <div className="mt-2.5 flex items-center gap-2 text-[12px] text-muted">
          <Switch
            ariaLabel={c.autoCompact}
            checked={autoCompaction ?? true}
            disabled={!connected || autoCompaction === undefined}
            onCheckedChange={onAutoCompactionChange}
            className="origin-left scale-[0.8] -mr-2"
          />
          <span>{c.autoCompact}</span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onCompact}
            disabled={!connected || busy || compacting || !known || used === 0}
            aria-busy={compacting}
            className="rounded-lg px-2.5 py-1 text-fg shadow-[inset_0_0_0_1px_var(--color-border)] outline-none transition-[background-color,opacity] hover:bg-hover focus-visible:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {compacting ? c.compacting : c.compactNow}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}

function ContextRow({
  index,
  color,
  label,
  value,
  percent,
}: {
  index: number;
  color: string;
  label: string;
  value: string;
  percent: number;
}) {
  return (
    <li
      className="ctx-row flex h-[22px] items-center gap-2 text-[12px]"
      style={{ "--i": index } as CSSProperties}
    >
      <i aria-hidden className={cn("size-2 rounded-[2px]", color)} />
      <span>{label}</span>
      <span className="flex-1" />
      <span className="w-16 text-right tabular-nums text-muted">{value}</span>
      <span className="w-11 text-right tabular-nums text-muted">{formatPercent(percent)}</span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] bg-hover px-2 py-1.5">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
