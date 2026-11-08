import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  falloff,
  type IndexItem,
  MessageIndex,
  magnitudes,
  nearestTick,
  RAIL_PAD,
  sample,
  TICK_PITCH,
} from "./message-index";

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

describe("刻度划过的放大衰减", () => {
  it("余弦衰减：中心为 1、半径处及以外为 0、对称且单调", () => {
    expect(falloff(0, 10)).toBe(1);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(25, 10)).toBe(0);
    expect(falloff(5, 10)).toBeCloseTo(0.5);
    expect(falloff(-3, 10)).toBe(falloff(3, 10));
    const curve = [0, 2, 4, 6, 8, 10].map((d) => falloff(d, 10));
    for (let i = 1; i < curve.length; i++)
      expect(curve[i] as number).toBeLessThan(curve[i - 1] as number);
    expect(falloff(1, 0)).toBe(0);
  });

  it("指针正对某道刻度时它最大，两侧对称递减；指针离开时全部归零", () => {
    const y = RAIL_PAD + TICK_PITCH * 5.5; // 第 6 道刻度中心
    const m = magnitudes(y, 12);
    expect(m[5]).toBe(1);
    expect(m[4]).toBeCloseTo(m[6] as number);
    expect(m[4] as number).toBeGreaterThan(m[3] as number);
    expect(m[3] as number).toBeGreaterThan(0); // 约 3 道刻度内都有响应
    expect(m[0]).toBe(0);
    expect(magnitudes(null, 12).every((x) => x === 0)).toBe(true);
  });

  it("最近刻度按位置计算并夹在范围内", () => {
    expect(nearestTick(RAIL_PAD + TICK_PITCH * 2.5, 10)).toBe(2);
    expect(nearestTick(-50, 10)).toBe(0);
    expect(nearestTick(9999, 10)).toBe(9);
  });
});

describe("对话索引交互", () => {
  function setup() {
    const scroll = document.createElement("div");
    Object.defineProperty(scroll, "scrollHeight", { value: 5000 });
    Object.defineProperty(scroll, "clientHeight", { value: 500 });
    for (let i = 0; i < 6; i++) {
      const node = document.createElement("div");
      node.dataset.msgIndex = String(i);
      scroll.appendChild(node);
    }
    document.body.appendChild(scroll);
    const ref = createRef<HTMLDivElement>();
    (ref as { current: HTMLDivElement | null }).current = scroll;
    const list: IndexItem[] = Array.from({ length: 6 }, (_, i) => ({
      index: i,
      text: `第 ${i} 个问题\n补充说明 ${i}`,
    }));
    render(<MessageIndex items={list} scrollRef={ref} />);
    const buttons = screen.getAllByRole("button");
    const rail = buttons[0]?.parentElement as HTMLElement;
    const ticks = buttons.map((b) => b.firstElementChild as HTMLElement);
    return { buttons, rail, ticks };
  }

  it("指针划过时最近的刻度放大并预览，离开后回落", async () => {
    const { rail, ticks } = setup();
    fireEvent.pointerMove(rail, { clientY: RAIL_PAD + TICK_PITCH * 2.5 });
    await waitFor(() => expect(ticks[2]?.style.getPropertyValue("--index-mag")).toBe("1.000"));
    expect(ticks[2]?.hasAttribute("data-near")).toBe(true);
    expect(Number(ticks[1]?.style.getPropertyValue("--index-mag"))).toBeGreaterThan(0);
    expect(Number(ticks[5]?.style.getPropertyValue("--index-mag"))).toBeLessThan(0.1);
    expect(screen.getByRole("tooltip").textContent).toContain("第 2 个问题");

    fireEvent.pointerOut(rail, { relatedTarget: document.body });
    await waitFor(() => expect(ticks[2]?.style.getPropertyValue("--index-mag")).toBe("0.000"));
    expect(ticks.some((t) => t.hasAttribute("data-near"))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("键盘：方向键在刻度间移动焦点，聚焦的刻度同样预览", async () => {
    const { buttons } = setup();
    act(() => buttons[0]?.focus());
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("第 1 个问题"));
    fireEvent.keyDown(buttons[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(buttons[5]);
  });
});
