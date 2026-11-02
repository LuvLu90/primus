import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AuthStatus,
  type ModelsInfo,
  type Platform,
  PlatformError,
  setPlatformForTesting,
} from "@/lib/platform";
import { strings } from "@/lib/strings";
import { AccountSettings, formatTokens, ModelSettings } from "./account-models";

const ta = strings.settings.account;
const tm = strings.settings.models;

const auth: AuthStatus = {
  loggedIn: true,
  account: { id: "builtin", name: "内置测试账号", kind: "builtin" },
  loginAvailable: false,
};

const models: ModelsInfo = {
  version: 1,
  models: [
    {
      key: "a/big",
      provider: "a",
      id: "big",
      name: "大模型",
      api: "anthropic-messages",
      reasoning: true,
      image: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      key: "b/fast",
      provider: "b",
      id: "fast",
      name: "快速模型",
      api: "openai-responses",
      reasoning: false,
      image: false,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    },
  ],
  defaultModel: "a/big",
  compactionModel: "b/fast",
  titleModel: "b/fast",
  error: null,
};

function usePlatform(overrides: Partial<Platform>) {
  setPlatformForTesting(overrides as Platform);
}

describe("设置·账号与模型", () => {
  afterEach(() => setPlatformForTesting(undefined));

  it("令牌数简写", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_048_576)).toBe("1M");
    expect(formatTokens(128_000)).toBe("128K");
    expect(formatTokens(65_536)).toBe("66K");
    expect(formatTokens(512)).toBe("512");
  });

  it("账号页显示内置账号已登录，登录按钮禁用", async () => {
    usePlatform({ authStatus: async () => auth });
    render(<AccountSettings />);
    expect(await screen.findByText("内置测试账号")).toBeTruthy();
    expect(screen.getByText(ta.signedIn)).toBeTruthy();
    expect(screen.getByText(ta.builtinBadge)).toBeTruthy();
    expect((screen.getByRole("button", { name: ta.logout }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("模型页列出模型参数，并可改选默认模型", async () => {
    const modelsSetDefault = vi.fn(async (key: string) => ({ ...models, defaultModel: key }));
    usePlatform({ modelsGet: async () => models, modelsSetDefault });
    render(<ModelSettings />);
    const big = await screen.findByRole("radio", { name: "大模型" });
    expect(big.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByText(`${tm.context} 1M`)).toHaveLength(2);
    expect(screen.getByText(`${tm.maxOutput} 128K`)).toBeTruthy();
    expect(screen.getByText(tm.protocols["openai-responses"])).toBeTruthy();
    expect(screen.getAllByText("快速模型").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("radio", { name: "快速模型" }));
    await waitFor(() => expect(modelsSetDefault).toHaveBeenCalledWith("b/fast"));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "快速模型" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  it("配置未生效与保存失败时显示原因", async () => {
    usePlatform({
      modelsGet: async () => ({ ...models, error: "写入模型配置失败：磁盘已满" }),
      modelsSetDefault: async () => {
        throw new PlatformError("模型 b/fast 不在可用列表中");
      },
    });
    render(<ModelSettings />);
    expect((await screen.findByRole("alert")).textContent).toContain("磁盘已满");
    fireEvent.click(screen.getByRole("radio", { name: "快速模型" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[1]?.textContent).toContain("不在可用列表中");
  });

  it("刷新模型配置", async () => {
    const modelsRefresh = vi.fn(async () => models);
    usePlatform({ modelsGet: async () => models, modelsRefresh });
    render(<ModelSettings />);
    fireEvent.click(await screen.findByRole("button", { name: tm.refresh }));
    await waitFor(() => expect(modelsRefresh).toHaveBeenCalled());
  });
});
