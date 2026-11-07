"use client";

// 底栏模型按钮右侧的上下文按钮：只有小圆环（百分比只放在无障碍名称里）；点开是“上下文卡片”。
// 卡片：标题行“上下文窗口 · 已用 / 窗口 (百分比)”，箭头展开明细；多色分段条（消息、系统工具、MCP 工具、技能、
// 系统提示、记忆文件，空余部分是中性轨道）；图例逐行列出各分项、延迟加载的工具与可用空间；
// 下方按分组（MCP 工具、记忆文件、技能、系统工具）折叠列出明细。本会话用量（输入/输出/缓存命中率/费用）、
// 自动压缩开关与“立即压缩”。
// 总量来自 Core（get_session_stats 的 contextUsage）；分项来自扩展 primus-context-stats 的估算（字符数 / 4），
// 由 computeBreakdown 推出“消息”与“可用空间”。分项未到达前只画已用与可用空间，不编造数字。
import type { ContextStatsData, ContextUsage, SessionStats } from "@primus/protocol";
import { ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import { type CSSProperties, useState } from "react";
import { useGlassStyle } from "@/components/layout/glass-panel";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Switch } from "@/components/ui/switch";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import {
  type BreakdownKey,
  type BreakdownRow,
  cacheHitPercent,
  computeBreakdown,
} from "./context-breakdown";

const t = strings.chat;
const c = strings.chat.contextCard;

/** 各分项的颜色（globals.css 的图表令牌） */
const COLOR: Record<BreakdownKey, string> = {
  messages: "bg-chart-1",
  systemTools: "bg-chart-2",
  mcpTools: "bg-chart-3",
  skills: "bg-chart-4",
  systemPrompt: "bg-chart-5",
  memoryFiles: "bg-chart-6",
};

/** 可折叠明细的分组及顺序 */
const GROUPS = ["mcpTools", "memoryFiles", "skills", "systemTools"] as const;

/** 1.2k / 128k / 1M：token 数的紧凑写法 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(Math.round(n));
}

function formatPercent(p: number): string {
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** 图例与用量里的百分比：一位小数；未知为“—” */
function formatPercent1(p: number | null): string {
  return p === null ? "—" : `${p.toFixed(1)}%`;
}

function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** 估算值前加“约”；未知为“—” */
function formatEstimate(tokens: number | null, estimated: boolean): string {
  if (tokens === null) return "—";
  return estimated ? `${c.approx} ${formatTokens(tokens)}` : formatTokens(tokens);
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
  /** 扩展 primus-context-stats 推来的分项估算；没有时只显示已用与可用空间 */
  stats?: ContextStatsData;
  autoCompaction?: boolean;
  compacting?: boolean;
  /** 会话已打开：压缩与自动压缩开关可用 */
  connected: boolean;
  /** 运行中不能压缩 */
  busy?: boolean;
  /** 打开卡片时调用（刷新用量并请求分项统计） */
  onOpen?: () => void;
  onCompact: () => void;
  onAutoCompactionChange: (enabled: boolean) => void;
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
          title={`${t.context} ${shown}`}
          className="flex size-8 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg"
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
  stats,
  autoCompaction,
  compacting,
  connected,
  busy,
  onCompact,
  onAutoCompactionChange,
}: ContextCardProps) {
  const glass = useGlassStyle(0.3);
  const [expanded, setExpanded] = useState(false);
  const b = computeBreakdown(usage, stats);
  const { known } = b;
  const used = b.used ?? 0;
  const percent = b.usedPercent ?? 0;
  const pct = (n: number) => (b.contextWindow > 0 ? (n / b.contextWindow) * 100 : 0);
  const hasRows = b.rows.length > 0;
  // 分段条：有分项时按分项着色（只画非零的段），否则一段“已用”；空余是轨道底色
  const segments =
    known && hasRows
      ? b.rows
          .filter((row) => (row.tokens ?? 0) > 0)
          .map((row) => ({ key: row.key, width: row.percent ?? 0, color: COLOR[row.key] }))
      : known && used > 0
        ? [{ key: "used", width: percent, color: tone(percent).bg }]
        : [];
  const hit = sessionUsage ? cacheHitPercent(sessionUsage.tokens) : null;
  let index = 0;

  return (
    <GlassSurface blur={30} radius={18} {...glass}>
      <div
        role="dialog"
        aria-label={c.title}
        className="flex w-[340px] flex-col px-4 pt-3.5 pb-3 text-[13px] text-fg"
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
              ? `${known ? formatTokens(used) : "—"} / ${formatTokens(b.contextWindow)} (${known ? formatPercent(percent) : "—"})`
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
          {segments.map((s, i) => (
            <span
              key={s.key}
              data-segment={s.key}
              className={cn("ctx-seg block h-full", s.color)}
              style={{ width: `${s.width}%`, "--i": i } as CSSProperties}
            />
          ))}
        </div>
        <div className="ctx-expand" data-open={expanded || undefined} inert={!expanded}>
          <div className="min-h-0 overflow-hidden">
            <div className="max-h-[min(56vh,440px)] overflow-y-auto pt-1">
              <ul aria-label={c.title}>
                {hasRows ? (
                  b.rows.map((row) => (
                    <ContextRow
                      key={row.key}
                      index={index++}
                      color={known ? COLOR[row.key] : "bg-track-strong"}
                      label={c.categories[row.key]}
                      value={formatEstimate(row.tokens, row.estimated)}
                      percent={formatPercent1(row.percent)}
                    />
                  ))
                ) : known ? (
                  <ContextRow
                    index={index++}
                    color={tone(percent).bg}
                    label={c.used}
                    value={formatTokens(used)}
                    percent={formatPercent1(pct(used))}
                  />
                ) : null}
                {b.deferred.map((d) => (
                  <ContextRow
                    key={`deferred:${d.name}`}
                    index={index++}
                    color="bg-track-strong"
                    label={d.name}
                    value={d.tokens === null ? c.deferred : formatEstimate(d.tokens, true)}
                    percent="—"
                    muted
                  />
                ))}
                {(known || hasRows) && (
                  <ContextRow
                    index={index++}
                    color="bg-track"
                    ring
                    label={c.free}
                    value={b.free === null ? "—" : formatTokens(b.free)}
                    percent={formatPercent1(b.freePercent)}
                  />
                )}
                {!known && (
                  <li
                    className="ctx-row flex min-h-[22px] items-center text-[12px] text-muted"
                    style={{ "--i": index++ } as CSSProperties}
                  >
                    {usage ? c.unknownAfterCompact : c.noData}
                  </li>
                )}
              </ul>
              {hasRows && (
                <ul aria-label={c.groupsLabel} className="mt-1.5 border-t border-border pt-1.5">
                  {GROUPS.map((key) => {
                    const row = b.rows.find((r) => r.key === key);
                    return row ? (
                      <ContextGroup key={key} row={row} index={index++} known={known} />
                    ) : null;
                  })}
                  <li
                    className="ctx-row pt-1 text-[11px] text-muted"
                    style={{ "--i": index++ } as CSSProperties}
                  >
                    {c.estimateNote}
                  </li>
                </ul>
              )}
            </div>
          </div>
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
          <Stat label={c.cacheRead} value={formatPercent1(hit)} />
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
  muted,
  ring,
}: {
  index: number;
  color: string;
  label: string;
  value: string;
  percent: string;
  /** 不占上下文的行（延迟加载的工具）：标签也用次要色 */
  muted?: boolean;
  /** 中性色方块加描边（可用空间，与轨道同色） */
  ring?: boolean;
}) {
  return (
    <li
      className="ctx-row flex h-[22px] items-center gap-2 text-[12px]"
      style={{ "--i": index } as CSSProperties}
    >
      <i
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-[2px]",
          color,
          ring && "shadow-[inset_0_0_0_1px_var(--color-border)]",
        )}
      />
      <span className={cn("min-w-0 truncate", muted && "text-muted")}>{label}</span>
      <span className="flex-1" />
      <span className="shrink-0 text-right tabular-nums text-muted">{value}</span>
      <span
        className={cn(
          "w-12 shrink-0 text-right tabular-nums",
          percent === "—" ? "text-muted" : "font-semibold",
        )}
      >
        {percent}
      </span>
    </li>
  );
}

/** 一个可折叠的明细分组：标题行显示合计与条目数，展开后逐项列出 */
function ContextGroup({ row, index, known }: { row: BreakdownRow; index: number; known: boolean }) {
  const [open, setOpen] = useState(false);
  const label = c.categories[row.key];
  const count = c.itemCount.replace("{n}", String(row.items.length));
  const empty = row.items.length === 0;
  return (
    <li className="ctx-row" style={{ "--i": index } as CSSProperties}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label} ${count}`}
        disabled={empty}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 flex h-[24px] w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 text-left text-[12px] outline-none hover:bg-hover focus-visible:bg-hover disabled:hover:bg-transparent"
      >
        <i aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", COLOR[row.key])} />
        <span>{label}</span>
        <span className="text-muted">{count}</span>
        <span className="flex-1" />
        <span className="tabular-nums text-muted">{formatEstimate(row.tokens, row.estimated)}</span>
        <ChevronDown
          aria-hidden
          size={12}
          className={cn("ctx-chevron shrink-0 text-muted", empty && "opacity-0")}
          data-open={open || undefined}
        />
      </button>
      <div className="ctx-expand ctx-group" data-open={open || undefined} inert={!open}>
        <ul className="min-h-0 overflow-hidden pl-4">
          {row.items.map((item, i) => (
            <li
              key={item.name}
              className="ctx-item flex h-[20px] items-center gap-2 text-[11.5px]"
              style={{ "--i": i } as CSSProperties}
            >
              <span className="min-w-0 truncate text-muted" title={item.name}>
                {item.name}
              </span>
              <span className="flex-1" />
              <span className="shrink-0 tabular-nums text-muted">
                {known ? formatEstimate(item.tokens, true) : "—"}
              </span>
            </li>
          ))}
        </ul>
      </div>
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
