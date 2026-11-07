import type { ContextStatsData } from "@primus/protocol";
import { describe, expect, it } from "vitest";
import { cacheHitPercent, computeBreakdown, scaleToTotal } from "./context-breakdown";

function stats(tokens: Partial<Record<string, number>>, deferredTools: string[] = []) {
  const keys = ["systemPrompt", "systemTools", "mcpTools", "skills", "memoryFiles"] as const;
  return {
    estimator: "chars/4",
    categories: keys.map((key) => ({
      key,
      tokens: tokens[key] ?? 0,
      items: key === "mcpTools" ? [{ name: "search", tokens: tokens[key] ?? 0 }] : [],
    })),
    deferredTools,
  } satisfies ContextStatsData;
}

const tokensOf = (b: ReturnType<typeof computeBreakdown>) =>
  Object.fromEntries(b.rows.map((r) => [r.key, r.tokens]));

describe("上下文分项计算", () => {
  it("消息 = 已用 − 各分项；可用空间 = 窗口 − 已用；百分比相对整个窗口", () => {
    const b = computeBreakdown(
      { tokens: 820_000, contextWindow: 1_000_000, percent: 82 },
      stats({ systemPrompt: 3_000, systemTools: 12_000, mcpTools: 5_000, skills: 1_000 }),
    );
    expect(b.rows.map((r) => r.key)).toEqual([
      "messages",
      "systemTools",
      "mcpTools",
      "skills",
      "systemPrompt",
      "memoryFiles",
    ]);
    expect(tokensOf(b)).toMatchObject({ messages: 799_000, systemTools: 12_000, memoryFiles: 0 });
    expect(b.rows[0]?.percent).toBeCloseTo(79.9);
    expect(b.free).toBe(180_000);
    expect(b.freePercent).toBeCloseTo(18);
    expect(b.usedPercent).toBe(82);
  });

  it("分项之和超过已用时按比例缩小，全部分项正好等于已用，消息为 0", () => {
    const b = computeBreakdown(
      { tokens: 1_000, contextWindow: 10_000, percent: 10 },
      stats({ systemPrompt: 1_000, systemTools: 500, mcpTools: 500 }),
    );
    const t = tokensOf(b);
    expect(t.messages).toBe(0);
    expect(t.systemPrompt).toBe(500);
    expect(t.systemTools).toBe(250);
    expect(t.mcpTools).toBe(250);
    expect(b.rows.reduce((n, r) => n + (r.tokens ?? 0), 0)).toBe(1_000);
    // 明细同比缩小
    expect(b.rows.find((r) => r.key === "mcpTools")?.items[0]?.tokens).toBe(250);
  });

  it("缩放结果为整数且总和准确（最大余数法）", () => {
    const out = scaleToTotal([1, 1, 1], 100);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out.every(Number.isInteger)).toBe(true);
    expect(scaleToTotal([0, 0], 10)).toEqual([0, 0]);
  });

  it("延迟加载的工具单独列出，不占百分比", () => {
    const b = computeBreakdown(
      { tokens: 5_000, contextWindow: 100_000, percent: 5 },
      stats({}, ["lazy", "later"]),
    );
    expect(b.deferred).toEqual([
      { name: "lazy", tokens: null, percent: null },
      { name: "later", tokens: null, percent: null },
    ]);
  });

  it("压缩后已用未知：分项与可用空间都未知", () => {
    const b = computeBreakdown(
      { tokens: null, contextWindow: 100_000, percent: null },
      stats({ systemPrompt: 100 }),
    );
    expect(b.known).toBe(false);
    expect(b.rows.every((r) => r.tokens === null && r.percent === null)).toBe(true);
    expect(b.free).toBeNull();
  });

  it("统计未到达前没有分项，只有已用与可用空间", () => {
    const b = computeBreakdown({ tokens: 30_000, contextWindow: 120_000, percent: 25 }, undefined);
    expect(b.rows).toEqual([]);
    expect(b.free).toBe(90_000);
  });

  it("缓存命中率 = 缓存读 / (输入 + 缓存读 + 缓存写)；分母为 0 时未知", () => {
    expect(cacheHitPercent({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(60);
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});
