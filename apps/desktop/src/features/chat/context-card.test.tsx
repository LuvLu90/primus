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
  estimator: "chars/4",
  categories: [
    { key: "systemPrompt", tokens: 3_000, items: [] },
    {
      key: "systemTools",
      tokens: 12_000,
      items: [
        { name: "bash", tokens: 8_000 },
        { name: "read", tokens: 4_000 },
      ],
    },
    { key: "mcpTools", tokens: 5_000, items: [{ name: "mcp__docs__search", tokens: 5_000 }] },
    { key: "skills", tokens: 1_000, items: [{ name: "pdf", tokens: 1_000 }] },
    { key: "memoryFiles", tokens: 2_000, items: [{ name: "AGENTS.md", tokens: 2_000 }] },
  ],
  deferredTools: ["lazy_tool"],
};

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

  it("统计未到达前：只有已用与可用空间，不标“约”", async () => {
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
    expect(card.textContent).not.toContain(c.approx);
    expect(card.querySelectorAll("[data-segment]")).toHaveLength(1);
  });

  it("有分项：按分项着色、标“约”、百分比一位小数；延迟工具为“—”；分组可展开", async () => {
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
    // 六个分项都非零：六段
    expect(
      [...card.querySelectorAll("[data-segment]")].map((s) => s.getAttribute("data-segment")),
    ).toEqual(["messages", "systemTools", "mcpTools", "skills", "systemPrompt", "memoryFiles"]);
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    const messages = legendRow(c.categories.messages);
    expect(within(messages).getByText(`${c.approx} 797k`)).toBeTruthy();
    expect(within(messages).getByText("79.7%")).toBeTruthy();
    expect(within(legendRow(c.categories.systemPrompt)).getByText("0.3%")).toBeTruthy();
    // 延迟加载的工具：不占百分比
    const lazy = legendRow("lazy_tool");
    expect(within(lazy).getByText(c.deferred)).toBeTruthy();
    expect(within(lazy).getByText("—")).toBeTruthy();
    expect(within(legendRow(c.free)).getByText("18.0%")).toBeTruthy();
    // 分组：合计与条目数，展开后列出明细
    const groups = screen.getByRole("list", { name: c.groupsLabel });
    const tools = within(groups).getByRole("button", {
      name: `${c.categories.systemTools} ${c.itemCount.replace("{n}", "2")}`,
    });
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    expect(tools.textContent).toContain(`${c.approx} 12k`);
    fireEvent.click(tools);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    expect(within(groups).getByText("bash")).toBeTruthy();
    expect(within(groups).getByText(`${c.approx} 8k`)).toBeTruthy();
  });

  it("缓存命中显示命中率（一位小数）；分母为 0 时为“—”", async () => {
    const { unmount } = render(
      <ContextButton
        {...base}
        usage={{ tokens: 1_000, contextWindow: 10_000, percent: 10 }}
        sessionUsage={sessionUsage}
      />,
    );
    let card = await openCard();
    const hit = (el: HTMLElement) =>
      within(el).getByText(c.cacheRead).parentElement?.querySelector("dd")?.textContent;
    // 300k / (100k + 300k + 100k)
    expect(hit(card)).toBe("60.0%");
    expect(card.textContent).toContain("100k");
    expect(card.textContent).toContain("21.4k");
    expect(card.textContent).toContain("$1.84");
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

  it("压缩后占用未知：分项灰色、数值为“—”并提示；未打开会话时压缩与开关不可用", async () => {
    render(
      <ContextButton
        {...base}
        connected={false}
        stats={stats}
        usage={{ tokens: null, contextWindow: 200_000, percent: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文 —" }));
    fireEvent.click(await screen.findByRole("button", { name: c.expand }));
    expect(screen.getByText(c.unknownAfterCompact)).toBeTruthy();
    const messages = legendRow(c.categories.messages);
    expect(within(messages).getAllByText("—")).toHaveLength(2);
    expect(messages.querySelector("i")?.className).toContain("bg-track-strong");
    expect((screen.getByRole("button", { name: c.compactNow }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("switch", { name: c.autoCompact }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("token 紧凑写法", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(82_400)).toBe("82.4k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
  });
});
