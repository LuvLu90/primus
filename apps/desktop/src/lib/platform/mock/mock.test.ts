import type { CoreBatch, CoreRecord } from "@primus/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../types";
import { compareSemver, createMockPlatform } from "./index";
import { chunk, promptScenario, REFERENCES_TAG, TYPOGRAPHY_TAG } from "./scenario";

const types = (records: CoreRecord[]) => records.map((r) => r.type);

describe("mock 平台", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("实现了附录 B 的全部命令", () => {
    const platform = createMockPlatform();
    expect(Object.keys(platform).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it("模型渠道：预置 ioply；保存、删除更新模型配置并经 models_watch 推送；账号未登录", async () => {
    const platform = createMockPlatform({ fetchDelayMs: 0 });
    await expect(platform.authStatus()).resolves.toEqual({
      loggedIn: false,
      account: null,
      loginAvailable: false,
    });
    const [ioply] = await platform.providersList();
    expect(ioply).toMatchObject({ id: "ioply", hasKey: true, keyHint: "c74e" });
    expect(JSON.stringify(ioply)).not.toContain("placeholder");
    expect((await platform.modelsGet()).defaultModel).toBe("ioply/mock-large");

    const pushed: string[][] = [];
    await platform.modelsWatch((info) => pushed.push(info.models.map((m) => m.key)));
    await expect(
      platform.providerFetchModels({
        api: "openai-responses",
        baseUrl: "https://x",
        apiKey: "bad",
      }),
    ).rejects.toThrow("HTTP 401");
    const fetched = await platform.providerFetchModels({ id: "ioply" });
    expect(fetched.map((m) => m.id)).toContain("mock-coder");
    // 已保存的模型保留原参数
    expect(fetched.find((m) => m.id === "mock-large")?.contextWindow).toBe(1_000_000);

    const created = await platform.providerSave({
      name: "公司 网关",
      api: "anthropic-messages",
      baseUrl: "https://gw.example.com/v1/",
      apiKey: "sk-12345678",
      enabled: true,
      models: fetched.filter((m) => m.id === "mock-coder"),
    });
    const added = created.providers.find((p) => p.name === "公司 网关");
    expect(added).toMatchObject({
      id: "provider",
      baseUrl: "https://gw.example.com/v1",
      keyHint: "5678",
    });
    expect(created.models.models.map((m) => m.key)).toContain("provider/mock-coder");
    expect(pushed.at(-1)).toContain("provider/mock-coder");
    await expect(
      platform.providerSave({
        name: "x",
        api: "openai-responses",
        baseUrl: "https://x",
        apiKey: "k",
        enabled: true,
        models: [{ ...fetched[0], extra: 1 } as unknown as (typeof fetched)[0]],
      }),
    ).rejects.toThrow("未知字段");
    // 与薄壳一致的校验：密钥含控制字符、参数不是整数、地址带查询参数
    const model = fetched[0];
    if (!model) throw new Error("缺少模型");
    const base = {
      name: "y",
      api: "openai-responses" as const,
      baseUrl: "https://y",
      apiKey: "k",
      enabled: true,
      models: [model],
    };
    await expect(platform.providerSave({ ...base, apiKey: "a\nb" })).rejects.toThrow("无效字符");
    await expect(
      platform.providerSave({ ...base, models: [{ ...model, contextWindow: 1.5 }] }),
    ).rejects.toThrow("正整数");
    await expect(
      platform.providerSave({ ...base, baseUrl: "https://y/v1?tenant=a" }),
    ).rejects.toThrow("查询参数");
    await expect(
      platform.providerSave({ ...base, baseUrl: "https://user:pw@y/v1" }),
    ).rejects.toThrow("接口地址");
    await expect(platform.providerSave({ ...base, baseUrl: "https://y:99999/v1" })).rejects.toThrow(
      "接口地址",
    );

    // 默认模型所在渠道停用后回退到其他模型，重新启用也不恢复旧默认值（回退结果已写回）
    const ioplyView = created.providers.find((p) => p.id === "ioply");
    if (!ioplyView) throw new Error("缺少 ioply");
    const ioplyInput = {
      id: "ioply",
      name: ioplyView.name,
      api: ioplyView.api,
      baseUrl: ioplyView.baseUrl,
      models: ioplyView.models,
    };
    const disabled = await platform.providerSave({ ...ioplyInput, enabled: false });
    expect(disabled.models.defaultModel).toBe("provider/mock-coder");
    const enabled = await platform.providerSave({ ...ioplyInput, enabled: true });
    expect(enabled.models.defaultModel).toBe("provider/mock-coder");

    await platform.providerDelete("ioply");
    const left = await platform.providerDelete("provider");
    expect(left.providers).toEqual([]);
    expect(left.models).toMatchObject({ models: [], defaultModel: null });
    expect(left.models.error).toContain("还没有可用的模型");
    expect(pushed.at(-1)).toEqual([]);
  });

  it("自动更新：默认开、稳定版；有新版本时检查后得到待装版本并推送", async () => {
    const platform = createMockPlatform({ latestVersion: "9.9.9", now: () => 5 });
    const seen: string[] = [];
    await platform.updateWatch((s) => seen.push(s.phase));
    const initial = await platform.updateStatus();
    expect(initial.settings).toEqual({ autoUpdate: true, channel: "stable" });
    expect(initial.pending).toBeNull();
    const status = await platform.updateCheck();
    expect(status.pending).toEqual({ version: "9.9.9", notes: null });
    expect(status.lastCheck).toBe(5);
    expect(seen).toContain("downloading");
    await expect(platform.updateSettingsSet({ channel: "beta" })).resolves.toMatchObject({
      settings: { autoUpdate: true, channel: "beta" },
    });
  });

  it("自动更新：低于当前版本的预发布不算更新", async () => {
    const platform = createMockPlatform({ latestVersion: "0.0.0-alpha" });
    await expect(platform.updateCheck()).resolves.toMatchObject({ pending: null });
  });

  it("SemVer 比较与薄壳一致", () => {
    expect(compareSemver("0.0.0-alpha", "0.0.0-mock")).toBeLessThan(0);
    expect(compareSemver("1.3.0", "1.3.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.3.0-beta.10", "1.3.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.3.0-beta", "1.3.0-beta.1")).toBeLessThan(0);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("garbage", "0.0.1")).toBeLessThan(0);
  });

  it("自动更新：没有新版本时检查结果无待装版本，安装被拒绝", async () => {
    const platform = createMockPlatform();
    await expect(platform.updateCheck()).resolves.toMatchObject({ pending: null });
    await expect(platform.updateInstall()).rejects.toMatchObject({ code: "noPending" });
  });

  it("prompt 先回 response，再按 16ms 一批推送完整事件流，seq 连续", async () => {
    const platform = createMockPlatform({ batchSize: 5, now: () => 1000 });
    const batches: CoreBatch[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) => batches.push(b));
    await platform.coreSend(sessionKey, { id: `${sessionKey}-1`, type: "prompt", message: "你好" });

    expect(batches).toHaveLength(0); // 异步推送
    await vi.advanceTimersByTimeAsync(16);
    expect(batches).toHaveLength(1);
    await vi.runAllTimersAsync();

    expect(batches.map((b) => b.seq)).toEqual(batches.map((_, i) => i + 1));
    expect(batches.every((b) => b.sessionKey === sessionKey && b.dropped === 0)).toBe(true);
    const records = batches.flatMap((b) => b.records);
    expect(records[0]).toMatchObject({
      type: "response",
      id: `${sessionKey}-1`,
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    expect(types(records).slice(1, 3)).toEqual(["agent_start", "turn_start"]);
    expect(types(records).slice(-2)).toEqual(["agent_end", "agent_settled"]);
  });

  it("#错误:<类别> 返回失败回复：错误文本仿照 Core 的写法，带渠道、模型与耗时", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { type: "prompt", message: "hi #错误:认证" });
    await vi.runAllTimersAsync();
    const end = records.findLast((r) => r.type === "message_end");
    expect(end).toMatchObject({
      message: {
        role: "assistant",
        stopReason: "error",
        provider: "ioply",
        model: "mock-large",
        errorMessage: expect.stringMatching(/^ioply API error \(401\): /),
        durationMs: expect.any(Number),
      },
    });
    expect(types(records).slice(-2)).toEqual(["agent_end", "agent_settled"]);
    // 网络类错误之后“检测连接”同样失败，正常发送后恢复
    await platform.coreSend(sessionKey, { type: "prompt", message: "hi #错误:连接" });
    await vi.runAllTimersAsync();
    const probe = platform.providerFetchModels({ id: "ioply" });
    const rejected = expect(probe).rejects.toThrow("无法连接到服务器");
    await vi.runAllTimersAsync();
    await rejected;
  });

  it("#错误:重试：auto_retry_start 后按延时继续；abort_retry 取消等待并补上 Retry cancelled", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { type: "prompt", message: "#错误:重试" });
    await vi.advanceTimersByTimeAsync(50);
    expect(records.at(-1)).toMatchObject({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
    // 第一次重试的等待结束：第二次失败，开始第二次重试
    await vi.advanceTimersByTimeAsync(3100);
    expect(records.at(-1)).toMatchObject({ type: "auto_retry_start", attempt: 2 });
    await platform.coreSend(sessionKey, { id: "r", type: "abort_retry" });
    await vi.runAllTimersAsync();
    expect(records.slice(-4)).toMatchObject([
      { type: "auto_retry_end", success: false, attempt: 2, finalError: "Retry cancelled" },
      { type: "agent_end" },
      { type: "agent_settled" },
      { type: "response", id: "r", command: "abort_retry", success: true },
    ]);
    expect(records.filter((r) => r.type === "auto_retry_start")).toHaveLength(2);
  });

  it("#错误:重试成功：重试一次后得到回答，auto_retry_end 为成功", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { type: "prompt", message: "#错误:重试成功" });
    await vi.runAllTimersAsync();
    expect(records.find((r) => r.type === "auto_retry_end")).toEqual({
      type: "auto_retry_end",
      success: true,
      attempt: 1,
    });
    expect(records.findLast((r) => r.type === "message_end")).toMatchObject({
      message: { stopReason: "stop" },
    });
  });

  it("运行中再次 prompt 返回失败响应；abort 丢弃剩余事件并以 aborted 结束", async () => {
    const platform = createMockPlatform({ batchSize: 3 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "a-1", type: "prompt", message: "一" });
    await vi.advanceTimersByTimeAsync(16);
    await platform.coreSend(sessionKey, { id: "a-2", type: "prompt", message: "二" });
    await platform.coreSend(sessionKey, { id: "a-3", type: "abort" });
    await vi.runAllTimersAsync();

    expect(records.find((r) => "id" in r && r.id === "a-2")).toMatchObject({ success: false });
    // 与 Core 一致：会话空闲（agent_settled）之后才回 abort 的 response
    expect(records.at(-1)).toMatchObject({ id: "a-3", command: "abort", success: true });
    expect(records.at(-2)).toEqual({ type: "agent_settled", aborted: true });
    expect(types(records)).not.toContain("turn_end");

    // 结束后可以再次发送
    records.length = 0;
    await platform.coreSend(sessionKey, { id: "a-4", type: "prompt", message: "三" });
    await vi.runAllTimersAsync();
    expect(records[0]).toMatchObject({ id: "a-4", success: true });
  });

  it("流式途中 abort：助手消息以已推送的内容结束（aborted），历史只含已定稿的消息", async () => {
    const platform = createMockPlatform({ batchSize: 1, now: () => 5000 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "b-1", type: "prompt", message: "停" });
    // 推到第一条助手消息的文本开始输出
    while (
      !records.some(
        (r) => r.type === "message_update" && r.assistantMessageEvent.type === "text_delta",
      )
    )
      await vi.advanceTimersByTimeAsync(16);
    await platform.coreSend(sessionKey, { id: "b-2", type: "abort" });
    await vi.runAllTimersAsync();

    const ends = records.filter((r) => r.type === "message_end");
    const aborted = ends.at(-1) as Extract<CoreRecord, { type: "message_end" }>;
    expect(aborted.message).toMatchObject({ role: "assistant", stopReason: "aborted" });
    const content = (aborted.message as { content: Array<{ type: string; text?: string }> })
      .content;
    expect(content[0]).toMatchObject({ type: "thinking" });
    const text = content.find((c) => c.type === "text")?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect("我先查看一下工作区的文件。".startsWith(text)).toBe(true);
    expect(types(records)).not.toContain("tool_execution_start");

    records.length = 0;
    await platform.coreSend(sessionKey, { id: "b-3", type: "get_messages" });
    await vi.runAllTimersAsync();
    const got = records[0] as { data: { messages: Array<{ role: string; stopReason?: string }> } };
    expect(got.data.messages.map((m) => [m.role, m.stopReason])).toEqual([
      ["user", undefined],
      ["assistant", "aborted"],
    ]);
  });

  it("用户消息推送前就 abort：用户消息仍推送并留在历史里", async () => {
    const platform = createMockPlatform({ batchSize: 1 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "u-1", type: "prompt", message: "马上停" });
    await platform.coreSend(sessionKey, { id: "u-2", type: "abort" });
    await vi.runAllTimersAsync();
    expect(types(records)).toEqual([
      "response",
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "agent_end",
      "agent_settled",
      "response",
    ]);
    records.length = 0;
    await platform.coreSend(sessionKey, { id: "u-3", type: "get_messages" });
    await vi.runAllTimersAsync();
    const got = records[0] as { data: { messages: Array<{ role: string }> } };
    expect(got.data.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("get_messages 的快照包含排在它前面、尚未推送的已定稿消息，且不重复", async () => {
    const platform = createMockPlatform({ batchSize: 1 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "g-1", type: "prompt", message: "hi" });
    // 一条都没推送就请求历史：响应排在整轮事件之后，应含整轮四条消息
    await platform.coreSend(sessionKey, { id: "g-2", type: "get_messages" });
    await vi.runAllTimersAsync();
    const got = records.find((r) => "id" in r && r.id === "g-2") as {
      data: { messages: Array<{ role: string }> };
    };
    expect(got.data.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    records.length = 0;
    await platform.coreSend(sessionKey, { id: "g-3", type: "get_messages" });
    await vi.runAllTimersAsync();
    expect((records[0] as typeof got).data.messages).toHaveLength(4);
  });

  it("get_messages 排在 abort 之前：快照与推送时的历史一致，不含被 abort 丢弃的消息", async () => {
    const platform = createMockPlatform({ batchSize: 1 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "q-1", type: "prompt", message: "hi" });
    await platform.coreSend(sessionKey, { id: "q-2", type: "get_messages" });
    await platform.coreSend(sessionKey, { id: "q-3", type: "abort" });
    await vi.runAllTimersAsync();
    const roles = (id: string) =>
      (
        records.find((r) => "id" in r && r.id === id) as {
          data: { messages: Array<{ role: string }> };
        }
      ).data.messages.map((m) => m.role);
    expect(roles("q-2")).toEqual(["user"]);
    await platform.coreSend(sessionKey, { id: "q-4", type: "get_messages" });
    await vi.runAllTimersAsync();
    expect(roles("q-4")).toEqual(["user"]);
  });

  it("连续两次 abort：只结束一次，两条响应都在 agent_settled 之后", async () => {
    const platform = createMockPlatform({ batchSize: 2 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "d-1", type: "prompt", message: "hi" });
    await vi.advanceTimersByTimeAsync(16);
    await platform.coreSend(sessionKey, { id: "d-2", type: "abort" });
    await platform.coreSend(sessionKey, { id: "d-3", type: "abort" });
    await vi.runAllTimersAsync();
    expect(types(records).filter((t) => t === "agent_settled")).toHaveLength(1);
    expect(types(records).slice(-4)).toEqual([
      "agent_end",
      "agent_settled",
      "response",
      "response",
    ]);
    expect(records.slice(-2).map((r) => ("id" in r ? r.id : undefined))).toEqual(["d-2", "d-3"]);
  });

  it("工具执行中 abort：未结束的工具以出错结束", async () => {
    const platform = createMockPlatform({ batchSize: 1 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "t-1", type: "prompt", message: "读" });
    while (!records.some((r) => r.type === "tool_execution_start"))
      await vi.advanceTimersByTimeAsync(16);
    await platform.coreSend(sessionKey, { id: "t-2", type: "abort" });
    await vi.runAllTimersAsync();
    const start = records.find((r) => r.type === "tool_execution_start") as Extract<
      CoreRecord,
      { type: "tool_execution_start" }
    >;
    const end = records.find((r) => r.type === "tool_execution_end");
    expect(end).toMatchObject({ toolCallId: start.toolCallId, isError: true });
    expect(records.at(-2)).toEqual({ type: "agent_settled", aborted: true });
  });

  it("get_messages 返回已发生的消息；未实现的命令返回失败响应", async () => {
    const platform = createMockPlatform({ batchSize: 100 });
    const records: CoreRecord[] = [];
    const { sessionKey } = await platform.sessionOpen("ws", undefined, (b) =>
      records.push(...b.records),
    );
    await platform.coreSend(sessionKey, { id: "m-1", type: "prompt", message: "hi" });
    await vi.runAllTimersAsync();
    await platform.coreSend(sessionKey, { id: "m-2", type: "get_messages" });
    await platform.coreSend(sessionKey, { id: "m-3", type: "export_html" });
    await vi.runAllTimersAsync();

    const got = records.find((r) => "id" in r && r.id === "m-2") as {
      data: { messages: Array<{ role: string }> };
    };
    expect(got.data.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(records.find((r) => "id" in r && r.id === "m-3")).toMatchObject({ success: false });
  });

  it("关闭会话后不再推送，也不能再发送", async () => {
    const platform = createMockPlatform();
    const onBatch = vi.fn();
    const { sessionKey } = await platform.sessionOpen("ws", undefined, onBatch);
    await platform.coreSend(sessionKey, { id: "c-1", type: "prompt", message: "x" });
    await platform.sessionClose(sessionKey);
    await vi.runAllTimersAsync();
    expect(onBatch).not.toHaveBeenCalled();
    await expect(platform.coreSend(sessionKey, { id: "c-2", type: "get_state" })).rejects.toThrow();
  });
});

describe("mock 会话索引", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("首条消息定稿后入索引并通知；可按工作区列出、搜索、归档、删除，历史会话能恢复消息", async () => {
    let t = 1000;
    const platform = createMockPlatform({ batchSize: 50, now: () => t });
    const changes = vi.fn();
    await platform.sessionWatch(changes);
    expect((await platform.sessionList(null)).items).toEqual([]);

    const opened = await platform.sessionOpen("ws", undefined, () => {});
    expect(opened.sessionId).toBe(opened.sessionKey);
    await platform.coreSend(opened.sessionKey, { id: "1", type: "prompt", message: "数据库迁移" });
    await vi.runAllTimersAsync();
    expect(changes).toHaveBeenCalled();

    const [entry] = (await platform.sessionList(null)).items;
    expect(entry).toMatchObject({ id: opened.sessionId, title: "数据库迁移", workspace: "ws" });
    if (!entry) throw new Error("缺少索引条目");
    expect((await platform.sessionList("other")).items).toEqual([]);
    // 回答正文也能搜到
    expect(await platform.sessionSearch(null, "mock 平台")).toHaveLength(1);
    expect(await platform.sessionSearch(null, "   ")).toEqual([]);

    await platform.sessionClose(opened.sessionKey);

    // 恢复历史会话：get_messages 返回已定稿的消息
    const records: unknown[] = [];
    const resumed = await platform.sessionOpen("ws", entry.path, (b) => records.push(...b.records));
    expect(resumed.sessionId).toBeNull();
    await platform.coreSend(resumed.sessionKey, { id: "g", type: "get_messages" });
    await vi.runAllTimersAsync();
    const res = records.find((r) => (r as { id?: string }).id === "g") as {
      data: { messages: unknown[] };
    };
    expect(res.data.messages.length).toBeGreaterThan(1);
    await platform.sessionClose(resumed.sessionKey);

    t = 2000;
    await platform.sessionArchive(entry.path, true);
    expect((await platform.sessionList(null)).items).toEqual([]);
    expect((await platform.sessionSearch(null, "迁移"))[0]?.archived).toBe(true);
    await platform.sessionArchive(entry.path, false);
    await platform.sessionDelete(entry.path);
    expect((await platform.sessionList(null)).items).toEqual([]);
    await expect(platform.sessionDelete(entry.path)).rejects.toThrow();
    await expect(platform.sessionArchive(entry.path, true)).rejects.toThrow();
  });

  it("键集分页：读完第一页后归档其中一条，第二页不漏项也不重复", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    for (let i = 0; i < 55; i++) {
      const { sessionKey } = await platform.sessionOpen("ws", undefined, () => {});
      await platform.coreSend(sessionKey, { id: `p${i}`, type: "prompt", message: `第${i}个` });
    }
    await vi.runAllTimersAsync();
    const order: string[] = [];
    for (let page = await platform.sessionList(null); ; ) {
      order.push(...page.items.map((x) => x.path));
      if (!page.nextCursor) break;
      page = await platform.sessionList(null, page.nextCursor);
    }
    expect(order).toHaveLength(55);

    const first = await platform.sessionList(null);
    expect(first.items).toHaveLength(50);
    const archivedPath = first.items[0]?.path ?? "";
    await platform.sessionArchive(archivedPath, true);
    const second = await platform.sessionList(null, first.nextCursor);
    const firstPaths = first.items.map((x) => x.path);
    const secondPaths = second.items.map((x) => x.path);
    expect(secondPaths.filter((p) => firstPaths.includes(p))).toEqual([]);
    expect(secondPaths).toEqual(order.slice(50));
    expect(second.nextCursor).toBeUndefined();
    // 无法解析的游标按第一页处理
    expect((await platform.sessionList(null, "garbage")).items[0]?.path).toBe(order[1]);
  });

  it("短查询只匹配会话名与首条用户消息，3 个字符以上匹配全文", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    const { sessionKey } = await platform.sessionOpen("ws", undefined, () => {});
    await platform.coreSend(sessionKey, { id: "p1", type: "prompt", message: "你好" });
    await vi.runAllTimersAsync();
    expect((await platform.sessionList(null)).items).toHaveLength(1);
    // 助手回复“我先查看一下工作区的文件。”中的词：两个字只匹配会话名与首条消息（不命中），3 个字以上匹配全文
    expect(await platform.sessionSearch(null, "查看")).toEqual([]);
    expect(await platform.sessionSearch(null, "查看一下")).toHaveLength(1);
    // 标题中的短查询仍匹配
    expect(await platform.sessionSearch(null, "你好")).toHaveLength(1);
  });

  it("关闭时尚未推送的用户消息计入历史与索引，助手消息丢弃", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    const { sessionKey } = await platform.sessionOpen("ws", undefined, () => {});
    await platform.coreSend(sessionKey, { id: "p1", type: "prompt", message: "关闭前的问题" });
    // 还没有推送任何批次就关闭
    await platform.sessionClose(sessionKey);
    const [entry] = (await platform.sessionList(null)).items;
    expect(entry?.title).toBe("关闭前的问题");
    expect(entry?.messageCount).toBe(1);
    const got: unknown[] = [];
    const resumed = await platform.sessionOpen("ws", entry?.path, (b) => got.push(...b.records));
    await platform.coreSend(resumed.sessionKey, { id: "g", type: "get_messages" });
    await vi.runAllTimersAsync();
    const res = got.find((r) => (r as { id?: string }).id === "g") as {
      data: { messages: { role: string }[] };
    };
    expect(res.data.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("列表按 50 条分页", async () => {
    const platform = createMockPlatform({ batchSize: 50 });
    for (let i = 0; i < 55; i++) {
      const { sessionKey } = await platform.sessionOpen("ws", undefined, () => {});
      await platform.coreSend(sessionKey, { id: `p${i}`, type: "prompt", message: `第${i}个` });
    }
    await vi.runAllTimersAsync();
    const first = await platform.sessionList(null);
    expect(first.items).toHaveLength(50);
    const second = await platform.sessionList(null, first.nextCursor);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("假事件流脚本", () => {
  it("按码点切分，不拆开代理对", () => {
    expect(chunk("ab😀cd", 3)).toEqual(["ab😀", "cd"]);
  });

  it("每个 *_delta 之前有 *_start、之后有携带完整内容的 *_end", () => {
    const { records } = promptScenario("测试", 0);
    const updates = records
      .filter((r) => r.type === "message_update")
      .map((r) => (r as { assistantMessageEvent: { type: string } }).assistantMessageEvent.type);
    expect(updates[0]).toBe("thinking_start");
    expect(updates).toContain("toolcall_end");
    expect(updates.at(-1)).toBe("text_end");
  });

  it("#排版：最终回答换成覆盖标题、粗体、行内代码、列表、表格与代码块的 Markdown 示例", () => {
    const answerOf = (prompt: string) => {
      const { messages } = promptScenario(prompt, 0);
      const last = messages.at(-1) as { content: { type: string; text?: string }[] };
      return last.content[0]?.text ?? "";
    };
    const sample = answerOf(`看看 ${TYPOGRAPHY_TAG}`);
    for (const piece of ["## ", "### ", "**", "`", "- ", "| ", "```"])
      expect(sample).toContain(piece);
    expect(answerOf("你好")).toContain("你刚才说");
  });

  it("#引用：最终回答换成文件引用与网页链接混排的示例", () => {
    const { messages } = promptScenario(`看看 ${REFERENCES_TAG}`, 0);
    const last = messages.at(-1) as { content: { type: string; text?: string }[] };
    const sample = last.content[0]?.text ?? "";
    for (const piece of ["#L42-L58", ".tsx:120", "C:\\Program Files", "https://", "`console.log`"])
      expect(sample).toContain(piece);
    // 多种文件类型，用来检查彩色文件类型图标
    for (const piece of [
      "main.rs`",
      ".py`",
      ".docx`",
      ".xlsx`",
      ".pptx`",
      ".zip`",
      ".mp4`",
      "`src/`",
    ])
      expect(sample).toContain(piece);
  });
});

describe("mock 平台：输入框附件、分支与语音", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("图片附件返回占位缩略图，非图片与损坏文件拒绝", async () => {
    const p = createMockPlatform({ attachmentDelayMs: 10 });
    const ok = p.attachmentImage("C:\\x\\设计稿.png", 2048);
    await vi.advanceTimersByTimeAsync(10);
    await expect(ok).resolves.toMatchObject({ mimeType: "image/png" });
    expect((await ok).thumb.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const bad = p.attachmentImage("C:\\x\\README.md", 2048).catch((e: Error) => e.message);
    const broken = p.attachmentImage("C:\\x\\broken.png", 2048).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(await bad).toBe("不是支持的图片格式");
    expect(await broken).toContain("图片无法解码");
  });

  it("示例工作区在 main 分支，其他文件夹不是仓库", async () => {
    const p = createMockPlatform();
    await expect(p.gitBranch("C:\\Users\\mock\\示例工作区")).resolves.toEqual({
      name: "main",
      detached: false,
    });
    await expect(p.gitBranch("C:\\Users\\mock\\新项目")).resolves.toBeNull();
  });

  it("模拟听写：推送音量与逐字临时结果，句末定稿；停止后推送 end", async () => {
    const p = createMockPlatform({ speechStepMs: 5 });
    await expect(p.speechAvailable()).resolves.toBe(true);
    const events: { type: string; text?: string }[] = [];
    await p.speechStart((e) => events.push(e));
    await vi.advanceTimersByTimeAsync(5 * 2 * 20);
    expect(events.some((e) => e.type === "level")).toBe(true);
    const interims = events.filter((e) => e.type === "interim").map((e) => e.text ?? "");
    expect(interims[0]).toBe("帮");
    expect(interims[1]).toBe("帮我");
    const final = events.find((e) => e.type === "final");
    expect(final?.text).toBe("帮我看下这张截图里的布局问题，");
    await p.speechStop();
    expect(events.at(-1)).toEqual({ type: "end" });
    const count = events.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toHaveLength(count);
  });
});

describe("mock 打开文件", () => {
  it("绝对路径打开、可执行文件改为在文件夹中显示、相对路径与网址拒绝", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const p = createMockPlatform();
    await expect(p.openPath("C:\\work\\a.ts")).resolves.toBe("opened");
    await expect(p.openPath("/home/me/run.sh")).resolves.toBe("revealed");
    await expect(p.openPath("/home/me/tool.rb")).resolves.toBe("revealed");
    await expect(p.openPath("C:\\work\\.exe")).resolves.toBe("revealed");
    await expect(p.openPath("src/a.ts")).rejects.toThrow("完整路径");
    await expect(p.openPath("https://example.com")).rejects.toThrow("网址");
    await expect(p.openPath("\\\\srv\\share\\a.ts")).rejects.toThrow("网络路径");
    await expect(p.openPath("/home/me/a\nb.ts")).rejects.toThrow("路径格式不正确");
    await expect(p.revealPath(`/${"a".repeat(4096)}`)).rejects.toThrow("路径格式不正确");
    await expect(p.revealPath("C:\\work\u0007.ts")).rejects.toThrow("路径格式不正确");
    await expect(p.revealPath("~/a.ts")).resolves.toBeUndefined();
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });
});
