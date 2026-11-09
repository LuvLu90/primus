import type { AgentMessage, CoreRecord } from "@primus/protocol";
import { describe, expect, it, vi } from "vitest";
import { promptScenario, usage } from "@/lib/platform/mock/scenario";
import {
  applyChunks,
  dismissUiRequest,
  initialSessionState,
  type RecordChunk,
} from "./session-store";

const chunk = (records: CoreRecord[], gap = false): RecordChunk => ({ records, gap });
const u = usage(1, 1);
/** 测试只关心部分字段的消息 */
const msg = (m: Record<string, unknown>) => m as unknown as AgentMessage;
const update = (assistantMessageEvent: unknown): CoreRecord =>
  ({ type: "message_update", usage: u, assistantMessageEvent }) as CoreRecord;

describe("会话 store：流式消息重建（第 7.4 节）", () => {
  it("增量按 contentIndex 追加，*_end 用完整内容替换", () => {
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        update({ type: "text_start", contentIndex: 0 }),
        update({ type: "text_delta", contentIndex: 0, delta: "你" }),
        update({ type: "text_delta", contentIndex: 0, delta: "好" }),
      ]),
    ]);
    expect(s.running).toBe(true);
    expect(s.streamingMessage).toBe(true);
    expect(s.messages[0]).toMatchObject({ content: [{ type: "text", text: "你好" }] });

    const s2 = applyChunks(s, [
      chunk([update({ type: "text_end", contentIndex: 0, content: "你好！" })]),
    ]);
    expect(s2.messages[0]).toMatchObject({ content: [{ type: "text", text: "你好！" }] });
    // 不可变更新：旧状态不受影响
    expect(s.messages[0]).toMatchObject({ content: [{ type: "text", text: "你好" }] });
  });

  it("message_end 整条替换为最终版本；agent_settled 才解锁", () => {
    const final = msg({
      role: "assistant",
      content: [{ type: "text", text: "最终" }],
      stopReason: "stop",
    });
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        update({ type: "text_delta", contentIndex: 0, delta: "草稿" }),
        { type: "message_end", message: final },
        { type: "agent_end", messages: [], willRetry: false },
      ]),
    ]);
    expect(s.messages).toEqual([final]);
    expect(s.streamingMessage).toBe(false);
    expect(s.running).toBe(true); // agent_end 之后仍可能重试或压缩
    expect(applyChunks(s, [chunk([{ type: "agent_settled", aborted: false }])]).running).toBe(
      false,
    );
  });

  it("完整的 mock 事件流重建出与 get_messages 一致的消息", () => {
    const { records, messages } = promptScenario("你好", 0);
    const batches: RecordChunk[] = [];
    for (let i = 0; i < records.length; i += 7) batches.push(chunk(records.slice(i, i + 7)));
    const s = applyChunks(initialSessionState, batches);
    expect(s.messages).toEqual(messages);
    expect(s.running).toBe(false);
    expect(Object.values(s.toolRuns)).toMatchObject([{ toolName: "read", status: "done" }]);
  });

  it("工具调用参数流式期间累积原始文本，结束时替换为完整调用", () => {
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "read" }),
        update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' }),
      ]),
    ]);
    expect(s.messages[0]).toMatchObject({
      content: [{ type: "toolCall", argsText: '{"path":', arguments: {} }],
    });
    // 参数 JSON 完整后即解析出来供界面显示
    const partial = applyChunks(s, [
      chunk([update({ type: "toolcall_delta", contentIndex: 0, delta: '"a"}' })]),
    ]);
    expect(partial.messages[0]).toMatchObject({
      content: [{ type: "toolCall", argsText: '{"path":"a"}', arguments: { path: "a" } }],
    });
    const call = { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } };
    const s2 = applyChunks(s, [
      chunk([update({ type: "toolcall_end", contentIndex: 0, toolCall: call })]),
    ]);
    expect(s2.messages[0]).toMatchObject({ content: [call] });
  });

  it("工具调用参数只接受 JSON 对象：完整的数组、未闭合的对象都不写入 arguments", () => {
    const start = chunk([
      { type: "message_start", message: msg({ role: "assistant", content: [] }) },
      update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "read" }),
    ]);
    const array = applyChunks(initialSessionState, [
      start,
      chunk([update({ type: "toolcall_delta", contentIndex: 0, delta: "[]" })]),
    ]);
    expect(array.messages[0]).toMatchObject({
      content: [{ type: "toolCall", argsText: "[]", arguments: {} }],
    });
    // 解析过一次的对象在后续不完整的增量期间保留
    const kept = applyChunks(initialSessionState, [
      start,
      chunk([
        update({ type: "toolcall_delta", contentIndex: 0, delta: '{"a":{"b":1}' }),
        update({ type: "toolcall_delta", contentIndex: 0, delta: "}" }),
        update({ type: "toolcall_delta", contentIndex: 0, delta: " " }),
      ]),
    ]);
    expect(kept.messages[0]).toMatchObject({
      content: [{ type: "toolCall", arguments: { a: { b: 1 } } }],
    });
  });

  it("缺口标记重建；get_messages 覆盖历史并结束流式，get_state 校正运行状态", () => {
    const s1 = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
      ]),
    ]);
    // 丢了一段：其中有 message_end 与 agent_settled
    const gap = applyChunks(s1, [chunk([], true)]);
    expect(gap.needsResync).toBe(true);

    const history: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 1 }];
    const fixed = applyChunks(gap, [
      chunk([
        {
          type: "response",
          id: "s-9",
          command: "get_messages",
          success: true,
          data: { messages: history },
        },
        // 流式中的旧消息已不在历史里：增量在下一个 message_start 前忽略
        update({ type: "text_delta", contentIndex: 0, delta: "迟到" }),
        {
          type: "response",
          id: "s-10",
          command: "get_state",
          success: true,
          data: {
            thinkingLevel: "off",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionId: "x",
            autoCompactionEnabled: true,
            messageCount: 1,
            pendingMessageCount: 0,
          },
        },
      ]),
    ]);
    expect(fixed.needsResync).toBe(false);
    expect(fixed.messages).toEqual(history);
    expect(fixed.streamingMessage).toBe(false);
    expect(fixed.running).toBe(false);
  });

  it("失败响应记入 lastError，新一轮开始时清除", () => {
    const s = applyChunks(initialSessionState, [
      chunk([{ type: "response", id: "x", command: "prompt", success: false, error: "忙" }]),
    ]);
    expect(s.lastError).toBe("忙");
    expect(applyChunks(s, [chunk([{ type: "agent_start" }])]).lastError).toBeUndefined();
  });

  it("增量只追加到已 start、未 end 的同类型块；越界索引忽略", () => {
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        // 没有 start 的增量：不凭空建块
        update({ type: "text_delta", contentIndex: 0, delta: "孤儿" }),
        update({ type: "text_start", contentIndex: 0 }),
        update({ type: "text_delta", contentIndex: 0, delta: "甲" }),
        // 类型不符、索引越界（会留下空洞）的增量都忽略
        update({ type: "thinking_delta", contentIndex: 0, delta: "错" }),
        update({ type: "text_start", contentIndex: 5 }),
        update({ type: "text_end", contentIndex: 0, content: "甲乙" }),
        // 定稿之后的增量不再改动该块
        update({ type: "text_delta", contentIndex: 0, delta: "迟到" }),
      ]),
    ]);
    expect(s.messages[0]).toMatchObject({ content: [{ type: "text", text: "甲乙" }] });
    expect((s.messages[0] as { content: unknown[] }).content).toHaveLength(1);
    expect(s.liveBlocks).toEqual([]);
  });

  it("message_update 携带的用量写到流式消息上；message_start 不改动记录本身", () => {
    const started = msg({ role: "assistant", content: [] });
    const usageUpdate = {
      type: "message_update",
      usage: usage(5, 7),
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    } as CoreRecord;
    // 每条 message_update 的用量都写上：先看第一条之后的中间状态
    const interim = applyChunks(initialSessionState, [
      chunk([{ type: "message_start", message: started }, usageUpdate]),
    ]);
    expect(interim.messages[0]).toMatchObject({ usage: usage(5, 7) });
    const s = applyChunks(interim, [
      chunk([update({ type: "text_delta", contentIndex: 0, delta: "字" })]),
    ]);
    expect(s.messages[0]).toMatchObject({ usage: u, content: [{ type: "text", text: "字" }] });
    expect(started).toEqual({ role: "assistant", content: [] });
  });

  it("流式途中出现缺口：之后这条消息的增量全部忽略，等 message_end 整条替换", () => {
    const s1 = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        update({ type: "text_start", contentIndex: 0 }),
        update({ type: "text_delta", contentIndex: 0, delta: "前" }),
      ]),
    ]);
    // 丢掉的记录里可能有这条消息的 message_end 和下一条的 message_start：之后的增量不能确定属于哪条消息
    const s2 = applyChunks(s1, [
      chunk(
        [
          update({ type: "text_delta", contentIndex: 0, delta: "后" }),
          update({ type: "text_start", contentIndex: 1 }),
          update({ type: "text_end", contentIndex: 0, content: "别的消息" }),
        ],
        true,
      ),
    ]);
    expect(s2.needsResync).toBe(true);
    expect(s2.streamBroken).toBe(true);
    expect(s2.messages).toEqual(s1.messages);

    const final = msg({ role: "assistant", content: [{ type: "text", text: "完整" }] });
    const s3 = applyChunks(s2, [chunk([{ type: "message_end", message: final }])]);
    expect(s3.messages).toEqual([final]);
    expect(s3.streamBroken).toBe(false);
    expect(s3.streamingMessage).toBe(false);

    // 下一条消息重新开始正常流式重建
    const s4 = applyChunks(s3, [
      chunk([
        { type: "message_start", message: msg({ role: "assistant", content: [] }) },
        update({ type: "text_start", contentIndex: 0 }),
        update({ type: "text_delta", contentIndex: 0, delta: "新" }),
      ]),
    ]);
    expect(s4.messages[1]).toMatchObject({ content: [{ type: "text", text: "新" }] });
  });

  it("扩展对话框进入待回答列表（去重），即发即弃的方法忽略；回答或一轮结束后移除", () => {
    const ask = {
      type: "extension_ui_request",
      id: "a1",
      method: "select",
      title: "运行命令：ls",
      options: ["允许", "拒绝"],
    } as CoreRecord;
    const widget = {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "primus:mode",
      widgetLines: ["{}"],
    } as CoreRecord;
    const s1 = applyChunks(initialSessionState, [{ records: [ask, ask, widget], gap: false }]);
    expect(s1.uiRequests.map((r) => r.id)).toEqual(["a1"]);
    expect(dismissUiRequest(s1, "a1").uiRequests).toEqual([]);
    const s2 = applyChunks(s1, [
      { records: [{ type: "agent_settled" } as CoreRecord], gap: false },
    ]);
    expect(s2.uiRequests).toEqual([]);
  });

  it("记录当前模型、思考强度与可选档位", () => {
    const model = { provider: "p", id: "m", name: "M" };
    const s = applyChunks(initialSessionState, [
      {
        records: [
          {
            type: "response",
            id: "1",
            command: "get_state",
            success: true,
            data: { model, thinkingLevel: "high", isStreaming: false, isCompacting: false },
          } as CoreRecord,
          {
            type: "response",
            id: "2",
            command: "get_available_thinking_levels",
            success: true,
            data: { levels: ["off", "high"] },
          } as CoreRecord,
          {
            type: "response",
            id: "3",
            command: "set_model",
            success: true,
            data: { ...model, id: "m2" },
          } as CoreRecord,
        ],
        gap: false,
      },
    ]);
    expect(s.model).toEqual({ provider: "p", id: "m2" });
    expect(s.thinkingLevel).toBe("high");
    // 换模型后旧模型的档位作废，等新的 get_available_thinking_levels
    expect(s.thinkingLevels).toBeUndefined();
  });

  it("记录 Core 认得的模型能力：get_available_models 整体替换，get_state / set_model 补充；失败不提示", () => {
    const core = (id: string, input: string[], reasoning: boolean, contextWindow: number) => ({
      provider: "gw",
      id,
      name: id,
      input,
      reasoning,
      contextWindow,
      maxTokens: 32_000,
    });
    const response = (command: string, data: unknown, success = true) =>
      ({ type: "response", id: command, command, success, data }) as CoreRecord;
    const s1 = applyChunks(initialSessionState, [
      chunk([
        response("get_available_models", {
          models: [
            core("moonshotai/kimi-k3.1-pro", ["text", "image"], true, 1_048_576),
            core("old", ["text"], false, 128_000),
          ],
        }),
      ]),
    ]);
    expect(s1.modelCaps).toEqual({
      "gw/moonshotai/kimi-k3.1-pro": {
        image: true,
        reasoning: true,
        contextWindow: 1_048_576,
        maxTokens: 32_000,
      },
      "gw/old": { image: false, reasoning: false, contextWindow: 128_000, maxTokens: 32_000 },
    });
    const s2 = applyChunks(s1, [
      chunk([
        response("set_model", core("new", ["text", "image"], true, 200_000)),
        response("get_available_models", undefined, false),
      ]),
    ]);
    expect(s2.modelCaps?.["gw/new"]).toMatchObject({ image: true, contextWindow: 200_000 });
    expect(s2.modelCaps?.["gw/old"]).toBeDefined();
    expect(s2.lastError).toBeUndefined();
    const s3 = applyChunks(s2, [
      chunk([response("get_available_models", { models: [core("only", ["text"], true, 1)] })]),
    ]);
    expect(Object.keys(s3.modelCaps ?? {})).toEqual(["gw/only"]);
  });

  it("primus:context-stats 按会话保存；未知版本忽略并记日志；空内容清除", () => {
    const widget = (lines: string[] | undefined, id = "w") =>
      ({
        type: "extension_ui_request",
        id,
        method: "setWidget",
        widgetKey: "primus:context-stats",
        widgetLines: lines,
      }) as CoreRecord;
    const data = {
      groups: [{ key: "skills", items: ["pdf"] }],
      usedTools: [{ name: "read", count: 2 }],
    };
    const s1 = applyChunks(initialSessionState, [
      chunk([widget([JSON.stringify({ v: 1, type: "context-stats", data })])]),
    ]);
    expect(s1.contextStats).toEqual(data);
    expect(s1.uiRequests).toEqual([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s2 = applyChunks(s1, [
      chunk([widget([JSON.stringify({ v: 2, type: "context-stats", data: {} })])]),
    ]);
    expect(s2.contextStats).toEqual(data);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(applyChunks(s1, [chunk([widget(undefined)])]).contextStats).toBeUndefined();
    // 缺 usedTools：按空列表处理；只保留认识的字段
    const partial = { groups: data.groups, extra: 1 };
    const s3 = applyChunks(initialSessionState, [
      chunk([widget([JSON.stringify({ v: 1, type: "context-stats", data: partial })])]),
    ]);
    expect(s3.contextStats).toEqual({ groups: data.groups, usedTools: [] });
    // 旧版扩展的分项估算（categories，没有 groups）：忽略，不显示估算值
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = { estimator: "chars/4", categories: [{ key: "skills", tokens: 1, items: [] }] };
    const s4 = applyChunks(initialSessionState, [
      chunk([widget([JSON.stringify({ v: 1, type: "context-stats", data: legacy })])]),
    ]);
    expect(s4.contextStats).toBeUndefined();
    expect(warn2).toHaveBeenCalled();
    warn2.mockRestore();
  });
});

describe("会话 store：自动重试", () => {
  it("auto_retry_start 记下重试进度，auto_retry_end 清除并记下结果；新一轮开始时清除结果", () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const s1 = applyChunks(initialSessionState, [
        chunk([
          { type: "agent_start" },
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 2000,
            errorMessage: "Connection error.",
          },
        ]),
      ]);
      expect(s1.retry).toEqual({
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "Connection error.",
        at: 1_000,
      });
      // 重试途中 Core 继续运行（再次 agent_start）不清除进度
      const s2 = applyChunks(s1, [chunk([{ type: "agent_start" }])]);
      expect(s2.retry?.attempt).toBe(1);
      const s3 = applyChunks(s2, [
        chunk([
          { type: "auto_retry_end", success: false, attempt: 3, finalError: "Connection error." },
        ]),
      ]);
      expect(s3.retry).toBeUndefined();
      expect(s3.retryResult).toEqual({
        attempt: 3,
        success: false,
        finalError: "Connection error.",
      });
      const s4 = applyChunks(s3, [chunk([{ type: "agent_settled", aborted: false }])]);
      expect(s4.retryResult?.attempt).toBe(3);
      expect(applyChunks(s4, [chunk([{ type: "agent_start" }])]).retryResult).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("缺号重建时 get_state 显示会话已空闲：清除过期的重试进度；后台 get_commands 失败不提示", () => {
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "x" },
        {
          type: "response",
          id: "s-1",
          command: "get_state",
          success: true,
          data: {
            thinkingLevel: "off",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionId: "x",
            autoCompactionEnabled: true,
            messageCount: 1,
            pendingMessageCount: 0,
          },
        },
        { type: "response", id: "s-2", command: "get_commands", success: false, error: "boom" },
      ]),
    ]);
    expect(s.retry).toBeUndefined();
    expect(s.running).toBe(false);
    expect(s.lastError).toBeUndefined();
  });

  it("错过 auto_retry_end 时，一轮结束（agent_settled）也清除重试进度", () => {
    const s = applyChunks(initialSessionState, [
      chunk([
        { type: "agent_start" },
        { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "x" },
        { type: "agent_settled", aborted: true },
      ]),
    ]);
    expect(s.retry).toBeUndefined();
  });
});
