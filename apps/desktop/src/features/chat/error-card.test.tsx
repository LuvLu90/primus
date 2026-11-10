import type { AssistantMessage } from "@primus/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPlatformForTesting } from "@/lib/platform";
import { createMockPlatform } from "@/lib/platform/mock";
import { strings } from "@/lib/strings";
import { ErrorCard, RetryNotice } from "./error-card";

const t = strings.chat.replyError;

const failed = (errorMessage: string, extra: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "ioply",
    model: "mock-large",
    usage: {},
    stopReason: "error",
    errorMessage,
    timestamp: new Date(2026, 10, 8, 14, 2, 11).getTime(),
    durationMs: 10_412,
    ...extra,
  }) as unknown as AssistantMessage;

afterEach(() => setPlatformForTesting(undefined));

describe("错误卡片", () => {
  it("连接错误：一行标题与操作，建议在悬停提示里，元信息收在详细信息中", () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <ErrorCard
        message={failed("Connection error.")}
        providerName="ioply 网关"
        retryResult={{ attempt: 3, success: false, finalError: "Connection error." }}
        actions={{ onRetry, onOpenSettings }}
      />,
    );
    expect(
      screen.getByRole("region", {
        name: `${strings.chat.replyFailed}：${t.categories.connection.title}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(t.categories.connection.hint)).toBeNull();
    expect(
      screen
        .getByRole("heading", {
          name: `${strings.chat.replyFailed}：${t.categories.connection.title}`,
        })
        .getAttribute("title"),
    ).toBe(t.categories.connection.hint);
    expect(screen.getByText(t.retried.replace("{n}", "3"))).toBeTruthy();
    expect(screen.queryByText("ioply 网关")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.details }));
    // 提示在详情里也能看到（触屏、键盘用户无需悬停）
    // 详情里同时给出原因与按类别区分的处理建议
    expect(
      screen.getByText(`${t.categories.connection.hint}${t.categories.connection.action}`),
    ).toBeTruthy();
    expect(screen.getByText("ioply 网关")).toBeTruthy();
    expect(screen.getByText("mock-large")).toBeTruthy();
    expect(screen.getByText("10.4s")).toBeTruthy();
    expect(screen.getByText("14:02:11")).toBeTruthy();
    // 没有状态码时不显示 HTTP 状态
    expect(screen.queryByText(t.status)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.retry }));
    fireEvent.click(screen.getByRole("button", { name: t.openSettings }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("认证错误显示解析出的 HTTP 状态码；限流不提供检查渠道与检测连接", () => {
    const { unmount } = render(
      <ErrorCard
        message={failed('ioply API error (401): {"error":"bad key"}')}
        actions={{ onOpenSettings: () => {} }}
      />,
    );
    expect(
      screen.getByText(`${strings.chat.replyFailed}：${t.categories.auth.title}`),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.details }));
    expect(screen.getByText("401")).toBeTruthy();
    expect(screen.getByRole("button", { name: t.probe })).toBeTruthy();
    unmount();
    render(
      <ErrorCard
        message={failed("ioply API error (429): slow down")}
        actions={{ onOpenSettings: () => {} }}
      />,
    );
    expect(
      screen.getByText(`${strings.chat.replyFailed}：${t.categories.rateLimit.title}`),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.openSettings })).toBeNull();
    expect(screen.queryByRole("button", { name: t.probe })).toBeNull();
    // 没有重试回调（历史轮次或运行中）时不显示重试
    expect(screen.queryByRole("button", { name: t.retry })).toBeNull();
    // 详细信息里保留按类别区分的处理建议
    fireEvent.click(screen.getByRole("button", { name: t.details }));
    expect(
      screen.getByText(`${t.categories.rateLimit.hint}${t.categories.rateLimit.action}`),
    ).toBeTruthy();
  });

  it("详细信息可折叠，含完整错误文本与诊断，可复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ErrorCard
        message={failed("ioply API error (529): Overloaded", {
          diagnostics: [
            {
              type: "provider_error",
              timestamp: 1,
              error: { name: "APIError", message: "Overloaded", code: 529 },
            },
          ],
        })}
      />,
    );
    const toggle = screen.getByRole("button", { name: t.details });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("ioply API error (529): Overloaded")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: t.hideDetails }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("ioply API error (529): Overloaded")).toBeTruthy();
    expect(screen.getByText("[provider_error] APIError: Overloaded (529)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.copyDetails }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0]?.[0]).toContain("ioply API error (529): Overloaded");
    expect(await screen.findByRole("button", { name: strings.chat.copied })).toBeTruthy();
  });

  it("检测连接：用渠道的模型列表接口探测，显示结果", async () => {
    setPlatformForTesting(createMockPlatform({ fetchDelayMs: 0 }));
    render(<ErrorCard message={failed("Connection error.")} />);
    fireEvent.click(screen.getByRole("button", { name: t.probe }));
    expect(await screen.findByText(/可以连通模型渠道/)).toBeTruthy();
  });

  it("检测连接失败时显示原因", async () => {
    setPlatformForTesting(createMockPlatform({ fetchDelayMs: 0 }));
    render(<ErrorCard message={failed("Connection error.", { provider: "missing" })} />);
    fireEvent.click(screen.getByRole("button", { name: t.probe }));
    expect(await screen.findByText(new RegExp(`${t.probeFailed}：渠道不存在`))).toBeTruthy();
  });
});

describe("自动重试提示", () => {
  it("倒计时到点后显示正在重试；停止重试调用回调并禁用按钮", async () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const onStop = vi.fn().mockResolvedValue(true);
      render(
        <RetryNotice
          retry={{
            attempt: 2,
            maxAttempts: 3,
            delayMs: 4000,
            errorMessage: "Connection error.",
            at: 10_000,
          }}
          onStop={onStop}
        />,
      );
      expect(screen.getByText(/4 秒后进行第 2\/3 次重试/)).toBeTruthy();
      expect(screen.getByText(t.categories.connection.title)).toBeTruthy();
      act(() => vi.advanceTimersByTime(4100));
      expect(screen.getByText(/正在进行第 2\/3 次重试/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: t.stopRetry }));
      expect(onStop).toHaveBeenCalledOnce();
      expect(
        (screen.getByRole("button", { name: t.stoppingRetry }) as HTMLButtonElement).disabled,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
