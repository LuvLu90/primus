import type { ContextStatsData } from "@primus/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";
import { ContextButton, formatTokens } from "./context-card";

const c = strings.chat.contextCard;

const base = {
  connected: true,
  onCompact: vi.fn(),
  onAutoCompactionChange: vi.fn(),
};

const stats: ContextStatsData = {
  groups: [
    { key: "systemTools", items: ["bash", "read"] },
    { key: "mcpTools", items: ["mcp__docs__search"] },
    { key: "skills", items: ["pdf"] },
    { key: "memoryFiles", items: [] },
  ],
  usedTools: [
    { name: "read", count: 4 },
    { name: "mcp__docs__search", count: 1 },
  ],
};

/** 卡片里不允许出现任何估算痕迹 */
const ESTIMATE = /约|估算|字符数/;

const sessionUsage = {
  tokens: { input: 100_000, output: 21_400, cacheRead: 300_000, cacheWrite: 100_000, total: 0 },
  cost: 1.84,
};

async function openCard() {
  fireEvent.click(screen.getByRole("button", { name: /^上下文 / }));
  return screen.findByRole("dialog", { name: c.title });
}

/** 图例里一行（标签所在的 li） */
function legendRow(label: string) {
  const li = screen.getByText(label).closest("li");
  if (!li) throw new Error(`没有图例行：${label}`);
  return li;
}

describe("上下文卡片", () => {
  it("按钮只有小圆环：百分比只在无障碍名称里，不显示文字", () => {
    render(
      <ContextButton {...base} usage={{ tokens: 82_400, contextWindow: 200_000, percent: 41.2 }} />,
    );
    const button = screen.getByRole("button", { name: "上下文 41%" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
  });

  it("Core 没给 percent 时按钮与卡片一样按 tokens / contextWindow 计算", () => {
    render(
      <ContextButton {...base} usage={{ tokens: 50_000, contextWindow: 200_000, percent: null }} />,
    );
    expect(screen.getByRole("button", { name: "上下文 25%" })).toBeTruthy();
  });

  it("清单未到达前：只有已用与可用空间（Core 的真实数值）", async () => {
    const onOpen = vi.fn();
    render(
      <ContextButton
        {...base}
        onOpen={onOpen}
        usage={{ tokens: 82_400, contextWindow: 200_000, percent: 41.2 }}
        sessionUsage={sessionUsage}
        autoCompaction
      />,
    );
    const card = await openCard();
    expect(onOpen).toHaveBeenCalled();
    expect(card.textContent).toContain("82.4k / 200k (41%)");
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    expect(screen.getByRole("button", { name: c.collapse }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(within(legendRow(c.used)).getByText("41.2%")).toBeTruthy();
    expect(within(legendRow(c.free)).getByText("117.6k")).toBeTruthy();
    expect(within(legendRow(c.free)).getByText("58.8%")).toBeTruthy();
    expect(card.textContent).not.toMatch(ESTIMATE);
    expect(card.querySelectorAll("[data-segment]")).toHaveLength(1);
    expect(screen.queryByRole("list", { name: c.groupsLabel })).toBeNull();
  });

  it("有清单：只有一段已用、没有分项 token 与估算；分组只列名称与条目数；只列调用过的工具", async () => {
    render(
      <ContextButton
        {...base}
        usage={{ tokens: 820_000, contextWindow: 1_000_000, percent: 82 }}
        stats={stats}
        sessionUsage={sessionUsage}
      />,
    );
    const card = await openCard();
    expect(card.textContent).toContain("820k / 1M (82%)");
    // 不画分项：只有一段已用（82% 起警示色）
    const segments = card.querySelectorAll("[data-segment]");
    expect([...segments].map((s) => s.getAttribute("data-segment"))).toEqual(["used"]);
    expect(segments[0]?.className).toContain("bg-warning");
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    expect(within(legendRow(c.used)).getByText("820k")).toBeTruthy();
    expect(within(legendRow(c.used)).getByText("82.0%")).toBeTruthy();
    expect(within(legendRow(c.free)).getByText("180k")).toBeTruthy();
    expect(within(legendRow(c.free)).getByText("18.0%")).toBeTruthy();
    expect(card.textContent).not.toMatch(ESTIMATE);
    // 分组：条目数，展开后列出名称（没有 token 数）
    const groups = screen.getByRole("list", { name: c.groupsLabel });
    const tools = within(groups).getByRole("button", {
      name: `${c.categories.systemTools} ${c.itemCount.replace("{n}", "2")}`,
    });
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tools);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    const toolList = within(groups).getByRole("list", { name: c.categories.systemTools });
    expect([...toolList.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "bash",
      "read",
    ]);
    // 空分组不可展开
    const memory = within(groups).getByRole("button", {
      name: `${c.categories.memoryFiles} ${c.itemCount.replace("{n}", "0")}`,
    }) as HTMLButtonElement;
    expect(memory.disabled).toBe(true);
    // 本会话调用过的工具：种类与总次数，展开后逐个列出次数
    const used = within(groups).getByRole("button", {
      name: `${c.usedTools} ${c.itemCount.replace("{n}", "2")}`,
    });
    expect(used.textContent).toContain(c.callCount.replace("{n}", "5"));
    fireEvent.click(used);
    const usedList = within(groups).getByRole("list", { name: c.usedTools });
    expect(within(usedList).getByText("read")).toBeTruthy();
    expect(within(usedList).getByText(c.callCount.replace("{n}", "4"))).toBeTruthy();
    // 明细区可滚动但不显示滚动条
    expect(card.querySelector(".overflow-y-auto")?.classList.contains("scroll-none")).toBe(true);
  });

  it("没有调用过任何工具时不显示“调用过的工具”分组", async () => {
    render(
      <ContextButton
        {...base}
        usage={{ tokens: 820_000, contextWindow: 1_000_000, percent: 82 }}
        stats={{ ...stats, usedTools: [] }}
      />,
    );
    await openCard();
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    expect(screen.queryByText(c.usedTools)).toBeNull();
  });

  it("本会话用量：输入、输出、费用、缓存读取、缓存写入与命中率（一位小数）；分母为 0 时为“—”", async () => {
    const { unmount } = render(
      <ContextButton
        {...base}
        usage={{ tokens: 1_000, contextWindow: 10_000, percent: 10 }}
        sessionUsage={sessionUsage}
      />,
    );
    let card = await openCard();
    const stat = (el: HTMLElement, label: string) =>
      within(el).getByText(label).parentElement?.querySelector("dd")?.textContent;
    const hit = (el: HTMLElement) => stat(el, c.cacheHit);
    // 300k / (100k + 300k + 100k)
    expect(hit(card)).toBe("60.0%");
    expect(stat(card, c.input)).toBe("100k");
    expect(stat(card, c.output)).toBe("21.4k");
    expect(stat(card, c.cacheRead)).toBe("300k");
    expect(stat(card, c.cacheWrite)).toBe("100k");
    expect(stat(card, c.cost)).toBe("$1.84");
    unmount();
    render(
      <ContextButton
        {...base}
        usage={{ tokens: 1_000, contextWindow: 10_000, percent: 10 }}
        sessionUsage={{
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }}
      />,
    );
    card = await openCard();
    expect(hit(card)).toBe("—");
  });

  it("压缩后占用未知：只提示、没有数值与进度段；未打开会话时压缩与开关不可用", async () => {
    render(
      <ContextButton
        {...base}
        connected={false}
        stats={stats}
        usage={{ tokens: null, contextWindow: 200_000, percent: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文 —" }));
    const card = await screen.findByRole("dialog", { name: c.title });
    expect(card.textContent).toContain("— / 200k (—)");
    expect(card.querySelectorAll("[data-segment]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    expect(screen.getByText(c.unknownAfterCompact)).toBeTruthy();
    expect(screen.queryByText(c.used)).toBeNull();
    expect(screen.queryByText(c.free)).toBeNull();
    expect((screen.getByRole("button", { name: c.compactNow }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (
        screen.getByRole("switch", {
          name: `${c.autoCompact}（${c.autoCompactScope}）`,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("token 紧凑写法", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(82_400)).toBe("82.4k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});
