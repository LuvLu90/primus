import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";
import { ContextButton, formatTokens } from "./context-card";

const c = strings.chat.contextCard;

const base = {
  connected: true,
  onCompact: vi.fn(),
  onAutoCompactionChange: vi.fn(),
};

describe("上下文卡片", () => {
  it("显示占用、本会话用量；没有分项时只有已用与可用空间", async () => {
    const onOpen = vi.fn();
    render(
      <ContextButton
        {...base}
        onOpen={onOpen}
        usage={{ tokens: 82_400, contextWindow: 200_000, percent: 41.2 }}
        sessionUsage={{
          tokens: { input: 312_000, output: 21_400, cacheRead: 268_000, cacheWrite: 0, total: 0 },
          cost: 1.84,
        }}
        autoCompaction
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文 41%" }));
    expect(onOpen).toHaveBeenCalled();
    const card = await screen.findByRole("dialog", { name: c.title });
    expect(card.textContent).toContain("82.4k / 200k（41%）");
    expect(card.textContent).toContain("312k");
    expect(card.textContent).toContain("21.4k");
    expect(card.textContent).toContain("268k");
    expect(card.textContent).toContain("$1.84");
    fireEvent.click(screen.getByRole("button", { name: c.expand }));
    expect(screen.getByRole("button", { name: c.collapse }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText(c.used)).toBeTruthy();
    expect(screen.getByText(c.free)).toBeTruthy();
    expect(screen.getByText("117.6k")).toBeTruthy();
    // 没有分项来源时不显示“约”
    expect(card.textContent).not.toContain(c.approx);
  });

  it("有分项时按分项着色并标“约”", async () => {
    render(
      <ContextButton
        {...base}
        usage={{ tokens: 60_000, contextWindow: 200_000, percent: 30 }}
        breakdown={[
          { key: "messages", label: "消息", tokens: 40_000 },
          { key: "tools", label: "工具结果", tokens: 20_000 },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文 30%" }));
    fireEvent.click(await screen.findByRole("button", { name: c.expand }));
    expect(screen.getByText("消息")).toBeTruthy();
    expect(screen.getByText(`${c.approx} 40k`)).toBeTruthy();
  });

  it("压缩后占用未知；未打开会话时压缩与开关不可用", async () => {
    render(
      <ContextButton
        {...base}
        connected={false}
        usage={{ tokens: null, contextWindow: 200_000, percent: null }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文 —" }));
    fireEvent.click(await screen.findByRole("button", { name: c.expand }));
    expect(screen.getByText(c.unknownAfterCompact)).toBeTruthy();
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
