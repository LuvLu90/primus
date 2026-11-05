import type { CoreBatch, CoreRecord, RpcResponse, StdinRecord } from "@primus/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockPlatform } from "@/lib/platform/mock";
import { applyChunks, initialSessionState, type RecordChunk } from "@/stores/session-store";
import {
  RESPONSE_TIMEOUT_MS,
  RpcClient,
  RpcClosedError,
  RpcResponseError,
  RpcTimeoutError,
} from "./rpc-client";

function setup(options: { send?: (r: StdinRecord) => Promise<void> } = {}) {
  const sent: StdinRecord[] = [];
  const chunks: RecordChunk[] = [];
  const onUnresponsive = vi.fn();
  const onResponsive = vi.fn();
  const onResyncError = vi.fn();
  const onResynced = vi.fn();
  const client = new RpcClient({
    sessionKey: "s",
    send:
      options.send ??
      (async (r) => {
        sent.push(r);
      }),
    onRecords: (records, { gap }) => chunks.push({ records, gap }),
    onUnresponsive,
    onResponsive,
    onResyncError,
    onResynced,
  });
  let seq = 0;
  const push = (records: CoreRecord[], extra: Partial<CoreBatch> = {}) =>
    client.receive({ sessionKey: "s", seq: ++seq, records, dropped: 0, ...extra });
  const skip = (n = 1) => {
    seq += n;
  };
  return {
    client,
    sent,
    chunks,
    push,
    skip,
    onUnresponsive,
    onResponsive,
    onResyncError,
    onResynced,
  };
}

const ok = (id: string, command: string, data?: unknown) =>
  ({ type: "response", id, command, success: true, data }) as RpcResponse;

describe("RPC 客户端", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("命令 id 为 <sessionKey>-<自增序号>，response 按 id 关联而非顺序", async () => {
    const { client, sent, push } = setup();
    const a = client.request("get_state");
    const b = client.request("prompt", { message: "你好" });
    expect(sent).toEqual([
      { id: "s-1", type: "get_state" },
      { id: "s-2", type: "prompt", message: "你好" },
    ]);
    push([ok("s-2", "prompt", { disposition: "started" }), ok("s-1", "get_state", {})]);
    await expect(b).resolves.toMatchObject({ command: "prompt", data: { disposition: "started" } });
    await expect(a).resolves.toMatchObject({ command: "get_state" });
    expect(client.pendingCount).toBe(0);
  });

  it("失败响应正常返回，由调用方判断", async () => {
    const { client, push } = setup();
    const r = client.request("set_model", { provider: "x", modelId: "y" });
    push([{ type: "response", id: "s-1", command: "set_model", success: false, error: "未找到" }]);
    await expect(r).resolves.toMatchObject({ success: false, error: "未找到" });
  });

  it("10 秒没有 response 判定内核无响应；迟到的 response 恢复", async () => {
    const { client, push, onUnresponsive, onResponsive } = setup();
    const r = client.request("get_state");
    const caught = r.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS - 1);
    expect(onUnresponsive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const error = await caught;
    expect(error).toBeInstanceOf(RpcTimeoutError);
    expect(error).toMatchObject({ id: "s-1", command: "get_state" });
    expect(onUnresponsive).toHaveBeenCalledWith({ id: "s-1", command: "get_state" });

    push([ok("s-1", "get_state", {})]);
    expect(onResponsive).toHaveBeenCalledTimes(1);
  });

  it("可选的统计命令超时不判定无响应，其迟到 response 也不解除别的命令造成的锁", async () => {
    const { client, push, onUnresponsive, onResponsive } = setup();
    const stats = client.request("get_session_stats").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    expect(await stats).toBeInstanceOf(RpcTimeoutError);
    expect(onUnresponsive).not.toHaveBeenCalled();
    const state = client.request("get_state").catch(() => {});
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await state;
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    push([ok("s-1", "get_session_stats", {})]);
    expect(onResponsive).not.toHaveBeenCalled();
  });

  it("多个命令超时时，任一迟到的 response 即恢复（其余 response 可能已随丢弃的批次丢失）", async () => {
    const { client, push, onUnresponsive, onResponsive } = setup();
    const a = client.request("get_state").catch(() => {});
    const b = client.request("get_messages").catch(() => {});
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS);
    await Promise.all([a, b]);
    expect(onUnresponsive).toHaveBeenCalledTimes(2);
    push([ok("s-2", "get_messages", { messages: [] })]);
    expect(onResponsive).toHaveBeenCalledTimes(1);
    // 同一恢复周期内，其余超时 id 的迟到 response 不再触发恢复回调
    push([ok("s-1", "get_state", {})]);
    expect(onResponsive).toHaveBeenCalledTimes(1);
    // 非超时命令的 response 不触发恢复回调
    const c = client.request("get_state");
    push([ok("s-3", "get_state", {})]);
    await c;
    expect(onResponsive).toHaveBeenCalledTimes(1);
  });

  it("bash 与 compact 等到操作完成才响应，不设超时", async () => {
    const { client, push, onUnresponsive } = setup();
    const r = client.request("bash", { command: "npm test" });
    await vi.advanceTimersByTimeAsync(RESPONSE_TIMEOUT_MS * 30);
    expect(onUnresponsive).not.toHaveBeenCalled();
    push([ok("s-1", "bash", { output: "", exitCode: 0, cancelled: false, truncated: false })]);
    await expect(r).resolves.toMatchObject({ success: true });
  });

  it("写入 stdin 失败时把原错误交给调用方并撤销等待", async () => {
    const { client } = setup({ send: () => Promise.reject(new Error("管道已关闭")) });
    await expect(client.request("abort")).rejects.toThrow("管道已关闭");
    expect(client.pendingCount).toBe(0);
  });

  it("重复或过期的批次忽略；按序交付记录", () => {
    const { client, chunks } = setup();
    client.receive({ sessionKey: "s", seq: 1, records: [{ type: "agent_start" }], dropped: 0 });
    client.receive({ sessionKey: "s", seq: 1, records: [{ type: "agent_start" }], dropped: 0 });
    client.receive({ sessionKey: "other", seq: 2, records: [], dropped: 0 });
    expect(chunks).toEqual([{ records: [{ type: "agent_start" }], gap: false }]);
    expect(client.lastSeq).toBe(1);
  });

  it("序号不连续时标记缺口并发 get_messages + get_state 重建", () => {
    const { client, sent, chunks, push, skip } = setup();
    push([{ type: "agent_start" }]);
    skip();
    push([
      { type: "turn_end", message: { role: "user", content: "", timestamp: 0 }, toolResults: [] },
    ]);
    expect(chunks.map((c) => c.gap)).toEqual([false, true]);
    expect(sent).toEqual([
      { id: "s-1", type: "get_messages" },
      { id: "s-2", type: "get_state" },
    ]);
    expect(client.isResyncing).toBe(true);
  });

  it("薄壳丢弃过记录（dropped > 0）同样重建；重建中再发现缺口时结束后再来一轮", async () => {
    const { client, sent, push, onResynced } = setup();
    push([], { dropped: 3 });
    push([], { dropped: 1 });
    expect(sent).toHaveLength(2); // 第二个缺口不重复发送
    push([ok("s-1", "get_messages", { messages: [] }), ok("s-2", "get_state", {})]);
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    push([ok("s-3", "get_messages", { messages: [] }), ok("s-4", "get_state", {})]);
    await vi.waitFor(() => expect(client.isResyncing).toBe(false));
    expect(onResynced).toHaveBeenCalledTimes(1);
  });

  it("本轮重建失败但期间又发现缺口时，仍为新缺口再重建一轮", async () => {
    const { client, sent, push, onResyncError, onResynced } = setup();
    push([], { dropped: 1 });
    push([], { dropped: 1 }); // 重建中的第二个缺口
    push([
      { type: "response", id: "s-1", command: "get_messages", success: false, error: "忙" },
      ok("s-2", "get_state", {}),
    ]);
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(onResyncError).toHaveBeenCalledTimes(1);
    push([ok("s-3", "get_messages", { messages: [] }), ok("s-4", "get_state", {})]);
    await vi.waitFor(() => expect(client.isResyncing).toBe(false));
    expect(onResynced).toHaveBeenCalledTimes(1);
  });

  it("重建失败时通知调用方，不报告完成", async () => {
    const { push, onResyncError, onResynced } = setup();
    push([], { dropped: 1 });
    push([
      { type: "response", id: "s-1", command: "get_messages", success: false, error: "忙" },
      ok("s-2", "get_state", {}),
    ]);
    await vi.waitFor(() => expect(onResyncError).toHaveBeenCalledTimes(1));
    const error = onResyncError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(RpcResponseError);
    expect(error).toMatchObject({ command: "get_messages", reason: "忙" });
    expect(onResynced).not.toHaveBeenCalled();
  });

  it("重启 reset() 中止进行中的重建不算失败；随后的 resync() 接着重建并报告结果", async () => {
    const { client, sent, push, onResyncError, onResynced } = setup();
    push([], { dropped: 1 }); // 自动重建：s-1、s-2
    expect(sent).toHaveLength(2);
    client.reset();
    const r = client.resync(); // 重启方在 reset 后立即重建
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(onResyncError).not.toHaveBeenCalled();
    push([ok("s-3", "get_messages", { messages: [] }), ok("s-4", "get_state", {})]);
    await expect(r).resolves.toBe(true);
    expect(onResyncError).not.toHaveBeenCalled();
    expect(onResynced).toHaveBeenCalledTimes(1);
  });

  it("resync() 返回是否成功，供重启后决定是否解除发送限制", async () => {
    const { client, push } = setup();
    const failed = client.resync();
    push([
      ok("s-1", "get_messages", { messages: [] }),
      { type: "response", id: "s-2", command: "get_state", success: false, error: "忙" },
    ]);
    await expect(failed).resolves.toBe(false);
    const succeeded = client.resync();
    push([ok("s-3", "get_messages", { messages: [] }), ok("s-4", "get_state", {})]);
    await expect(succeeded).resolves.toBe(true);
  });

  it("重启后等待中的命令以 RpcClosedError 结束；关闭后忽略批次与请求", async () => {
    const { client, chunks } = setup();
    const r = client.request("get_state");
    client.reset();
    await expect(r).rejects.toBeInstanceOf(RpcClosedError);

    client.close();
    client.receive({ sessionKey: "s", seq: 9, records: [{ type: "agent_start" }], dropped: 0 });
    expect(chunks).toEqual([]);
    await expect(client.request("get_state")).rejects.toBeInstanceOf(RpcClosedError);
  });

  it("扩展 UI 响应直接写入 stdin，不等待 response", async () => {
    const { client, sent } = setup();
    await client.respondUi({ type: "extension_ui_response", id: "u1", confirmed: true });
    expect(sent).toEqual([{ type: "extension_ui_response", id: "u1", confirmed: true }]);
    expect(client.pendingCount).toBe(0);
  });
});

describe("验收：模拟丢批次时自动 get_messages 重建", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function run(dropBatch?: (seq: number) => boolean) {
    const platform = createMockPlatform({ batchSize: 3, now: () => 1000, dropBatch });
    let state = initialSessionState;
    let client: RpcClient | undefined;
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) => client?.receive(b));
    const sent: StdinRecord[] = [];
    client = new RpcClient({
      sessionKey,
      send: (r) => {
        sent.push(r);
        return platform.coreSend(sessionKey, r);
      },
      onRecords: (records, { gap }) => {
        state = applyChunks(state, [{ records, gap }]);
      },
    });
    const response = await (async () => {
      const r = client.request("prompt", { message: "你好" });
      await vi.runAllTimersAsync();
      return r;
    })();
    expect(response.success).toBe(true);
    await vi.runAllTimersAsync();
    return { state, sent, client, read: () => state };
  }

  it("中途丢掉两个批次后自动重建，最终消息与不丢批次时一致，输入解锁", async () => {
    const baseline = await run();
    expect(baseline.sent.map((r) => r.type)).toEqual(["prompt"]);

    const dropped = await run((seq) => seq === 3 || seq === 5);
    // 两处缺口可能触发一到两轮重建；除 prompt 外只发重建命令
    const types = dropped.sent.map((r) => r.type);
    expect(types[0]).toBe("prompt");
    expect(types.slice(0, 3)).toEqual(["prompt", "get_messages", "get_state"]);
    expect(new Set(types.slice(1))).toEqual(new Set(["get_messages", "get_state"]));
    expect(dropped.state.needsResync).toBe(false);
    expect(dropped.state.messages).toEqual(baseline.state.messages);
    expect(dropped.state.running).toBe(false);
    expect(dropped.state.streamingMessage).toBe(false);
  });

  it("丢掉含 agent_settled 的最后一批：下一个批次到达时发现缺口，靠 get_state 解锁输入", async () => {
    const baseline = await run();
    let total = 0;
    await run((seq) => {
      total = Math.max(total, seq);
      return false;
    });
    const dropped = await run((seq) => seq === total);
    // 没有后续批次就无从发现缺口：输入仍锁定
    expect(dropped.state.running).toBe(true);
    // 之后任何一条记录（如下一条命令的 response）到达都会触发重建
    const next = dropped.client.request("get_commands").catch(() => {});
    await vi.runAllTimersAsync();
    await next;
    expect(dropped.sent.map((r) => r.type)).toEqual([
      "prompt",
      "get_commands",
      "get_messages",
      "get_state",
    ]);
    expect(dropped.read().running).toBe(false);
    expect(dropped.read().messages).toEqual(baseline.state.messages);
  });
});
