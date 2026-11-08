// 上下文卡片的数值（纯函数）：只用 Core 给出的真实数据，不做任何估算。
// 已用 / 窗口 / 百分比来自 get_session_stats 的 contextUsage；可用空间 = 窗口 − 已用（同一组 Core 数值相减）。
// Core 不提供分项（系统提示、工具、技能、记忆文件、消息）的 token 统计，卡片不画分项占用。
import type { ContextUsage } from "@primus/protocol";

export interface ContextSummary {
  /** 已用总量已知（压缩后到下一条回复前为 false） */
  known: boolean;
  used: number | null;
  contextWindow: number;
  /** 已用占比（Core 给出的 percent，夹在 0–100） */
  usedPercent: number | null;
  free: number | null;
  freePercent: number | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function summarizeContext(usage: ContextUsage | undefined): ContextSummary {
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
  return {
    known,
    used,
    contextWindow,
    usedPercent,
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
