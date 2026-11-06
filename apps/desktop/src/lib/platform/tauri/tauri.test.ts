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

  it("app_info 标记运行环境为 tauri", async () => {
    invoke.mockResolvedValueOnce({ appVersion: "0.1.0" });
    await expect(createTauriPlatform().appInfo()).resolves.toMatchObject({
      appVersion: "0.1.0",
      runtime: "tauri",
    });
  });
});
