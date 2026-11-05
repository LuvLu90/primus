import { describe, expect, it } from "vitest";
import { type IndexItem, sample } from "./message-index";

const items: IndexItem[] = Array.from({ length: 30 }, (_, i) => ({
  index: i * 2,
  text: `问题 ${i}`,
}));

describe("对话索引取样", () => {
  it("不超过上限时全部保留", () => {
    expect(sample(items.slice(0, 5), 4)).toHaveLength(5);
  });

  it("超过上限时取 24 道，首尾都在", () => {
    const out = sample(items);
    expect(out).toHaveLength(24);
    expect(out[0]).toBe(items[0]);
    expect(out.at(-1)).toBe(items.at(-1));
  });

  it("当前提问未被取样时替换最近的刻度，仍按顺序、数量不变", () => {
    const active = items[2] as IndexItem; // 默认取样跳过第 3 条
    expect(sample(items)).not.toContain(active);
    const out = sample(items, active.index);
    expect(out).toHaveLength(24);
    expect(out).toContain(active);
    expect(out[0]).toBe(items[0]);
    expect(out.at(-1)).toBe(items.at(-1));
    expect(out.map((x) => x.index)).toEqual([...out.map((x) => x.index)].sort((a, b) => a - b));
  });
});
