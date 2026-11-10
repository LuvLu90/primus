import type {
  AgentMessage,
  AssistantContent,
  AssistantMessageEvent,
  ContextStatsData,
  ContextUsage,
  CoreRecord,
  ExtensionUiDialogRequest,
  Model,
  RpcResponse,
  SessionStats,
  ToolResult,
} from "@primus/protocol";
import { CONTEXT_STATS_WIDGET, isDialogRequest } from "@primus/protocol";
import { produce } from "immer";
import { createStore } from "zustand/vanilla";

// 每会话 store（第 16.4 节）：按顺序合并 RPC 客户端交付的记录，按第 7.4 节重建流式消息。

/** 流式中的工具调用块：参数 JSON 尚未完整时先累积原始文本 */
export interface StreamingToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argsText?: string;
}

export type TimelineContent = AssistantContent | StreamingToolCall;

/** Core 实际请求时用的模型能力（Model 对象里界面用到的几项） */
export interface CoreModelCaps {
  image: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** 从 Core 的 Model 对象取能力 */
export function capsOf(model: Model): CoreModelCaps {
  return {
    image: Array.isArray(model.input) && model.input.includes("image"),
    reasoning: model.reasoning === true,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export interface ToolRun {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  result?: ToolResult;
}

export interface SessionState {
  /** RPC 客户端发现批次缺口，正在用 get_messages + get_state 重建；收到 get_messages 结果后清除 */
  needsResync: boolean;
  /** 时间线消息；最后一条可能仍在流式输出 */
  messages: AgentMessage[];
  /** 当前是否有消息在流式输出（message_start 到 message_end 之间），即 messages 的最后一条 */
  streamingMessage: boolean;
  /**
   * 正在流式输出、且自 *_start 起增量连续未断的内容块索引。增量只追加到这些块；
   * *_end 定稿后移出，之后的增量不再改动它。
   */
  liveBlocks: number[];
  /**
   * 流式输出途中发现缺口：期间可能丢了增量，甚至丢了 message_end 与下一条消息的 message_start。
   * 此后忽略这条消息的 message_update（不能确定它们属于哪条消息），等 message_end 整条替换或 get_messages 覆盖历史。
   */
  streamBroken: boolean;
  /** agent_start 到 agent_settled 之间为 true，期间锁定输入 */
  running: boolean;
  toolRuns: Record<string, ToolRun>;
  /** 最近一次失败的命令响应 */
  lastError?: string;
  /** 等待用户回答的扩展对话框（primus-guard 的操作确认等），按到达顺序 */
  uiRequests: ExtensionUiDialogRequest[];
  /** 当前的模型与思考强度（get_state、set_model 等响应） */
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  /** 当前模型支持的思考强度（get_available_thinking_levels） */
  thinkingLevels?: string[];
  /**
   * Core 认得的模型能力，键为 `provider/modelId`：get_available_models 整体替换，get_state / set_model 的模型对象补充。
   * 能否看图、是否支持思考、上下文长度以它为准（与 Core 实际请求用的是同一份），没有时才用设置里的值
   */
  modelCaps?: Record<string, CoreModelCaps>;
  /** 上下文占用（get_session_stats）；每条回复结束后刷新 */
  contextUsage?: ContextUsage;
  /** 本会话累计用量（get_session_stats 的 tokens 与 cost） */
  sessionUsage?: Pick<SessionStats, "tokens" | "cost">;
  /** 上下文里已加载的清单（primus-context-stats，只有名称、不含估算；经 setWidget("primus:context-stats") 推送；会话打开后请求一次，之后扩展每轮结束主动重推） */
  contextStats?: ContextStatsData;
  /** 自动压缩开关（get_state 的 autoCompactionEnabled；切换时乐观更新，set_auto_compaction 失败回滚）。Core 的全局持久设置 */
  autoCompaction?: boolean;
  /** 正在压缩（compaction_start 到 compaction_end） */
  compacting: boolean;
  /**
   * Core 正在自动重试失败的请求（auto_retry_start 到 auto_retry_end）。`at` 为收到事件的本地时间，
   * 界面据此倒计时 `delayMs`；可以用 abort_retry 停止
   */
  retry?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
    at: number;
  };
  /** 最近一次自动重试的结果（auto_retry_end）；下一轮开始时清除。最终失败时错误卡片注明重试了几次 */
  retryResult?: { attempt: number; success: boolean; finalError?: string };
}

export const initialSessionState: SessionState = {
  needsResync: false,
  messages: [],
  streamingMessage: false,
  liveBlocks: [],
  streamBroken: false,
  running: false,
  toolRuns: {},
  uiRequests: [],
  compacting: false,
};

/** 末尾（忽略空白）是不是 `}`：完整的 JSON 对象必然以它结尾 */
function endsWithBrace(text: string): boolean {
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") continue;
    return c === "}";
  }
  return false;
}

/**
 * 流式参数尽量解析成对象供界面显示；不完整的 JSON 保留上一次成功解析的结果。
 * 只在末尾是 `}` 时才尝试解析：参数被切成大量小片时，避免每片都重解析整段文本（总代价随长度平方增长）。
 */
function parseArgs(text: string): Record<string, unknown> | undefined {
  if (!endsWithBrace(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按第 7.4 节把一个增量事件作用到流式消息的内容块上：
 * *_start 新建空块并开始接收增量；*_delta 只追加到同类型、仍在接收增量的块；*_end 用完整内容替换并定稿。
 * start / done / error 不作用于内容块（正常运行中由 message_start / message_end 承担）。
 */
/** 流式工具参数超过这个长度后，每增长这么多字符才重新解析一次 */
const PARSE_STEP = 4096;

function applyUpdate(
  draft: SessionState,
  content: TimelineContent[],
  e: AssistantMessageEvent,
): void {
  if (!("contentIndex" in e)) return;
  const i = e.contentIndex;
  // 索引只能指向已有的块或紧接着的新块；越界说明流已错乱，忽略以免产生空洞
  if (!Number.isInteger(i) || i < 0 || i > content.length) return;
  const live = draft.liveBlocks.includes(i);
  const block = content[i];
  switch (e.type) {
    case "text_start":
      content[i] = { type: "text", text: "" };
      if (!live) draft.liveBlocks.push(i);
      return;
    case "thinking_start":
      content[i] = { type: "thinking", thinking: "" };
      if (!live) draft.liveBlocks.push(i);
      return;
    case "toolcall_start":
      content[i] = { type: "toolCall", id: e.id, name: e.toolName, arguments: {}, argsText: "" };
      if (!live) draft.liveBlocks.push(i);
      return;
    case "text_delta":
      if (live && block?.type === "text") block.text += e.delta;
      return;
    case "thinking_delta":
      if (live && block?.type === "thinking") block.thinking += e.delta;
      return;
    case "toolcall_delta":
      if (live && block?.type === "toolCall") {
        const call = block as StreamingToolCall;
        call.argsText = (call.argsText ?? "") + e.delta;
        // 参数很长时（写整份文件）每个增量都重解析一遍是 O(n²)，会拖慢界面：
        // 短参数逐次解析；长参数每增长 PARSE_STEP 字符解析一次（界面只用到路径、命令等开头的字段），toolcall_end 时定稿
        const len = call.argsText.length;
        if (
          len < PARSE_STEP ||
          Math.floor(len / PARSE_STEP) !== Math.floor((len - e.delta.length) / PARSE_STEP)
        ) {
          const args = parseArgs(call.argsText);
          if (args) call.arguments = args;
        }
      }
      return;
    // *_end 携带完整内容，替换累积结果；该块定稿
    case "text_end":
      content[i] = { type: "text", text: e.content };
      break;
    case "thinking_end":
      content[i] = { type: "thinking", thinking: e.content };
      break;
    case "toolcall_end":
      content[i] = e.toolCall;
      break;
  }
  draft.liveBlocks = draft.liveBlocks.filter((x) => x !== i);
}

/** 结束当前流式消息的状态（不改动消息本身） */
function endStream(draft: SessionState): void {
  draft.streamingMessage = false;
  draft.liveBlocks = [];
  draft.streamBroken = false;
}

/**
 * 解析扩展经 setWidget 推来的 `primus:<主题>` 数据：`{ v: 1, type, data }`。
 * 版本未知、主题不符或不是合法 JSON 时忽略并记日志（AGENTS.md 第 6 节）；返回 undefined
 */
export function parsePrimusData(
  key: string,
  lines: readonly string[] | undefined,
): { type: string; data: unknown } | undefined {
  const raw = lines?.[0];
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw) as { v?: unknown; type?: unknown; data?: unknown } | null;
    if (value === null || typeof value !== "object") throw new Error("不是对象");
    if (value.v !== 1) {
      console.warn(`忽略 ${key}：未知的数据版本 v=${String(value.v)}`);
      return undefined;
    }
    if (typeof value.type !== "string" || `primus:${value.type}` !== key) {
      console.warn(`忽略 ${key}：数据主题不符（${String(value.type)}）`);
      return undefined;
    }
    return { type: value.type, data: value.data };
  } catch (e) {
    console.warn(`忽略 ${key}：无法解析`, e);
    return undefined;
  }
}

/** 即发即弃的 setWidget：只处理前端认识的 `primus:*` 主题，其余忽略 */
function applyWidget(draft: SessionState, key: string, lines: string[] | undefined): void {
  if (key !== CONTEXT_STATS_WIDGET) return;
  // 缺省 widgetLines 表示清除
  if (lines === undefined) {
    draft.contextStats = undefined;
    return;
  }
  const parsed = parsePrimusData(key, lines);
  const data = parsed?.data as ContextStatsData | undefined;
  if (data && Array.isArray(data.groups))
    // usedTools 缺省按“没有调用过的工具”处理
    draft.contextStats = {
      groups: data.groups,
      usedTools: Array.isArray(data.usedTools) ? data.usedTools : [],
    };
  else if (parsed) console.warn(`忽略 ${key}：数据缺少 groups`);
}

/** 记下一个模型对象的能力（get_state / set_model） */
function setCaps(draft: SessionState, model: Model): void {
  draft.modelCaps = { ...draft.modelCaps, [`${model.provider}/${model.id}`]: capsOf(model) };
}

function applyRecord(draft: SessionState, record: CoreRecord): void {
  switch (record.type) {
    case "response": {
      const r: RpcResponse = record;
      if (!r.success) {
        // 上下文统计、模型能力与扩展命令查询是后台请求，失败不打扰用户（下一次再取）
        if (
          r.command === "get_session_stats" ||
          r.command === "get_available_models" ||
          r.command === "get_commands"
        )
          return;
        draft.lastError = r.error || `${r.command} 失败`;
        return;
      }
      // get_messages 的结果是权威历史：用于打开已有会话和缺号后的重建。
      // 它不含正在流式输出的消息，因此结束流式状态：之后的增量在下一个 message_start 前忽略，
      // 那条消息由它的 message_end 补上。
      if (r.command === "get_messages" && Array.isArray(r.data?.messages)) {
        draft.messages = r.data.messages;
        endStream(draft);
        draft.needsResync = false;
      }
      // get_state 校正运行状态（缺号时可能错过了 agent_start / agent_settled）
      if (r.command === "get_state" && r.data) {
        draft.running = r.data.isStreaming || r.data.isCompacting;
        const { model, thinkingLevel } = r.data;
        if (model) {
          draft.model = { provider: model.provider, id: model.id };
          setCaps(draft, model);
        }
        if (thinkingLevel) draft.thinkingLevel = thinkingLevel;
        draft.autoCompaction = r.data.autoCompactionEnabled;
        draft.compacting = r.data.isCompacting;
        // 会话已空闲：缺号时可能错过了 auto_retry_end，清掉过期的重试提示（否则会一直显示并盖住最终错误卡片）
        if (!draft.running) draft.retry = undefined;
      }
      if (r.command === "set_model" && r.data) {
        draft.model = { provider: r.data.provider, id: r.data.id };
        setCaps(draft, r.data);
        // 旧模型的档位不再适用：等 get_available_thinking_levels 给出新模型的
        draft.thinkingLevels = undefined;
      }
      if (r.command === "get_session_stats" && r.data) {
        draft.contextUsage = r.data.contextUsage;
        draft.sessionUsage = { tokens: r.data.tokens, cost: r.data.cost };
      }
      if (r.command === "get_available_thinking_levels" && Array.isArray(r.data?.levels))
        draft.thinkingLevels = r.data.levels;
      if (r.command === "get_available_models" && Array.isArray(r.data?.models)) {
        draft.modelCaps = Object.fromEntries(
          r.data.models.map((m) => [`${m.provider}/${m.id}`, capsOf(m)] as const),
        );
      }
      return;
    }
    case "extension_ui_request":
      // 对话框方法阻塞扩展、等前端回答；即发即弃的方法里只处理 primus:* 数据（setWidget），其余这里不处理
      if (record.method === "setWidget") {
        applyWidget(draft, record.widgetKey, record.widgetLines);
        return;
      }
      if (isDialogRequest(record) && !draft.uiRequests.some((x) => x.id === record.id))
        draft.uiRequests.push(record);
      return;
    case "agent_start":
      draft.running = true;
      draft.lastError = undefined;
      // 新一轮：上一轮的重试结果不再适用（重试中途 Core 继续运行时保留）
      if (!draft.retry) draft.retryResult = undefined;
      return;
    case "agent_settled":
      draft.running = false;
      // 自动重试一定在一轮结束前结束（auto_retry_end）；缺号时可能错过了它
      draft.retry = undefined;
      endStream(draft);
      // 一轮结束（含被停止）后，扩展不会再等这些对话框的回答
      draft.uiRequests = [];
      return;
    case "message_start": {
      // 复制一份再累积增量：不改动记录本身（记录可能被其他地方持有）
      draft.messages.push(structuredClone(record.message));
      draft.streamingMessage = true;
      draft.liveBlocks = [];
      draft.streamBroken = false;
      return;
    }
    case "message_update": {
      if (!draft.streamingMessage || draft.streamBroken) return;
      const last = draft.messages.at(-1);
      if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
      last.usage = record.usage;
      applyUpdate(draft, last.content as TimelineContent[], record.assistantMessageEvent);
      return;
    }
    case "message_end": {
      // message_end 是权威的最终版本，整条替换
      const { message } = record;
      if (draft.streamingMessage && draft.messages.length > 0)
        draft.messages[draft.messages.length - 1] = message;
      else draft.messages.push(message);
      endStream(draft);
      return;
    }
    case "tool_execution_start": {
      const r = record as { toolCallId: string; toolName: string };
      draft.toolRuns[r.toolCallId] = {
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        status: "running",
      };
      return;
    }
    case "tool_execution_update": {
      const r = record as { toolCallId: string; partialResult: ToolResult };
      const run = draft.toolRuns[r.toolCallId];
      if (run) run.result = r.partialResult;
      return;
    }
    case "tool_execution_end": {
      const r = record as { toolCallId: string; result: ToolResult; isError: boolean };
      const run = draft.toolRuns[r.toolCallId];
      if (run) {
        run.result = r.result;
        run.status = r.isError ? "error" : "done";
      }
      return;
    }
    case "auto_retry_start":
      draft.retry = {
        attempt: record.attempt,
        maxAttempts: record.maxAttempts,
        delayMs: record.delayMs,
        errorMessage: record.errorMessage,
        at: Date.now(),
      };
      draft.retryResult = undefined;
      return;
    case "auto_retry_end":
      draft.retry = undefined;
      draft.retryResult = {
        attempt: record.attempt,
        success: record.success,
        ...(record.finalError !== undefined ? { finalError: record.finalError } : {}),
      };
      return;
    case "compaction_start":
      draft.compacting = true;
      return;
    case "compaction_end":
      draft.compacting = false;
      return;
    case "thinking_level_changed":
      // Core 实际生效的强度（切换模型时夹取等），与 get_state 一致
      draft.thinkingLevel = record.level;
      return;
    default:
      // 其余事件（queue_update 等）由后续功能处理
      return;
  }
}

/** RPC 客户端交付的一段记录（一个批次去重后的内容） */
export interface RecordChunk {
  records: readonly CoreRecord[];
  /** 这段之前有记录丢失：标记重建，由 RPC 客户端发出 get_messages + get_state */
  gap: boolean;
}

/** 按顺序合并若干段记录（纯函数）。批次去重与缺口检测由 RPC 客户端负责（src/rpc） */
export function applyChunks(state: SessionState, chunks: readonly RecordChunk[]): SessionState {
  return produce(state, (draft) => {
    for (const chunk of chunks) {
      if (chunk.gap) {
        draft.needsResync = true;
        // 流式途中丢了记录：这条消息之后的增量不再可信（见 streamBroken）
        if (draft.streamingMessage) {
          draft.streamBroken = true;
          draft.liveBlocks = [];
        }
      }
      for (const record of chunk.records) applyRecord(draft, record);
    }
  });
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/** 用户回答（或关闭）了一个扩展对话框：从待回答列表中移除 */
export function dismissUiRequest(state: SessionState, id: string): SessionState {
  return { ...state, uiRequests: state.uiRequests.filter((x) => x.id !== id) };
}

/** 模型或思考强度切换成功后更新显示 */
export function withModel(
  state: SessionState,
  model: { provider: string; id: string } | undefined,
  thinkingLevel: string | undefined,
): SessionState {
  return {
    ...state,
    ...(model ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}

/** 为一个打开的会话创建独立 store；关闭会话时丢弃即可 */
export function createSessionStore() {
  return createStore<SessionState>()(() => initialSessionState);
}
