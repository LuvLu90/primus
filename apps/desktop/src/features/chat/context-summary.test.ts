import { describe, expect, it } from "vitest";
import { cacheHitPercent, summarizeContext } from "./context-summary";

describe("上下文卡片的数值", () => {
  it("已用与百分比直接取 Core；可用空间 = 窗口 − 已用；百分比相对整个窗口", () => {
    const s = summarizeContext({ tokens: 82_400, contextWindow: 200_000, percent: 41.2 });
    expect(s).toEqual({
      known: true,
      used: 82_400,
      contextWindow: 200_000,
      usedPercent: 41.2,
      free: 117_600,
      freePercent: 58.8,
    });
  });

  it("百分比夹在 0–100；Core 没给 percent 时按已用 / 窗口", () => {
    expect(
      summarizeContext({ tokens: 210_000, contextWindow: 200_000, percent: 105 }),
    ).toMatchObject({ usedPercent: 100, free: 0, freePercent: 0 });
    expect(
      summarizeContext({ tokens: 50_000, contextWindow: 200_000, percent: null }).usedPercent,
    ).toBe(25);
  });

  it("压缩后已用未知：已用、百分比与可用空间都未知", () => {
    expect(summarizeContext({ tokens: null, contextWindow: 200_000, percent: null })).toMatchObject(
      { known: false, used: null, usedPercent: null, free: null, freePercent: null },
    );
    expect(summarizeContext(undefined)).toMatchObject({ known: false, contextWindow: 0 });
  });

  it("缓存命中率 = 缓存读 / (输入 + 缓存读 + 缓存写)；分母为 0 时未知", () => {
    expect(cacheHitPercent({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(60);
    expect(cacheHitPercent({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});
