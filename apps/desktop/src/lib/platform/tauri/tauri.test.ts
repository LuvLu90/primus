import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, CORE_NOT_RUNNING, PlatformError } from "../types";

// vi.mock 会被提升到文件顶部，用 vi.hoisted 定义它引用的替身
const { invoke, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (msg: T) => void = () => {};
  }
  return {
    invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
    FakeChannel,
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: FakeChannel }));

const { createTauriPlatform } = await import("./index");

describe("Tauri 平台实现", () => {
  beforeEach(() => invoke.mockClear());

  it("实现了附录 B 的全部命令", () => {
    expect(Object.keys(createTauriPlatform()).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it("命令名与参数按附录 B 传给 invoke", async () => {
    const p = createTauriPlatform();
    const record = { id: "k-1", type: "get_state" };
    await p.coreSend("k", record);
    expect(invoke).toHaveBeenLastCalledWith("core_send", { sessionKey: "k", record });
    await p.terminalResize("t1", 120, 30);
    expect(invoke).toHaveBeenLastCalledWith("terminal_resize", {
      terminalId: "t1",
      cols: 120,
      rows: 30,
    });
  });

  it("session_open 通过 Channel 把批次交给回调", async () => {
    invoke.mockResolvedValueOnce({ sessionKey: "ws1:s1" });
    const onBatch = vi.fn();
    const p = createTauriPlatform();
    await expect(p.sessionOpen("ws1", undefined, onBatch)).resolves.toEqual({
      sessionKey: "ws1:s1",
    });
    const [name, args] = invoke.mock.calls.at(-1) as [
      string,
      { onEvent: InstanceType<typeof FakeChannel<unknown>> },
    ];
    expect(name).toBe("session_open");
    const batch = { sessionKey: "ws1:s1", seq: 1, records: [], dropped: 0 };
    args.onEvent.onmessage(batch);
    expect(onBatch).toHaveBeenCalledWith(batch);
  });

  it("结构化拒绝值转成带 code 的 PlatformError", async () => {
    invoke.mockRejectedValueOnce({ code: CORE_NOT_RUNNING, message: "会话的内核未运行" });
    const p = createTauriPlatform();
    const error = await p.coreSend("k", { id: "k-1", type: "get_state" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect(error).toMatchObject({ code: CORE_NOT_RUNNING, message: "会话的内核未运行" });
  });

  it("更新命令的参数：缺省值传 null / false，状态经 Channel 推送", async () => {
    const p = createTauriPlatform();
    await p.updateCheck();
    expect(invoke).toHaveBeenLastCalledWith("update_check", { channel: null });
    await p.updateCheck("beta");
    expect(invoke).toHaveBeenLastCalledWith("update_check", { channel: "beta" });
    await p.updateSettingsSet({ autoUpdate: false });
    expect(invoke).toHaveBeenLastCalledWith("update_settings_set", {
      autoUpdate: false,
      channel: null,
    });
    await p.updateInstall();
    expect(invoke).toHaveBeenLastCalledWith("update_install", { force: false });
    await p.updateInstall(true);
    expect(invoke).toHaveBeenLastCalledWith("update_install", { force: true });
    const onChange = vi.fn();
    await p.updateWatch(onChange);
    const [name, args] = invoke.mock.calls.at(-1) as [
      string,
      { onEvent: InstanceType<typeof FakeChannel<unknown>> },
    ];
    expect(name).toBe("update_watch");
    args.onEvent.onmessage({ phase: "idle" });
    expect(onChange).toHaveBeenCalledWith({ phase: "idle" });
  });

  it("模型渠道命令：只传契约字段，缺省的可选字段不传；模型配置经 Channel 推送", async () => {
    const p = createTauriPlatform();
    const model = {
      id: "m",
      name: "M",
      reasoning: false,
      input: ["text" as const],
      contextWindow: 1,
      maxTokens: 1,
      extra: "不应发送",
    };
    await p.providerSave({
      name: "n",
      api: "openai-responses",
      baseUrl: "https://x",
      enabled: true,
      models: [model],
    });
    const [name, args] = invoke.mock.calls.at(-1) as [string, { input: Record<string, unknown> }];
    expect(name).toBe("provider_save");
    expect(args.input).toStrictEqual({
      name: "n",
      api: "openai-responses",
      baseUrl: "https://x",
      enabled: true,
      models: [
        { id: "m", name: "M", reasoning: false, input: ["text"], contextWindow: 1, maxTokens: 1 },
      ],
    });
    await p.providerFetchModels({ id: "ioply", baseUrl: "https://y" });
    expect(invoke).toHaveBeenLastCalledWith("provider_fetch_models", {
      input: { id: "ioply", baseUrl: "https://y" },
    });
    await p.providerDelete("ioply");
    expect(invoke).toHaveBeenLastCalledWith("provider_delete", { id: "ioply" });
    await p.providersList();
    expect(invoke).toHaveBeenLastCalledWith("providers_list", undefined);
    const onChange = vi.fn();
    await p.modelsWatch(onChange);
    const [watchName, watchArgs] = invoke.mock.calls.at(-1) as [
      string,
      { onEvent: InstanceType<typeof FakeChannel<unknown>> },
    ];
    expect(watchName).toBe("models_watch");
    watchArgs.onEvent.onmessage({ models: [] });
    expect(onChange).toHaveBeenCalledWith({ models: [] });
  });

  it("app_info 标记运行环境为 tauri", async () => {
    invoke.mockResolvedValueOnce({ appVersion: "0.1.0" });
    await expect(createTauriPlatform().appInfo()).resolves.toMatchObject({
      appVersion: "0.1.0",
      runtime: "tauri",
    });
  });

  it("语音、附件图片与分支命令按附录 B 传参，语音事件经 Channel 推送", async () => {
    const p = createTauriPlatform();
    await p.attachmentImage("C:\\a.png", 2048);
    expect(invoke).toHaveBeenLastCalledWith("attachment_image", {
      path: "C:\\a.png",
      maxEdge: 2048,
    });
    await p.gitBranch("C:\\repo");
    expect(invoke).toHaveBeenLastCalledWith("git_branch", { workspace: "C:\\repo" });
    const onEvent = vi.fn();
    await p.speechStart(onEvent);
    const [name, args] = invoke.mock.calls.at(-1) as [
      string,
      { onEvent: InstanceType<typeof FakeChannel<unknown>> },
    ];
    expect(name).toBe("speech_start");
    args.onEvent.onmessage({ type: "final", text: "你好" });
    expect(onEvent).toHaveBeenCalledWith({ type: "final", text: "你好" });
    await p.speechStop();
    expect(invoke).toHaveBeenLastCalledWith("speech_stop", undefined);
  });
});
