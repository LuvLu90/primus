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
  type SessionIndexEvent,
  type SessionSummary,
  type SpeechEvent,
  UPDATE_BUSY,
  type UpdateStatus,
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
  /**
   * 模拟更新源上的最新版本：比当前版本（0.0.0-mock）新时，“立即检查”会经过下载进度后得到待装版本。
   * 默认没有新版本（检查结果为已是最新）
   */
  latestVersion?: string;
  /** 读取一张图片附件的模拟耗时，默认 700ms（测试可调小） */
  attachmentDelayMs?: number;
  /** 模拟听写每一步（音量、逐字识别）的间隔，默认 90ms */
  speechStepMs?: number;
}

/** mock 能“读取”的图片扩展名（与薄壳支持的格式一致） */
const MOCK_IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 1×1 透明 PNG：mock 图片附件发给假 Core 的数据（不会真的被识别） */
const MOCK_PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** 按路径生成一张渐变占位缩略图（SVG data URL），不同文件颜色不同 */
export function mockThumb(path: string): string {
  let h = 0;
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},80%,72%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360},70%,48%)"/></linearGradient></defs><rect width="112" height="112" fill="url(#g)"/><circle cx="78" cy="38" r="14" fill="rgba(255,255,255,.75)"/><path d="M0 112 L40 60 L66 90 L84 72 L112 112Z" fill="rgba(0,0,0,.28)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** mock 听写的台词：逐字作为临时结果推送，每句结束时定稿 */
const MOCK_SPEECH = ["帮我看下这张截图里的布局问题，", "对照需求说明改一下。"];

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

/** get_state / set_model 响应里的模型对象（字段按 Core 的 Model，只填界面用到的） */
function mockModel(key: string) {
  const m = MOCK_MODELS.find((x) => x.key === key) ?? MOCK_LARGE;
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    provider: m.provider,
    baseUrl: "https://mock.invalid",
    reasoning: m.reasoning,
    input: m.image ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

/** 队列项：记录本身，或推送时才生成的记录（get_messages 的响应在推送那一刻取历史快照） */
type Queued = CoreRecord | (() => CoreRecord);

interface MockSession {
  key: string;
  /** 会话文件路径（mock 中只是标识），新会话首条消息定稿后才进入索引，与 Core 落盘时机一致 */
  path: string;
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
  /** 当前模型（`provider/modelId`）与思考强度 */
  model: string;
  thinkingLevel: string;
  /** 自动压缩开关（set_auto_compaction） */
  autoCompaction: boolean;
  /** 刚压缩过：下一次回复前上下文占用未知（tokens 为 null，与 Core 一致） */
  compacted: boolean;
}

const MOCK_WORKSPACE = "C:\\Users\\mock\\示例工作区";
const MOCK_SESSIONS_DIR = "C:\\Users\\mock\\data\\sessions";
/** 与薄壳一致的分页大小 */
const MOCK_PAGE_SIZE = 50;
/** 与薄壳一致：少于这么多字符的查询只匹配会话名与首条用户消息（trigram 分词的下限） */
const MOCK_FULL_TEXT_MIN_CHARS = 3;

/** 键集游标 `<毫秒>:<路径>`（与薄壳 session_index 的 parse_cursor 一致）；解析不了时为 undefined（按第一页处理） */
function parseCursor(cursor: string): { updatedAt: number; path: string } | undefined {
  const i = cursor.indexOf(":");
  if (i < 0) return undefined;
  const time = cursor.slice(0, i);
  if (!/^-?\d+$/.test(time)) return undefined;
  return { updatedAt: Number(time), path: cursor.slice(i + 1) };
}

/** 消息正文（字符串或 text 块），供 mock 索引标题与搜索 */
function messageText(m: AgentMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
    .join(" ");
}

export function createMockPlatform(options: MockOptions = {}): Platform {
  const intervalMs = options.intervalMs ?? 16;
  const batchSize = options.batchSize ?? 4;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, MockSession>();
  const workspaces = new Map<string, WorkspaceInfo>([
    [
      MOCK_WORKSPACE,
      { path: MOCK_WORKSPACE, name: "示例工作区", trusted: true, needsTrust: false },
    ],
  ]);
  // 会话索引（模拟薄壳的 session_index）：会话文件路径 → 摘要与已定稿的消息
  const sessionIndex: SessionSummary[] = [];
  const history = new Map<string, AgentMessage[]>();
  let indexListener: ((e: SessionIndexEvent) => void) | undefined;
  let indexSeq = 0;
  const notifyIndex = () => {
    indexSeq += 1;
    indexListener?.({ seq: indexSeq });
  };
  /** 消息定稿后更新索引：有用户消息才入索引（Core 在第一条用户消息之前不落盘） */
  const touchIndex = (s: MockSession) => {
    history.set(s.path, s.messages.slice());
    const firstUser = s.messages.find((m) => (m as { role?: string }).role === "user");
    if (!firstUser) return;
    const t = now();
    const entry = sessionIndex.find((x) => x.path === s.path);
    if (entry) {
      entry.updatedAt = t;
      entry.messageCount = s.messages.length;
    } else {
      sessionIndex.push({
        path: s.path,
        id: s.key,
        name: null,
        title: messageText(firstUser).trim().slice(0, 200),
        workspace: s.workspace,
        createdAt: t,
        updatedAt: t,
        messageCount: s.messages.length,
        archived: false,
      });
    }
    notifyIndex();
  };
  const sortedIndex = () =>
    sessionIndex.slice().sort((a, b) => b.updatedAt - a.updatedAt || (a.path < b.path ? 1 : -1));
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
  // 自动更新（浏览器预览）：可用、默认自动更新开；有 latestVersion 时检查后模拟下载完成
  let update: UpdateStatus = {
    currentVersion: "0.0.0-mock",
    available: true,
    installKind: "msi",
    settings: { autoUpdate: true, channel: "stable" },
    phase: "idle",
    progress: null,
    pending: null,
    lastCheck: null,
    lastError: null,
  };
  let updateListener: ((status: UpdateStatus) => void) | undefined;
  const setUpdate = (patch: Partial<UpdateStatus>) => {
    update = { ...update, ...patch };
    updateListener?.(structuredClone(update));
  };
  let nextSession = 1;
  let nextTerminal = 1;
  // 模拟听写：当前会话的定时器与回调
  const speechStepMs = options.speechStepMs ?? 90;
  let speech: { timer: ReturnType<typeof setInterval>; onEvent: (e: SpeechEvent) => void } | null =
    null;
  const endSpeech = () => {
    if (!speech) return;
    clearInterval(speech.timer);
    const { onEvent } = speech;
    speech = null;
    onEvent({ type: "end" });
  };

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
    if (r.type === "message_end") {
      s.messages.push(r.message);
      touchIndex(s);
    }
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
        const message = String(cmd.message ?? "");
        // 扩展命令（如 primus-guard 的 /primus-mode）：与 Core 一致，直接执行、不调用模型，运行中也立即执行
        if (message.startsWith("/primus-")) {
          emit(s, respond(cmd, { disposition: "handled" }));
          return;
        }
        if (s.streaming) {
          // 真实 Core 会按 streamingBehavior 排队；mock 只做最简单的拒绝
          emit(s, respond(cmd, undefined, "mock：正在运行中，请先停止或等待结束"));
          return;
        }
        const scenario = promptScenario(message, now());
        s.streaming = true;
        s.compacted = false;
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
              model: mockModel(s.model),
              thinkingLevel: s.thinkingLevel,
              isStreaming: s.streaming,
              isCompacting: false,
              steeringMode: "one-at-a-time",
              followUpMode: "one-at-a-time",
              sessionId: s.key,
              autoCompactionEnabled: s.autoCompaction,
              messageCount: s.messages.length,
              pendingMessageCount: 0,
            }),
        );
        return;
      case "set_model": {
        const key = `${cmd.provider}/${cmd.modelId}`;
        if (!MOCK_MODELS.some((m) => m.key === key)) {
          emit(s, respond(cmd, undefined, `模型 ${key} 不在可用列表中`));
          return;
        }
        s.model = key;
        if (!MOCK_MODELS.find((m) => m.key === key)?.reasoning) s.thinkingLevel = "off";
        emit(s, respond(cmd, mockModel(key)));
        return;
      }
      case "set_thinking_level":
        s.thinkingLevel = MOCK_MODELS.find((m) => m.key === s.model)?.reasoning ? cmd.level : "off";
        emit(s, respond(cmd));
        return;
      case "get_available_thinking_levels":
        emit(
          s,
          respond(cmd, {
            levels: MOCK_MODELS.find((m) => m.key === s.model)?.reasoning
              ? ["off", "low", "medium", "high", "xhigh"]
              : ["off"],
          }),
        );
        return;
      case "get_session_stats": {
        // 粗略按 4 字符 1 token 估算上下文占用
        const window = MOCK_MODELS.find((m) => m.key === s.model)?.contextWindow ?? 128_000;
        emit(s, () => {
          const tokens = Math.round(JSON.stringify(s.messages).length / 4);
          // 累计用量也粗略估算：每轮输入约为上下文的两倍，缓存命中约为一半
          const input = tokens * 2;
          const output = Math.round(tokens / 4);
          const cacheRead = tokens;
          return respond(cmd, {
            sessionId: s.key,
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: s.messages.length,
            tokens: { input, output, cacheRead, cacheWrite: 0, total: input + output + cacheRead },
            cost: Math.round((input * 3 + output * 15 + cacheRead * 0.3) / 10_000) / 100,
            contextUsage: s.compacted
              ? { tokens: null, contextWindow: window, percent: null }
              : {
                  tokens,
                  contextWindow: window,
                  percent: Math.round((tokens / window) * 1000) / 10,
                },
          });
        });
        return;
      }
      case "set_auto_compaction":
        s.autoCompaction = cmd.enabled;
        emit(s, respond(cmd));
        return;
      case "compact": {
        // 与 Core 一致：压缩后到下一次回复前，上下文占用未知
        const tokensBefore = Math.round(JSON.stringify(s.messages).length / 4);
        s.compacted = true;
        emit(
          s,
          respond(cmd, {
            summary: "mock：已压缩的对话摘要",
            firstKeptEntryId: "mock",
            tokensBefore,
            estimatedTokensAfter: Math.round(tokensBefore / 5),
          }),
        );
        return;
      }
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
        needsTrust: true,
      };
      workspaces.set(path, ws);
      return ws;
    },
    workspaceList: async () => [...workspaces.values()],
    dialogPickFolder: async () => "C:\\Users\\mock\\新项目",
    dialogPickFiles: async () => [
      `${MOCK_WORKSPACE}\\README.md`,
      `${MOCK_WORKSPACE}\\src\\main.ts`,
      `${MOCK_WORKSPACE}\\设计稿.png`,
    ],
    workspaceTrust: async (path, trusted, fingerprint) => {
      // 与真实平台一致：信任必须带回 workspaceInspect 给出的指纹
      if (trusted && fingerprint !== "mock")
        throw new Error("项目内容在确认后发生了变化，请重新查看后再决定");
      const ws = workspaces.get(path);
      if (ws) Object.assign(ws, { trusted, needsTrust: false });
    },
    workspaceInspect: async (path) => ({
      path,
      agentsMd: "# 项目约定\n\n- 提交前运行测试\n- 使用中文注释",
      agentsMdTruncated: false,
      extensions: ["guard.ts"],
      skills: ["review"],
      mcpServers: ["github"],
      fingerprint: "mock",
    }),

    sessionList: async (workspace, cursor) => {
      // 键集分页（与薄壳一致）：只返回排在游标那条之后的会话，归档或新增会话不会让后续页漏项或重复
      const after = cursor ? parseCursor(cursor) : undefined;
      const all = sortedIndex().filter(
        (x) =>
          !x.archived &&
          (workspace === null || x.workspace === workspace) &&
          (!after ||
            x.updatedAt < after.updatedAt ||
            (x.updatedAt === after.updatedAt && x.path < after.path)),
      );
      const items = all.slice(0, MOCK_PAGE_SIZE);
      const last = items.at(-1);
      return {
        items: structuredClone(items),
        nextCursor:
          all.length > MOCK_PAGE_SIZE && last ? `${last.updatedAt}:${last.path}` : undefined,
      };
    },
    sessionSearch: async (workspace, query) => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      // 与薄壳一致：3 个字符以上匹配消息全文，更短只匹配会话名与首条用户消息（title）
      const fullText = [...q].length >= MOCK_FULL_TEXT_MIN_CHARS;
      return structuredClone(
        sortedIndex()
          .filter((x) => workspace === null || x.workspace === workspace)
          .filter((x) =>
            [
              x.name ?? "",
              x.title,
              ...(fullText ? (history.get(x.path) ?? []).map(messageText) : []),
            ].some((t) => t.toLowerCase().includes(q)),
          )
          .slice(0, MOCK_PAGE_SIZE),
      );
    },
    sessionWatch: async (onChange) => {
      indexListener = onChange;
      // 与薄壳一致：注册后补发一次，覆盖注册前发生的变化
      notifyIndex();
    },
    sessionOpen: async (workspace, sessionPath, onBatch) => {
      const key = `mock-${nextSession++}`;
      const path = sessionPath || `${MOCK_SESSIONS_DIR}\\${key}.jsonl`;
      sessions.set(key, {
        key,
        path,
        workspace,
        onBatch,
        seq: 0,
        messages: history.get(path)?.slice() ?? [],
        queue: [],
        timer: undefined,
        streaming: false,
        closed: false,
        delivered: [],
        aborting: false,
        model: defaultModel,
        thinkingLevel: "medium",
        autoCompaction: true,
        compacted: false,
      });
      return { sessionKey: key, sessionId: sessionPath ? null : key };
    },
    sessionClose: async (sessionKey) => {
      const s = sessions.get(sessionKey);
      if (!s) return;
      // Core 受理 prompt 时就已写下用户消息：队列里尚未推送的第一条用户 message_end 计入历史与索引，
      // 其余未推送的记录（助手消息等）丢弃。生成型队列项（函数）不是记录，跳过
      const pendingUser = s.queue.find(
        (item): item is Extract<CoreRecord, { type: "message_end" }> =>
          typeof item !== "function" &&
          item.type === "message_end" &&
          (item.message as { role?: string }).role === "user",
      );
      if (pendingUser) {
        s.messages.push(pendingUser.message);
        touchIndex(s);
      }
      s.closed = true;
      if (s.timer !== undefined) clearTimeout(s.timer);
      s.queue = [];
      sessions.delete(sessionKey);
    },
    sessionDelete: async (path) => {
      // 打开中的会话一并关闭（与薄壳一致：删除前结束它的 Core），之后的发送得到“内核未运行”
      for (const [key, s] of sessions) {
        if (s.path !== path || s.closed) continue;
        s.closed = true;
        if (s.timer !== undefined) clearTimeout(s.timer);
        s.queue = [];
        sessions.delete(key);
      }
      const i = sessionIndex.findIndex((x) => x.path === path);
      if (i < 0) throw new Error(`不是会话文件：${path}`);
      sessionIndex.splice(i, 1);
      history.delete(path);
      notifyIndex();
    },
    sessionArchive: async (path, archived) => {
      const entry = sessionIndex.find((x) => x.path === path);
      if (!entry) throw new Error(`会话不在索引中：${path}`);
      entry.archived = archived;
      notifyIndex();
    },

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
    // 示例工作区是 Git 仓库（main 分支），其他文件夹不是
    gitBranch: async (workspace) =>
      workspace === MOCK_WORKSPACE ? { name: "main", detached: false } : null,
    attachmentImage: async (path) => {
      await new Promise((r) => setTimeout(r, options.attachmentDelayMs ?? 700));
      if (!MOCK_IMAGE_EXT.test(path)) throw new Error("不是支持的图片格式");
      if (/损坏|broken/i.test(path)) throw new Error("图片无法解码：mock 模拟的损坏文件");
      return {
        mimeType: "image/png",
        data: MOCK_PNG_1PX,
        thumb: mockThumb(path),
        width: 1,
        height: 1,
      };
    },
    speechAvailable: async () => true,
    speechStart: async (onEvent) => {
      endSpeech();
      // 逐字推送临时结果，每句结束时定稿；音量按正弦起伏，句间停顿时变小
      let sentence = 0;
      let chars = 0;
      let tick = 0;
      const timer = setInterval(() => {
        tick += 1;
        const line = MOCK_SPEECH[sentence];
        const speaking = line !== undefined;
        const level = speaking
          ? 0.35 + 0.55 * Math.abs(Math.sin(tick / 2.3) * Math.sin(tick / 5.1 + 1))
          : 0.04;
        onEvent({ type: "level", level });
        if (!line || tick % 2) return;
        chars += 1;
        if (chars <= line.length) onEvent({ type: "interim", text: line.slice(0, chars) });
        else {
          onEvent({ type: "final", text: line });
          sentence += 1;
          chars = 0;
        }
      }, speechStepMs);
      speech = { timer, onEvent };
    },
    speechStop: async () => endSpeech(),

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
    updateStatus: async () => structuredClone(update),
    updateWatch: async (onChange) => {
      updateListener = onChange;
      onChange(structuredClone(update));
    },
    updateCheck: async () => {
      const latest = options.latestVersion;
      // 与薄壳一致：只有按 SemVer 严格高于当前版本才算更新
      if (
        latest &&
        compareSemver(latest, update.currentVersion) > 0 &&
        update.pending?.version !== latest
      ) {
        setUpdate({ phase: "downloading", progress: { downloaded: 0, total: 100 } });
        setUpdate({ progress: { downloaded: 100, total: 100 } });
        setUpdate({ pending: { version: latest, notes: null } });
      }
      setUpdate({ phase: "idle", progress: null, lastCheck: now(), lastError: null });
      return structuredClone(update);
    },
    updateSettingsSet: async (patch) => {
      setUpdate({ settings: { ...update.settings, ...patch } });
      return structuredClone(update);
    },
    updateInstall: async (force) => {
      if (!update.pending) throw new PlatformError("没有已下载的更新", "noPending");
      const running = [...sessions.values()].some((s) => s.streaming);
      if (running && !force)
        throw new PlatformError("有正在运行的 Agent，更新会停止它们", UPDATE_BUSY);
      return notAvailable("重启安装更新");
    },
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
 * 按 SemVer 2.0 比较两个版本（可带前缀 v）：大于返回正数、等于 0、小于负数。解析不了的版本视为最低。
 * 与薄壳 `updater::is_newer`（semver crate）的排序一致：预发布低于正式版，预发布标识逐段比较，数字段按数值比较。
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
    return m
      ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] }
      : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] ?? "";
    const q = y.pre[i] ?? "";
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
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
