"use client";

// 底栏模型按钮右侧的上下文按钮：只有小圆环（百分比只放在无障碍名称里）；点开是“上下文卡片”。
// 卡片：标题行“上下文窗口 · 已用 / 窗口 (百分比)”，箭头展开明细；进度条（已用，空余部分是中性轨道）；
// 明细逐行列出已用与可用空间，再按分组（系统工具、MCP 工具、技能、记忆文件）折叠列出已加载到上下文的名称，
// 以及本会话实际调用过的工具与次数（未调用的不列）。
// 本会话用量（输入 / 输出 / 费用 / 缓存读取 / 缓存写入 / 缓存命中率）、自动压缩开关（Core 的全局设置）与“立即压缩”。
// 数值只用 Core 的真实数据，不做任何估算：已用 / 窗口 / 百分比来自 get_session_stats 的 contextUsage，
// 用量来自其 tokens 与 cost。Core 不提供分项 token 统计，卡片不显示分项占用；
// 分组清单来自扩展 primus-context-stats（只有名称）。数据都是缓存：会话打开后预取、每轮结束由扩展重推。
import type {
  ContextStatsData,
  ContextStatsGroup,
  ContextStatsUsedTool,
  ContextUsage,
  SessionStats,
} from "@primus/protocol";
import { Popover } from "radix-ui";
import { type CSSProperties, useState } from "react";
import { Icon } from "@/components/icons";
import { useGlassStyle } from "@/components/layout/glass-panel";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Switch } from "@/components/ui/switch";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { composerGhostClass } from "./composer-ghost";
import { cacheHitPercent, summarizeContext } from "./context-summary";

const t = strings.chat;
const c = strings.chat.contextCard;

/** 已加载清单的分组及顺序 */
const GROUPS = ["systemTools", "mcpTools", "skills", "memoryFiles"] as const;

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

/** 占用越高越醒目：75% 起警示色，90% 起危险色 */
function tone(percent: number) {
  if (percent >= 90) return { stroke: "stroke-danger", bg: "bg-danger" };
  if (percent >= 75) return { stroke: "stroke-warning", bg: "bg-warning" };
  return { stroke: "stroke-accent", bg: "bg-accent" };
}

export interface ContextCardProps {
  usage?: ContextUsage;
  sessionUsage?: Pick<SessionStats, "tokens" | "cost">;
  /** 扩展 primus-context-stats 推来的已加载清单（只有名称）；没有时只显示已用与可用空间 */
  stats?: ContextStatsData;
  autoCompaction?: boolean;
  compacting?: boolean;
  /** 会话已打开：压缩与自动压缩开关可用 */
  connected: boolean;
  /** 运行中不能压缩 */
  busy?: boolean;
  /** 打开卡片时调用（只补取还没有的数据；已缓存的直接显示） */
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
          className={composerGhostClass({ icon: true })}
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
  const b = summarizeContext(usage);
  const { known } = b;
  const used = b.used ?? 0;
  const percent = b.usedPercent ?? 0;
  const groups = GROUPS.map((key) => stats?.groups?.find((g) => g.key === key)).filter(
    (g): g is ContextStatsGroup => g !== undefined,
  );
  const usedTools = stats?.usedTools ?? [];
  const hasLists = groups.length > 0 || usedTools.length > 0;
  const hit = sessionUsage ? cacheHitPercent(sessionUsage.tokens) : null;
  const tokens = (n: number | undefined) => (n === undefined ? "—" : formatTokens(n));
  let index = 0;

  return (
    <GlassSurface blur={30} radius={18} {...glass}>
      <div
        role="dialog"
        aria-label={c.title}
        className="flex w-[340px] flex-col px-4 pt-3.5 pb-3 text-sm text-fg"
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
          <span className="text-xs tabular-nums text-muted">
            {usage
              ? `${known ? formatTokens(used) : "—"} / ${formatTokens(b.contextWindow)} (${known ? formatPercent(percent) : "—"})`
              : c.noData}
          </span>
          <Icon
            name="chevron-down"
            size="sm"
            className="ctx-chevron text-muted"
            data-open={expanded || undefined}
          />
        </button>
        <div
          aria-hidden
          className="mt-2.5 mb-1 flex h-2 gap-[2px] overflow-hidden rounded-[4px] bg-track-strong"
        >
          {known && used > 0 && (
            <span
              data-segment="used"
              className={cn("ctx-seg block h-full", tone(percent).bg)}
              style={{ width: `${percent}%`, "--i": 0 } as CSSProperties}
            />
          )}
        </div>
        <div className="ctx-expand" data-open={expanded || undefined} inert={!expanded}>
          <div className="min-h-0 overflow-hidden">
            <div className="scroll-none max-h-[min(56vh,440px)] overflow-y-auto overscroll-contain pt-1">
              <ul aria-label={c.title}>
                {known ? (
                  <>
                    <ContextRow
                      index={index++}
                      color={tone(percent).bg}
                      label={c.used}
                      value={formatTokens(used)}
                      percent={formatPercent1(percent)}
                    />
                    <ContextRow
                      index={index++}
                      color="bg-track"
                      ring
                      label={c.free}
                      value={formatTokens(b.free ?? 0)}
                      percent={formatPercent1(b.freePercent)}
                    />
                  </>
                ) : (
                  <li
                    className="ctx-row flex min-h-[22px] items-center text-xs text-muted"
                    style={{ "--i": index++ } as CSSProperties}
                  >
                    {usage ? c.unknownAfterCompact : c.noData}
                  </li>
                )}
              </ul>
              {hasLists && (
                <ul aria-label={c.groupsLabel} className="mt-1.5 border-t border-border pt-1.5">
                  {groups.map((group) => (
                    <ContextGroup key={group.key} group={group} index={index++} />
                  ))}
                  {usedTools.length > 0 && <UsedToolsGroup tools={usedTools} index={index++} />}
                </ul>
              )}
            </div>
          </div>
        </div>
        <div className="my-2.5 h-px bg-border" />
        <p className="font-semibold">{c.usageTitle}</p>
        <dl className="mt-2 grid grid-cols-3 gap-1.5">
          <Stat label={c.input} value={tokens(sessionUsage?.tokens.input)} />
          <Stat label={c.output} value={tokens(sessionUsage?.tokens.output)} />
          <Stat label={c.cost} value={sessionUsage ? formatCost(sessionUsage.cost) : "—"} />
          <Stat label={c.cacheRead} value={tokens(sessionUsage?.tokens.cacheRead)} />
          <Stat label={c.cacheWrite} value={tokens(sessionUsage?.tokens.cacheWrite)} />
          <Stat label={c.cacheHit} value={formatPercent1(hit)} />
        </dl>
        <div className="mt-2.5 flex items-center gap-2 text-xs text-muted">
          {/* 受控开关：切换时 store 先乐观更新（失败回滚），不会出现“新 → 旧 → 新”的跳动 */}
          <Switch
            ariaLabel={`${c.autoCompact}（${c.autoCompactScope}）`}
            checked={autoCompaction ?? true}
            disabled={!connected || autoCompaction === undefined}
            onCheckedChange={onAutoCompactionChange}
            className="origin-left scale-[0.8] -mr-2"
          />
          <span title={c.autoCompactHint}>
            {c.autoCompact}
            <span className="ml-1 text-2xs opacity-70">{c.autoCompactScope}</span>
          </span>
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
  ring,
}: {
  index: number;
  color: string;
  label: string;
  value: string;
  percent: string;
  /** 中性色方块加描边（可用空间，与轨道同色） */
  ring?: boolean;
}) {
  return (
    <li
      className="ctx-row flex h-[22px] items-center gap-2 text-xs"
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
      <span className="min-w-0 truncate">{label}</span>
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

/** 一个可折叠的清单分组：标题行显示条目数，展开后逐项列出名称（没有 token 数：Core 不提供分项统计） */
function ContextGroup({ group, index }: { group: ContextStatsGroup; index: number }) {
  const [open, setOpen] = useState(false);
  const label = c.categories[group.key];
  const count = c.itemCount.replace("{n}", String(group.items.length));
  const empty = group.items.length === 0;
  return (
    <li className="ctx-row" style={{ "--i": index } as CSSProperties}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label} ${count}`}
        disabled={empty}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 flex h-[24px] w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none hover:bg-hover focus-visible:bg-hover disabled:hover:bg-transparent"
      >
        <i aria-hidden className="mx-px size-1.5 shrink-0 rounded-full bg-muted" />
        <span>{label}</span>
        <span className="flex-1" />
        <span className="tabular-nums text-muted">{count}</span>
        <Icon
          name="chevron-down"
          size="xs"
          className={cn("ctx-chevron text-muted", empty && "invisible")}
          data-open={open || undefined}
        />
      </button>
      <div className="ctx-expand ctx-group" data-open={open || undefined} inert={!open}>
        <ul aria-label={label} className="min-h-0 overflow-hidden pl-4">
          {group.items.map((name, i) => (
            <li
              key={name}
              className="ctx-item flex h-[20px] items-center text-2xs"
              style={{ "--i": i } as CSSProperties}
            >
              <span className="min-w-0 truncate text-muted" title={name}>
                {name}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/** 本会话实际调用过的工具：标题行显示种类与总次数，展开后逐个列出调用次数 */
function UsedToolsGroup({ tools, index }: { tools: ContextStatsUsedTool[]; index: number }) {
  const [open, setOpen] = useState(false);
  const total = tools.reduce((n, tool) => n + tool.count, 0);
  const count = c.itemCount.replace("{n}", String(tools.length));
  return (
    <li className="ctx-row" style={{ "--i": index } as CSSProperties}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${c.usedTools} ${count}`}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 flex h-[24px] w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none hover:bg-hover focus-visible:bg-hover"
      >
        <i aria-hidden className="mx-px size-1.5 shrink-0 rounded-full bg-muted" />
        <span>{c.usedTools}</span>
        <span className="flex-1" />
        <span className="tabular-nums text-muted">
          {count} · {c.callCount.replace("{n}", String(total))}
        </span>
        <Icon
          name="chevron-down"
          size="xs"
          className="ctx-chevron text-muted"
          data-open={open || undefined}
        />
      </button>
      <div className="ctx-expand ctx-group" data-open={open || undefined} inert={!open}>
        <ul aria-label={c.usedTools} className="min-h-0 overflow-hidden pl-4">
          {tools.map((tool, i) => (
            <li
              key={tool.name}
              className="ctx-item flex h-[20px] items-center gap-2 text-2xs"
              style={{ "--i": i } as CSSProperties}
            >
              <span className="min-w-0 truncate text-muted" title={tool.name}>
                {tool.name}
              </span>
              <span className="flex-1" />
              <span className="shrink-0 tabular-nums text-muted">
                {c.callCount.replace("{n}", String(tool.count))}
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
      <dt className="text-2xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
