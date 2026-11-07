// 上下文卡片的分项计算（纯函数）：Core 给出总量（get_session_stats 的 contextUsage），
// 扩展 primus-context-stats 给出各分项的估算（字符数 / 4）。“消息”与“可用空间”由总量推出：
// 消息 = 已用 − 各分项之和（不小于 0）；分项之和超过已用时按比例缩小，使全部分项正好等于已用；
// 可用空间 = 上下文窗口 − 已用。百分比都相对整个上下文窗口。
import type {
  ContextStatsCategoryKey,
  ContextStatsData,
  ContextStatsItem,
  ContextUsage,
} from "@primus/protocol";

/** 分段条与图例的顺序：消息在最前，其余按参考设计 */
export const BREAKDOWN_ORDER = [
  "messages",
  "systemTools",
  "mcpTools",
  "skills",
  "systemPrompt",
  "memoryFiles",
] as const satisfies readonly ("messages" | ContextStatsCategoryKey)[];

export type BreakdownKey = (typeof BREAKDOWN_ORDER)[number];

export interface BreakdownRow {
  key: BreakdownKey;
  /** 已用未知（压缩后）时为 null */
  tokens: number | null;
  /** 占整个上下文窗口的百分比；未知时为 null */
  percent: number | null;
  /** 估算值（扩展按字符数 / 4 估算，或经估算推出的“消息”），显示时标“约” */
  estimated: boolean;
  /** 明细（工具、技能、记忆文件），按缩放后的 token 从大到小 */
  items: ContextStatsItem[];
}

/** 不在上下文中的工具（延迟加载 / 未启用）：只列出，不占百分比 */
export interface DeferredRow {
  name: string;
  /** 协议目前不给延迟工具的 token，为 null */
  tokens: number | null;
  percent: null;
}

export interface ContextBreakdown {
  /** 已用总量已知（压缩后到下一条回复前为 false） */
  known: boolean;
  used: number | null;
  contextWindow: number;
  /** 已用占比（Core 给出的 percent，夹在 0–100） */
  usedPercent: number | null;
  /** 有分项统计时为 6 项（BREAKDOWN_ORDER）；没有统计时为空，界面只画已用与可用空间 */
  rows: BreakdownRow[];
  deferred: DeferredRow[];
  free: number | null;
  freePercent: number | null;
}

/** 把若干非负数按比例缩放到总和正好为 target 的整数（最大余数法） */
export function scaleToTotal(values: readonly number[], target: number): number[] {
  const sum = values.reduce((n, v) => n + Math.max(0, v), 0);
  if (sum <= 0 || target <= 0) return values.map(() => 0);
  const exact = values.map((v) => (Math.max(0, v) * target) / sum);
  const floors = exact.map(Math.floor);
  let rest = target - floors.reduce((n, v) => n + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    rest -= 1;
  }
  return floors;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function computeBreakdown(
  usage: ContextUsage | undefined,
  stats: ContextStatsData | undefined,
): ContextBreakdown {
  const contextWindow = Math.max(0, usage?.contextWindow ?? 0);
  const used = usage?.tokens != null ? Math.max(0, usage.tokens) : null;
  const known = used !== null;
  const pct = (n: number) => (contextWindow > 0 ? (n / contextWindow) * 100 : 0);
  const usedPercent =
    known && usage?.percent != null
      ? clamp(usage.percent, 0, 100)
      : known
        ? clamp(pct(used), 0, 100)
        : null;
  const free = known ? Math.max(0, contextWindow - used) : null;
  const deferred: DeferredRow[] = (stats?.deferredTools ?? []).map((name) => ({
    name,
    tokens: null,
    percent: null,
  }));

  let rows: BreakdownRow[] = [];
  if (stats) {
    const byKey = new Map(stats.categories.map((c) => [c.key, c]));
    const keys = BREAKDOWN_ORDER.filter((k) => k !== "messages");
    const raw = keys.map((k) => Math.max(0, byKey.get(k)?.tokens ?? 0));
    const rawSum = raw.reduce((n, v) => n + v, 0);
    // 分项超过已用（估算偏大）：按比例缩小到正好等于已用，消息为 0
    const scaled = known && rawSum > used ? scaleToTotal(raw, used) : raw;
    const factor = known && rawSum > used && rawSum > 0 ? used / rawSum : 1;
    const messages = known ? Math.max(0, used - scaled.reduce((n, v) => n + v, 0)) : null;
    rows = [
      {
        key: "messages",
        tokens: messages,
        percent: messages === null ? null : pct(messages),
        estimated: true,
        items: [],
      },
      ...keys.map((key, i): BreakdownRow => {
        const tokens = known ? (scaled[i] ?? 0) : null;
        const items = (byKey.get(key)?.items ?? [])
          .map((item) => ({ name: item.name, tokens: Math.round(item.tokens * factor) }))
          .sort((a, b) => b.tokens - a.tokens);
        return {
          key,
          tokens,
          percent: tokens === null ? null : pct(tokens),
          estimated: true,
          items,
        };
      }),
    ];
  }

  return {
    known,
    used,
    contextWindow,
    usedPercent,
    rows,
    deferred,
    free,
    freePercent: free === null ? null : pct(free),
  };
}

/** 缓存命中率：cacheRead / (input + cacheRead + cacheWrite)；分母为 0 时为 null */
export function cacheHitPercent(tokens: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return denominator > 0 ? (tokens.cacheRead / denominator) * 100 : null;
}
