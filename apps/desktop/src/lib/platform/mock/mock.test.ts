import type { CoreBatch, CoreRecord } from "@primus/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, PlatformError, SESSION_OPEN } from "../types";
import { createMockPlatform } from "./index";
import { chunk, promptScenario } from "./scenario";

const types = (records: CoreRecord[]) => records.map((r) => r.type);

describe("mock 平台", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("实现了附录 B 的全部命令", () => {
    const platform = createMockPlatform();
    expect(Object.keys(platform).sort()).toEqual(Object.keys(COMMANDS).sort());
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

    // 打开中不能删除
    await expect(platform.sessionDelete(entry.path)).rejects.toSatisfy(
      (e) => e instanceof PlatformError && e.code === SESSION_OPEN,
    );
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
});
