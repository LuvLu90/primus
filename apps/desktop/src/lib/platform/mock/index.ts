import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  CoreRecord,
  RpcCommand,
  RpcResponse,
} from "@primus/protocol";
import {
  AUTH_NOT_AVAILABLE,
  type AuthStatus,
  type BatchListener,
  type ModelSummary,
  type ModelsInfo,
  type Platform,
  PlatformError,
  type SessionSummary,
  type WorkspaceInfo,
} from "../types";
import { promptScenario } from "./scenario";

// 浏览器预览用的 mock 平台（第 16.1.1 节）：不依赖 Tauri 与 Rust，
// 会话命令由脚本化的假 Core 处理，事件按"每 16ms 一批"推送，与薄壳的合批节奏一致（第 16.4 节）。

export interface MockOptions {
  /** 批次间隔，默认 16ms */
  intervalMs?: number;
  /** 每批最多几条记录，默认 4 */
  batchSize?: number;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 模拟薄壳与前端之间丢失批次：返回 true 的批次照常占用序号但不推送（测试缺口重建） */
  dropBatch?: (seq: number, records: readonly CoreRecord[]) => boolean;
  /** 模拟内核卡死：返回 true 的命令不回 response（测试超时） */
  stallCommand?: (cmd: RpcCommand) => boolean;
}

/** 浏览器预览的内置账号与模型（与薄壳内置配置同形，模型只是示意，不连接任何端点） */
const MOCK_AUTH: AuthStatus = {
  loggedIn: true,
  account: { id: "builtin", name: "内置测试账号", kind: "builtin" },
  loginAvailable: false,
};

const MOCK_LARGE: ModelSummary = {
  key: "mock-messages/mock-large",
  provider: "mock-messages",
  id: "mock-large",
  name: "Mock 大模型",
  api: "anthropic-messages",
  reasoning: true,
  image: true,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

const MOCK_FAST: ModelSummary = {
  key: "mock-responses/mock-fast",
  provider: "mock-responses",
  id: "mock-fast",
  name: "Mock 快速模型",
  api: "openai-responses",
  reasoning: false,
  image: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const MOCK_MODELS: ModelSummary[] = [MOCK_LARGE, MOCK_FAST];

/** 队列项：记录本身，或推送时才生成的记录（get_messages 的响应在推送那一刻取历史快照） */
type Queued = CoreRecord | (() => CoreRecord);

interface MockSession {
  key: string;
  workspace: string;
  onBatch: BatchListener;
  seq: number;
  messages: AgentMessage[];
  queue: Queued[];
  timer: ReturnType<typeof setTimeout> | undefined;
  streaming: boolean;
  closed: boolean;
  /** 本轮已推送的事件（abort 时据此拼出被中止的消息） */
  delivered: CoreRecord[];
  /** 本轮已在中止中（结束事件已排队）：再次 abort 只排一条响应，不再丢弃队列 */
  aborting: boolean;
}

const MOCK_WORKSPACE = "C:\\Users\\mock\\示例工作区";

export function createMockPlatform(options: MockOptions = {}): Platform {
  const intervalMs = options.intervalMs ?? 16;
  const batchSize = options.batchSize ?? 4;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, MockSession>();
  const workspaces = new Map<string, WorkspaceInfo>([
    [MOCK_WORKSPACE, { path: MOCK_WORKSPACE, name: "示例工作区", trusted: true }],
  ]);
  const sessionIndex: SessionSummary[] = [];
  let defaultModel = MOCK_LARGE.key;
  const modelsInfo = (): ModelsInfo => ({
    version: 1,
    models: structuredClone(MOCK_MODELS),
    defaultModel,
    compactionModel: MOCK_FAST.key,
    titleModel: MOCK_FAST.key,
    error: null,
  });
  let settings: Record<string, unknown> = {};
  let nextSession = 1;
  let nextTerminal = 1;

  const session = (key: string): MockSession => {
    const s = sessions.get(key);
    if (!s || s.closed) throw new Error(`会话不存在或已关闭：${key}`);
    return s;
  };

  /** 推送一条记录时更新 mock 的会话状态 */
  const deliver = (s: MockSession, r: CoreRecord) => {
    if (r.type === "response") return;
    s.delivered.push(r);
    // 历史只记已定稿（已推送 message_end）的消息，与 Core 的 get_messages 一致
    if (r.type === "message_end") s.messages.push(r.message);
    if (r.type === "agent_settled") {
      s.streaming = false;
      s.aborting = false;
      s.delivered = [];
    }
  };

  const flush = (s: MockSession) => {
    s.timer = undefined;
    if (s.closed || s.queue.length === 0) return;
    const records = s.queue.splice(0, batchSize).map((item) => {
      // 按顺序推送：生成型记录在它之前的记录都已计入历史后才生成
      const r = typeof item === "function" ? item() : item;
      deliver(s, r);
      return r;
    });
    s.seq += 1;
    if (!options.dropBatch?.(s.seq, records))
      s.onBatch({ sessionKey: s.key, seq: s.seq, records, dropped: 0 });
    schedule(s);
  };

  const schedule = (s: MockSession) => {
    if (s.timer === undefined && s.queue.length > 0)
      s.timer = setTimeout(() => flush(s), intervalMs);
  };

  const emit = (s: MockSession, ...records: Queued[]) => {
    s.queue.push(...records);
    schedule(s);
  };

  const respond = (
    cmd: { id?: string; type: string },
    data?: unknown,
    error?: string,
  ): RpcResponse =>
    // mock 按命令动态拼装响应，data 的形状由调用处保证
    (error === undefined
      ? { type: "response", id: cmd.id, command: cmd.type, success: true, data }
      : { type: "response", id: cmd.id, command: cmd.type, success: false, error }) as RpcResponse;

  const handle = (s: MockSession, cmd: RpcCommand) => {
    if (options.stallCommand?.(cmd)) return;
    switch (cmd.type) {
      case "prompt": {
        if (s.streaming) {
          // 真实 Core 会按 streamingBehavior 排队；mock 只做最简单的拒绝
          emit(s, respond(cmd, undefined, "mock：正在运行中，请先停止或等待结束"));
          return;
        }
        const scenario = promptScenario(String(cmd.message ?? ""), now());
        s.streaming = true;
        emit(s, respond(cmd, { disposition: "started" }), ...scenario.records);
        return;
      }
      case "abort": {
        // 与 Core 一致：丢弃尚未推送的事件，结束被中止的消息与工具，会话空闲（agent_settled）后才回 response。
        // 运行开始与用户消息在 Core 受理 prompt 时就已发生，保留它们（用户消息因此留在历史里）
        // 已在中止中（结束事件已排队）时只排响应：不丢弃上一次 abort 的结束事件，响应仍在 agent_settled 之后
        if (s.streaming && !s.aborting) {
          s.aborting = true;
          s.queue = keptOnAbort(s.queue);
          emit(s, ...abortRecords(s.delivered, now()));
        }
        emit(s, respond(cmd));
        return;
      }
      case "get_state":
        emit(
          s,
          // 推送时才生成：反映此前推送的 agent_settled 等事件之后的运行状态
          () =>
            respond(cmd, {
              model: { provider: "mock", id: "mock-model", name: "Mock 模型" },
              thinkingLevel: "medium",
              isStreaming: s.streaming,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              sessionId: s.key,
              autoCompactionEnabled: true,
              messageCount: s.messages.length,
              pendingMessageCount: 0,
            }),
        );
        return;
      case "get_messages":
        // 推送时才取快照：此前推送的事件都已计入历史；排在它前面、被 abort 丢弃的事件不会进入快照
        emit(s, () => respond(cmd, { messages: s.messages.slice() }));
        return;
      default:
        emit(s, respond(cmd, undefined, `mock：未实现命令 ${cmd.type}`));
    }
  };

  const notAvailable = async (what: string): Promise<never> => {
    throw new Error(`浏览器预览模式不支持：${what}`);
  };

  return {
    appInfo: async () => ({
      appVersion: "0.0.0-mock",
      coreVersion: "mock",
      dataDir: "C:\\Users\\mock\\AppData\\Roaming\\Primus",
      platform: "browser",
      runtime: "mock",
    }),

    workspaceOpen: async (path) => {
      const ws = workspaces.get(path) ?? {
        path,
        name: path.split(/[\\/]/).pop() || path,
        trusted: false,
      };
      workspaces.set(path, ws);
      return ws;
    },
    workspaceList: async () => [...workspaces.values()],
    dialogPickFolder: async () => "C:\\Users\\mock\\新项目",
    dialogPickFiles: async () => [
      `${MOCK_WORKSPACE}\\README.md`,
      `${MOCK_WORKSPACE}\\src\\main.ts`,
    ],
    workspaceTrust: async (path, trusted) => {
      const ws = workspaces.get(path);
      if (ws) ws.trusted = trusted;
    },

    sessionList: async (workspace) => ({
      items: sessionIndex.filter((x) => x.workspace === workspace),
    }),
    sessionSearch: async (workspace, query) =>
      sessionIndex.filter((x) => x.workspace === workspace && (x.name ?? "").includes(query)),
    sessionOpen: async (workspace, sessionPath, onBatch) => {
      const key = `mock-${nextSession++}`;
      sessions.set(key, {
        key,
        workspace,
        onBatch,
        seq: 0,
        messages: [],
        queue: [],
        timer: undefined,
        streaming: false,
        closed: false,
        delivered: [],
        aborting: false,
      });
      if (!sessionPath)
        sessionIndex.push({ path: `${key}.jsonl`, workspace, updatedAt: now(), name: "新会话" });
      return { sessionKey: key };
    },
    sessionClose: async (sessionKey) => {
      const s = sessions.get(sessionKey);
      if (!s) return;
      s.closed = true;
      if (s.timer !== undefined) clearTimeout(s.timer);
      sessions.delete(sessionKey);
    },
    sessionDelete: async (path) => {
      const i = sessionIndex.findIndex((x) => x.path === path);
      if (i >= 0) sessionIndex.splice(i, 1);
    },
    sessionArchive: async () => {},

    coreSend: async (sessionKey, record) => {
      const s = session(sessionKey);
      handle(s, record as RpcCommand);
    },
    coreRestart: async (sessionKey) => {
      const s = session(sessionKey);
      s.queue = [];
      s.streaming = false;
      s.aborting = false;
      s.delivered = [];
    },

    settingsGet: async () => ({ ...settings }),
    settingsSet: async (patch) => {
      settings = { ...settings, ...patch };
    },

    authStatus: async () => structuredClone(MOCK_AUTH),
    authLogin: async () => {
      throw new PlatformError("账号登录暂未开放，当前使用内置测试账号", AUTH_NOT_AVAILABLE);
    },
    authLogout: async () => {
      throw new PlatformError("账号登出暂未开放，当前使用内置测试账号", AUTH_NOT_AVAILABLE);
    },
    modelsGet: async () => modelsInfo(),
    modelsRefresh: async () => modelsInfo(),
    modelsSetDefault: async (model) => {
      if (!MOCK_MODELS.some((m) => m.key === model)) {
        throw new PlatformError(`模型 ${model} 不在可用列表中`);
      }
      defaultModel = model;
      return modelsInfo();
    },

    shellDetect: async () => ({ shells: [{ kind: "powershell", version: "7.5.0" }] }),
    fsTree: async () => [{ name: "README.md", path: "README.md", kind: "file" }],
    fsRead: async () => "# 示例工作区\n\n这是 mock 平台返回的假文件内容。",
    gitStatus: async () => ({ branch: "main", changes: [] }),
    gitDiff: async () => "",

    terminalOpen: async (_cwd, onData) => {
      const terminalId = `mock-term-${nextTerminal++}`;
      setTimeout(() => onData("浏览器预览模式没有真实终端。\r\n"), 0);
      return { terminalId };
    },
    terminalWrite: async () => {},
    terminalResize: async () => {},
    terminalClose: async () => {},

    openExternal: async (target) => {
      globalThis.open?.(target, "_blank", "noopener");
    },
    storageUsage: async () => ({ sessions: 0, logs: 0, cache: 0 }),
    storageClean: async () => {},
    diagnosticsExport: () => notAvailable("导出诊断包"),
    updateCheck: async () => ({ available: false }),
    updateInstall: () => notAvailable("自动更新"),
    logWrite: async (level, message) => {
      console[level === "debug" ? "log" : level](`[mock] ${message}`);
    },
  };
}

/**
 * abort 时队列中保留的记录：全部响应，以及队首尚未推送的运行开始与用户消息（Core 受理 prompt 时就已发生）；
 * 从第一条其他事件起（助手输出、工具、下一轮的 turn_start 等）全部丢弃
 */
function keptOnAbort(queue: readonly Queued[]): Queued[] {
  let prefix = true;
  return queue.filter((r) => {
    if (typeof r === "function" || r.type === "response") return true;
    const opening =
      r.type === "agent_start" ||
      r.type === "turn_start" ||
      ((r.type === "message_start" || r.type === "message_end") && r.message.role === "user");
    prefix &&= opening;
    return prefix;
  });
}

/**
 * 中止一轮时补上的事件：正在输出的助手消息以已推送的内容结束（stopReason 为 aborted），
 * 已开始未结束的工具以出错结束，最后 agent_end + agent_settled（aborted）。
 */
export function abortRecords(delivered: readonly CoreRecord[], timestamp: number): CoreRecord[] {
  const out: CoreRecord[] = [];
  let open: AssistantMessage | undefined;
  let content: AssistantContent[] = [];
  const tools = new Map<string, string>();
  for (const r of delivered) {
    if (r.type === "message_start") {
      open = r.message.role === "assistant" ? r.message : undefined;
      content = [];
    } else if (r.type === "message_end") {
      open = undefined;
    } else if (r.type === "message_update" && open) {
      const e = r.assistantMessageEvent;
      if (e.type === "text_start") content[e.contentIndex] = { type: "text", text: "" };
      else if (e.type === "thinking_start")
        content[e.contentIndex] = { type: "thinking", thinking: "" };
      else if (e.type === "text_delta" || e.type === "thinking_delta") {
        const block = content[e.contentIndex];
        if (block?.type === "text") block.text += e.delta;
        if (block?.type === "thinking") block.thinking += e.delta;
      } else if (e.type === "text_end") content[e.contentIndex] = { type: "text", text: e.content };
      else if (e.type === "thinking_end")
        content[e.contentIndex] = { type: "thinking", thinking: e.content };
      else if (e.type === "toolcall_end") content[e.contentIndex] = e.toolCall;
    } else if (r.type === "tool_execution_start") {
      tools.set(r.toolCallId, r.toolName);
    } else if (r.type === "tool_execution_end") {
      tools.delete(r.toolCallId);
    }
  }
  if (open) {
    out.push({
      type: "message_end",
      message: {
        ...open,
        content: content.filter(Boolean),
        stopReason: "aborted",
        errorMessage: "Request was aborted",
        timestamp,
      },
    });
  }
  for (const [toolCallId, toolName] of tools) {
    out.push({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
      isError: true,
    });
  }
  out.push(
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled", aborted: true },
  );
  return out;
}
