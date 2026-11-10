"use client";

import {
  CONTEXT_STATS_COMMAND,
  type CoreBatch,
  type ExtensionUiResponse,
  type ImageContent,
  type ThinkingLevel,
} from "@primus/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { CORE_NOT_RUNNING, getPlatform, type Platform, PlatformError } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { RpcClient, RpcClosedError, RpcResponseError, RpcTimeoutError } from "@/rpc/rpc-client";
import { type PermissionMode, useAppStore } from "@/stores/app-store";
import {
  applyChunks,
  createSessionStore,
  dismissUiRequest,
  type RecordChunk,
  type SessionState,
  type SessionStore,
  withModel,
} from "@/stores/session-store";

/** 设置权限模式的扩展命令（primus-guard）；作为 prompt 发送，Core 直接执行，不调用模型 */
export const modeCommand = (mode: PermissionMode) => `/primus-mode ${mode}`;

/**
 * 请求上下文清单的扩展命令（primus-context-stats，只读）。Core 在 prompt 路径的最前面执行已注册的扩展命令
 * （AgentSession.prompt → _tryExecuteExtensionCommand，早于输入处理、排队与 _startRun），
 * 不写入会话历史、不调用模型；结果经 setWidget("primus:context-stats") 推送
 */
export const contextStatsCommand = `/${CONTEXT_STATS_COMMAND}`;

// 一个会话的生命周期：新会话首次发送时打开；历史会话挂载后立即打开并用 get_messages + get_state 加载历史
// （浏览器预览下由 mock 平台提供假 Core 事件流）。
// 批次先交给 RPC 客户端（id 关联、超时、缺口重建），去重后的记录在 requestAnimationFrame 中
// 一次性合并进 store（第 16.4 节）。

/** 错误的界面文案：RPC 层的错误只带结构化字段，文案在这里由 strings 生成 */
function describeError(e: unknown): string {
  if (e instanceof RpcTimeoutError) return strings.chat.responseTimeout;
  if (e instanceof RpcResponseError) return e.reason;
  return e instanceof Error ? e.message : String(e);
}

/** 新会话与切换模型后默认使用的思考强度（Core 会夹到模型支持的范围，不支持思考的模型为 off） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

const nextFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (cb) => requestAnimationFrame(() => cb())
    : (cb) => setTimeout(cb, 16);

export interface ChatSession {
  state: SessionState;
  /** 打开会话或发送命令时的错误 */
  error?: string;
  /**
   * 有命令超过 10 秒没有响应（第 7.5 节），或重启后重建会话状态失败，界面提示“内核无响应”并提供重启。
   * 期间禁止发送：超时的 prompt 可能已被 Core 受理，重发会多跑一轮。
   */
  unresponsive: boolean;
  /** 内核未运行（已自行退出、因进程上限被淘汰或重启失败）：同样提示并提供重启，重启成功前禁止发送 */
  coreStopped: boolean;
  /** 发送成功返回 true；失败时设置 error 并返回 false。`images` 随 prompt 一起发给支持看图的模型 */
  send: (message: string, images?: ImageContent[]) => Promise<boolean>;
  /** 会话已打开（压缩、自动压缩、用量统计只在打开后可用） */
  connected: boolean;
  /** 刷新上下文占用与本会话用量（get_session_stats）；会话未打开时什么也不做 */
  refreshStats: () => void;
  /**
   * 请求上下文清单（`/primus-context-stats`）。先用 get_commands 确认扩展命令已注册（每个连接只查一次）：
   * 未注册时这段文字会被当作普通消息发给模型，因此不发送（卡片只显示已用与可用空间）。
   * 会话打开与重启后会自动预取一次，之后由扩展在每轮结束时主动重推
   */
  requestContextStats: () => void;
  /** 立即压缩（compact）；成功返回 true，失败设置 error 并返回 false */
  compact: () => Promise<boolean>;
  /** 开关自动压缩（set_auto_compaction，Core 的全局持久设置）；乐观更新，失败回滚；成功返回 true */
  setAutoCompaction: (enabled: boolean) => Promise<boolean>;
  /** abort 成功（Core 已回成功响应）返回 true；失败时设置 error 并返回 false */
  abort: () => Promise<boolean>;
  /** 停止 Core 的自动重试（abort_retry）；成功返回 true，失败设置 error 并返回 false */
  abortRetry: () => Promise<boolean>;
  /** 正在重启内核：期间重启入口不可用，避免连点重复重启 */
  restarting: boolean;
  /** 重启内核并重建会话状态；进行中再次调用会被忽略 */
  restart: () => Promise<void>;
  /** 回答扩展对话框（操作确认等）；回答后从待回答列表移除 */
  respondUi: (response: ExtensionUiResponse) => Promise<void>;
  /**
   * 切换模型（`provider/modelId`）与思考强度。会话已打开时立即发给 Core；未打开时记下，
   * 打开后、发送第一条消息前再应用。成功返回 true，失败设置 error 并返回 false
   */
  selectModel: (choice: { model?: string; thinkingLevel?: ThinkingLevel }) => Promise<boolean>;
  /** 会话打开前记下的选择（界面据此显示） */
  pendingModel: { model?: string; thinkingLevel?: ThinkingLevel };
  /** 模型是否锁定：已有消息，或历史会话的历史还没加载完（思考强度仍可调） */
  modelLocked: boolean;
  /** 重新读取 Core 的 get_available_models（模型能力以 Core 为准） */
  refreshModels: () => void;
}

export interface ChatSessionOptions {
  /** 打开的历史会话文件：挂载后立即打开并加载历史；新会话不传 */
  sessionPath?: string | null;
  /** 会话的工作区；不传时用输入框上方选中的工作区（未选为空，即直接对话） */
  workspace?: string | null;
  /** 开始打开会话（true）与打开结束（false，无论成败；成功时先于 onOpened） */
  onOpening?: (opening: boolean) => void;
  /** 会话已打开：薄壳给出的会话 ID（新会话）与实际使用的工作区 */
  onOpened?: (opened: { sessionId: string | null; workspace: string }) => void;
}

export function useChatSession(options: ChatSessionOptions = {}): ChatSession {
  // 选项放进 ref：打开流程只在需要时读取最新值，不让回调随之重建
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const storeRef = useRef<SessionStore>(null);
  storeRef.current ??= createSessionStore();
  const store = storeRef.current;
  const state = useStore(store);
  // 错误来源：超时与重建失败产生的错误在内核恢复或重建成功后自动清除，其他错误保留到下一次操作
  const [error, setErrorState] = useState<{ message: string; kind?: "timeout" | "resync" }>();
  const [unresponsive, setUnresponsiveState] = useState(false);
  const [coreStopped, setCoreStopped] = useState(false);
  // 锁定发送的三个来源：有命令超时（等它的迟到响应或重启）、重启后重建失败（等之后的重建成功）、
  // 内核未运行（只有重启能恢复，重启成功即解除）
  const lock = useRef({ timeout: false, restart: false, stopped: false });
  const syncUnresponsive = useCallback(() => {
    const l = lock.current;
    setUnresponsiveState(l.timeout || l.restart || l.stopped);
    setCoreStopped(l.stopped);
  }, []);
  const setError = useCallback((message?: string, kind?: "timeout" | "resync") => {
    setErrorState(message === undefined ? undefined : { message, kind });
  }, []);
  const clearError = useCallback((kind: "timeout" | "resync") => {
    setErrorState((e) => (e?.kind === kind ? undefined : e));
  }, []);
  /** 命令失败时的统一处理；重启或关闭导致的 RpcClosedError 不算错误 */
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof RpcClosedError) return;
      if (e instanceof PlatformError && e.code === CORE_NOT_RUNNING) {
        // 内核未运行时每次发送都会同样失败：锁定发送并提供重启入口
        lock.current.stopped = true;
        syncUnresponsive();
      }
      setError(describeError(e), e instanceof RpcTimeoutError ? "timeout" : undefined);
    },
    [setError, syncUnresponsive],
  );

  const conn = useRef<{ platform: Platform; client: RpcClient }>(null);
  const [connected, setConnected] = useState(false);
  // 当前内核是否注册了 primus-context-stats（每个连接、每次重启查一次 get_commands）
  const statsCommandReady = useRef<Promise<boolean>>(null);
  // Core 里当前生效的权限模式（新进程默认“每次询问”，打开或重启后重新同步）
  const syncedMode = useRef<PermissionMode | null>(null);
  const [pendingModel, setPendingModel] = useState<{
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }>({});
  const pendingModelRef = useRef(pendingModel);
  pendingModelRef.current = pendingModel;
  // 用户想要的思考强度：默认“中”，用户选过即以所选为准。新会话打开与切换模型后都按它设置，
  // 否则 Core 沿用自己的默认值或上一个模型夹出来的 off（换回支持思考的模型后也还是 off）
  const preferredThinking = useRef<ThinkingLevel>(DEFAULT_THINKING_LEVEL);

  // 只在每个连接（含重启后的新进程）上查一次命令是否注册，结果缓存；之后扩展在每轮结束时主动重推，
  // 打开卡片不再现场串行 get_commands → prompt → setWidget
  const requestContextStats = useCallback(() => {
    const c = conn.current;
    if (!c) return;
    const { client } = c;
    if (!statsCommandReady.current) {
      const query: Promise<boolean> = client
        .request("get_commands")
        .then((res) => {
          // 失败响应与超时一样交给下面的清缓存路径，下次再查
          if (!res.success) throw new Error(res.error);
          return res.data.commands.some(
            (cmd) => cmd.source === "extension" && cmd.name === CONTEXT_STATS_COMMAND,
          );
        })
        .catch(() => {
          // 查询失败（失败响应、超时等）：下次打开卡片再查；只清掉自己（期间重连或重启已换成新的查询时不动）
          if (statsCommandReady.current === query) statsCommandReady.current = null;
          return false;
        });
      statsCommandReady.current = query;
    }
    void statsCommandReady.current.then((ready) => {
      if (!ready || conn.current?.client !== client) return;
      client.request("prompt", { message: contextStatsCommand }).catch(() => {});
    });
  }, []);

  /** 把界面上的权限模式同步给 Core（primus-guard）；已一致时什么也不做 */
  const syncMode = useCallback(async (client: RpcClient) => {
    // 发送前清空已同步状态、完成后按当前档位复查：快速连续切换时，迟到的旧响应不会让界面与 Core 不一致
    for (;;) {
      const mode = useAppStore.getState().permissionMode;
      if (syncedMode.current === mode) return;
      syncedMode.current = null;
      const res = await client.request("prompt", { message: modeCommand(mode) });
      if (!res.success) {
        // 同步失败时不能继续发送：界面显示的模式与 Core 实际执行的不一致（如界面已改回“每次询问”，Core 仍是完全访问）
        syncedMode.current = null;
        throw new Error(`${strings.chat.modeSyncFailed}：${res.error || modeCommand(mode)}`);
      }
      syncedMode.current = mode;
    }
  }, []);

  /** 会话打开后：应用打开前选的模型与思考强度、同步权限模式，再读取当前模型与可选的思考强度 */
  const applySession = useCallback(
    async (client: RpcClient) => {
      const pending = pendingModelRef.current;
      const { model } = pending;
      // 新会话（以及换了模型的会话）按想要的强度设置；历史会话沿用它自己记下的强度
      const thinkingLevel =
        pending.thinkingLevel ??
        (model || !optionsRef.current.sessionPath ? preferredThinking.current : undefined);
      const [provider, ...rest] = model?.split("/") ?? [];
      // 成功应用的才从待应用选择中移除；失败的保留，下一次发送前再试（失败响应同样报错，由调用方提示）
      const failures: string[] = [];
      if (provider && rest.length > 0) {
        const res = await client.request("set_model", { provider, modelId: rest.join("/") });
        if (res.success)
          setPendingModel((p) => (p.model === model ? { ...p, model: undefined } : p));
        else failures.push(res.error || "set_model");
      }
      if (thinkingLevel) {
        const res = await client.request("set_thinking_level", { level: thinkingLevel });
        if (res.success)
          setPendingModel((p) =>
            p.thinkingLevel === thinkingLevel ? { ...p, thinkingLevel: undefined } : p,
          );
        else failures.push(res.error || "set_thinking_level");
      }
      await syncMode(client);
      await Promise.all([
        client.request("get_state"),
        client.request("get_available_thinking_levels"),
        client.request("get_session_stats").catch(() => {}),
        // 模型能力以 Core 为准（能否看图、上下文长度、是否支持思考）
        client.request("get_available_models").catch(() => {}),
      ]);
      if (failures.length > 0)
        throw new Error(`${strings.chat.model.switchFailed}：${failures.join("；")}`);
    },
    [syncMode],
  );
  const pending = useRef<RecordChunk[]>([]);
  const frameQueued = useRef(false);

  const enqueue = useCallback(
    (chunk: RecordChunk) => {
      pending.current.push(chunk);
      if (frameQueued.current) return;
      frameQueued.current = true;
      nextFrame(() => {
        frameQueued.current = false;
        const chunks = pending.current;
        pending.current = [];
        store.setState((s) => applyChunks(s, chunks), true);
      });
    },
    [store],
  );

  // 正在打开的会话：并发的 send 复用同一个 Promise，避免重复 sessionOpen 泄漏 Core 进程
  const opening = useRef<Promise<void>>(null);
  const disposed = useRef(false);
  // 重建失败的代次：推迟的“重建成功”清除只在期间没有新的失败时生效，避免旧的成功清掉新失败的提示
  const resyncFailures = useRef(0);
  // 历史会话的历史已显示：任意一次重建（首次加载、缺口重建、重启后重建）成功即为 true；
  // 打开或重建失败时保持 false，下次发送前再加载
  const historyLoaded = useRef(false);
  // 历史消息已写入 store：重建的 response 排在帧队列里，下一帧 applyChunks 之后才算数。
  // 模型锁定只看它，避免“已加载但 store 仍为空”的间隙里切换模型（ref 供 selectModel，state 供界面渲染）
  const historyShown = useRef(false);
  const [historyReady, setHistoryReady] = useState(false);

  const ensureOpen = useCallback((): Promise<void> => {
    if (conn.current) return Promise.resolve();
    opening.current ??= (async () => {
      optionsRef.current.onOpening?.(true);
      const platform = await getPlatform();
      // 历史会话用它自己的工作区；新会话用输入框上方选中的工作区，未选择时直接对话，
      // 不隐式绑定最近的工作区（会话开始后工作区锁定）
      const { sessionPath, workspace } = optionsRef.current;
      const path = workspace ?? useAppStore.getState().workspace?.path ?? "";
      // 批次可能在 sessionOpen 返回前到达：先缓存，客户端建好后按序交付
      let client: RpcClient | undefined;
      const early: CoreBatch[] = [];
      const onBatch = (batch: CoreBatch) => (client ? client.receive(batch) : early.push(batch));
      const { sessionKey, sessionId } = await platform.sessionOpen(
        path,
        sessionPath ?? undefined,
        onBatch,
      );
      if (disposed.current) {
        // 打开期间组件已卸载：立即关闭，避免会话泄漏
        void platform.sessionClose(sessionKey).catch(() => {});
        throw new RpcClosedError();
      }
      client = new RpcClient({
        sessionKey,
        send: (record) => platform.coreSend(sessionKey, record),
        onRecords: (records, { gap }) => enqueue({ records, gap }),
        onUnresponsive: () => {
          lock.current.timeout = true;
          syncUnresponsive();
        },
        onResponsive: () => {
          lock.current.timeout = false;
          syncUnresponsive();
          clearError("timeout");
        },
        onResyncError: (e) => {
          resyncFailures.current += 1;
          // 重建时发现内核未运行（如重启后新进程随即退出）：按“内核已停止”锁定并提供重启，而不是“无响应”
          if (e instanceof PlatformError && e.code === CORE_NOT_RUNNING) {
            lock.current.stopped = true;
            syncUnresponsive();
          }
          setError(`${strings.chat.resyncFailed}：${describeError(e)}`, "resync");
        },
        // 重建的两条 response 随批次排在帧队列里：等它们写入 store 之后再清除重建错误；
        // 若这一帧之前又有一轮重建失败，保留新的失败提示。
        // 重建成功即解除“重启后重建失败”造成的锁定；超时命令造成的锁定仍等其迟到响应
        onResynced: () => {
          historyLoaded.current = true;
          lock.current.restart = false;
          syncUnresponsive();
          const failures = resyncFailures.current;
          nextFrame(() => {
            historyShown.current = true;
            setHistoryReady(true);
            if (resyncFailures.current === failures) clearError("resync");
          });
        },
      });
      for (const batch of early) client.receive(batch);
      conn.current = { platform, client };
      statsCommandReady.current = null;
      setConnected(true);
      syncedMode.current = null;
      optionsRef.current.onOpening?.(false);
      optionsRef.current.onOpened?.({ sessionId: sessionId ?? null, workspace: path });
      // 会话已建立：打开后的设置失败不影响会话本身（提示错误；权限模式在下一次发送前会再同步）
      await applySession(client).catch(fail);
      // 预取上下文清单：打开卡片时已有数据，不再等三次往返
      requestContextStats();
    })().finally(() => {
      opening.current = null;
      // 失败时也结束“打开中”（成功时已在 onOpened 之前结束，重复调用无影响）
      if (!disposed.current) optionsRef.current.onOpening?.(false);
    });
    return opening.current;
  }, [enqueue, setError, clearError, syncUnresponsive, applySession, fail, requestContextStats]);

  // 每条消息输出结束（含一轮结束）后刷新上下文占用；切换模型后也刷新（上下文窗口随模型变化）；
  // 压缩结束（含自动压缩）后也刷新。打开上下文卡片时直接用这里的结果，不再每次都取
  const streamingNow = state.streamingMessage;
  const compactingNow = state.compacting;
  const modelKey = state.model ? `${state.model.provider}/${state.model.id}` : "";
  useEffect(() => {
    if (streamingNow || compactingNow || !modelKey) return;
    conn.current?.client.request("get_session_stats").catch(() => {});
  }, [streamingNow, compactingNow, modelKey]);

  // 权限模式变化：会话已打开时立即同步（扩展命令运行中也会立即执行）
  const permissionMode = useAppStore((s) => s.permissionMode);
  useEffect(() => {
    const c = conn.current;
    if (!c || syncedMode.current === permissionMode) return;
    // 失败时提示；下一次发送前会再同步，仍失败则不发送
    syncMode(c.client).catch(fail);
  }, [permissionMode, syncMode, fail]);

  // 卸载时关闭会话。推迟到下一个任务再关：React 开发模式（StrictMode）会立即卸载再挂载，
  // 重新挂载时取消关闭，打开中的会话照常复用，不会对同一个会话文件重复打开
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(closeTimer.current);
    disposed.current = false;
    return () => {
      closeTimer.current = setTimeout(() => {
        disposed.current = true;
        opening.current = null;
        const c = conn.current;
        conn.current = null;
        setConnected(false);
        if (c) {
          c.client.close();
          void c.platform.sessionClose(c.client.sessionKey).catch(() => {});
        }
      }, 0);
    };
  }, []);

  // 历史会话：挂载后打开并加载历史。成功后之后的重建由缺口检测与重启触发；打开或重建失败时不标记已加载，
  // 下一次发送前重试（标签隐藏而不卸载，挂载效果不会再次执行）
  const historyPath = options.sessionPath ?? null;
  // 进行中的历史加载：挂载效果与发送并发时复用，不重复打开或重建（RpcClient.resync 自身也会合并并发调用）
  const historyLoading = useRef<Promise<void>>(null);
  const loadHistory = useCallback((): Promise<void> => {
    historyLoading.current ??= (async () => {
      await ensureOpen();
      const c = conn.current;
      // 重建失败已由 onResyncError 提示，historyLoaded 保持 false
      if (c && !historyLoaded.current) await c.client.resync();
    })().finally(() => {
      historyLoading.current = null;
    });
    return historyLoading.current;
  }, [ensureOpen]);
  useEffect(() => {
    if (!historyPath || historyLoaded.current) return;
    loadHistory().catch(fail);
  }, [historyPath, loadHistory, fail]);

  const send = useCallback(
    async (message: string, images?: ImageContent[]): Promise<boolean> => {
      // 重建失败的提示保留到重建成功为止
      setErrorState((e) => (e?.kind === "resync" ? e : undefined));
      try {
        // 历史会话的历史尚未加载成功（之前打开或重建失败）：先打开并重建再发送；
        // 重建失败时照常发送（Core 已从会话文件恢复，失败提示保留到之后的重建成功）
        if (optionsRef.current.sessionPath && !historyLoaded.current) await loadHistory();
        else await ensureOpen();
        // coreSend 只表示已提交；以 Core 的响应为准（失败原因由 session-store 显示为 lastError）
        const c = conn.current;
        if (!c) throw new Error(strings.chat.sessionNotOpen);
        // 打开时没能应用的模型选择与权限模式：发送前再应用一次（任一仍失败则不发送，并提示原因）
        const pendingChoice = pendingModelRef.current;
        if (pendingChoice.model || pendingChoice.thinkingLevel) await applySession(c.client);
        await syncMode(c.client);
        const res = await c.client.request(
          "prompt",
          images && images.length > 0 ? { message, images } : { message },
        );
        return res.success;
      } catch (e) {
        // 超时时 Core 可能已受理（它不按 id 去重）：保留草稿，但由界面在内核恢复或重启前禁止重发
        fail(e);
        return false;
      }
    },
    [ensureOpen, loadHistory, fail, syncMode, applySession],
  );

  const respondUi = useCallback(
    async (response: ExtensionUiResponse) => {
      store.setState((s) => dismissUiRequest(s, response.id), true);
      const c = conn.current;
      if (!c) return;
      try {
        await c.client.respondUi(response);
      } catch (e) {
        fail(e);
      }
    },
    [store, fail],
  );

  /** 重新读取 Core 认得的模型与能力（模型渠道变化、打开模型列表时）；会话未打开时什么也不做 */
  const refreshModels = useCallback(() => {
    conn.current?.client.request("get_available_models").catch(() => {});
  }, []);

  const selectModel = useCallback(
    async (choice: { model?: string; thinkingLevel?: ThinkingLevel }): Promise<boolean> => {
      // 会话已有消息（或历史会话的历史尚未加载完）时模型锁定：只接受思考强度。
      // 同时请求模型与强度时强度照常应用，但返回 false，表示请求没有全部生效。
      const locked =
        store.getState().messages.length > 0 ||
        (Boolean(optionsRef.current.sessionPath) && !historyShown.current);
      const modelRejected = Boolean(choice.model) && locked;
      if (modelRejected) {
        if (!choice.thinkingLevel) return false;
        choice = { thinkingLevel: choice.thinkingLevel };
      }
      if (choice.thinkingLevel) preferredThinking.current = choice.thinkingLevel;
      const c = conn.current;
      if (!c) {
        setPendingModel((p) => ({ ...p, ...choice }));
        return !modelRejected;
      }
      try {
        if (choice.model) {
          const [provider, ...rest] = choice.model.split("/");
          const res = await c.client.request("set_model", {
            provider: provider ?? "",
            modelId: rest.join("/"),
          });
          if (!res.success) throw new Error(`${strings.chat.model.switchFailed}：${res.error}`);
          setPendingModel((p) => ({ ...p, model: undefined }));
        }
        // 换模型后 Core 只会把强度往下夹（换回支持思考的模型时仍是 off）：重新按想要的强度设置
        const level =
          choice.thinkingLevel ?? (choice.model ? preferredThinking.current : undefined);
        if (level) {
          const res = await c.client.request("set_thinking_level", { level });
          if (!res.success) throw new Error(`${strings.chat.model.switchFailed}：${res.error}`);
          setPendingModel((p) => ({ ...p, thinkingLevel: undefined }));
          // 用户亲自选的强度立即显示；随模型切换自动设置的等读回，免得不支持思考的模型先闪一下“中”
          if (choice.thinkingLevel)
            store.setState((s) => withModel(s, undefined, choice.thinkingLevel), true);
        }
        if (choice.model) await c.client.request("get_available_thinking_levels");
        // Core 会把强度夹到模型支持的范围内：读回实际生效的值
        if (level) await c.client.request("get_state");
        return !modelRejected;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [store, fail],
  );

  const abort = useCallback(async (): Promise<boolean> => {
    const c = conn.current;
    if (!c) {
      fail(new Error(strings.chat.sessionNotOpen));
      return false;
    }
    try {
      const res = await c.client.request("abort");
      return res.success;
    } catch (e) {
      fail(e);
      return false;
    }
  }, [fail]);

  const abortRetry = useCallback(async (): Promise<boolean> => {
    const c = conn.current;
    if (!c) return false;
    try {
      const res = await c.client.request("abort_retry");
      return res.success;
    } catch (e) {
      fail(e);
      return false;
    }
  }, [fail]);

  const refreshStats = useCallback(() => {
    conn.current?.client.request("get_session_stats").catch(() => {});
  }, []);

  const compact = useCallback(async (): Promise<boolean> => {
    const c = conn.current;
    if (!c) return false;
    try {
      const res = await c.client.request("compact");
      if (!res.success) throw new Error(`${strings.chat.contextCard.compactFailed}：${res.error}`);
      // 压缩后上下文占用未知（tokens 为 null），用量统计照常刷新
      await c.client.request("get_session_stats").catch(() => {});
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }, [fail]);

  // 自动压缩：先乐观更新 store（开关立即停在新位置），set_auto_compaction 失败再回滚到切换前的值。
  // 不再用 get_state 读回：成功响应即表示 Core 已写入设置（compaction.enabled，全局持久）
  const autoCompactionSeq = useRef(0);
  const setAutoCompaction = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      const c = conn.current;
      if (!c) return false;
      const previous = store.getState().autoCompaction;
      const seq = ++autoCompactionSeq.current;
      store.setState((s) => ({ ...s, autoCompaction: enabled }), true);
      try {
        const res = await c.client.request("set_auto_compaction", { enabled });
        if (!res.success)
          throw new Error(`${strings.chat.contextCard.autoCompactFailed}：${res.error}`);
        // 期间到达的旧 get_state 可能把值改回去：以最后一次成功的切换为准
        if (seq === autoCompactionSeq.current)
          store.setState((s) => ({ ...s, autoCompaction: enabled }), true);
        return true;
      } catch (e) {
        // 只回滚最后一次切换（连续切换时较早那次的失败不覆盖之后的选择）
        if (seq === autoCompactionSeq.current)
          store.setState((s) => ({ ...s, autoCompaction: previous }), true);
        fail(e);
        return false;
      }
    },
    [store, fail],
  );

  // 同步的重入保护（state 要到下一次渲染才生效）；restarting 只用于界面禁用按钮
  const restartingRef = useRef(false);
  const [restarting, setRestarting] = useState(false);
  const restart = useCallback(async () => {
    const c = conn.current;
    if (!c || restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    setError(undefined);
    try {
      await c.platform.coreRestart(c.client.sessionKey);
      // 旧进程上等待的命令不会再有响应；新进程按会话文件恢复后重建状态
      c.client.reset();
      statsCommandReady.current = null;
      lock.current.timeout = false;
      lock.current.stopped = false;
      // 新进程的权限模式回到默认：重新同步
      syncedMode.current = null;
      // 重建成功前不解除发送限制：失败时保留重建错误与“重启内核”入口
      const ok = await c.client.resync();
      if (ok) await syncMode(c.client).catch(() => {});
      lock.current.restart = !ok;
      // 新进程的扩展还没被请求过，不会主动推清单：重新预取一次
      if (ok) requestContextStats();
      syncUnresponsive();
    } catch (e) {
      // 重启失败时旧进程已结束、会话没有内核：保留重启入口，可再次重启
      if (!(e instanceof RpcClosedError)) {
        lock.current.stopped = true;
        syncUnresponsive();
      }
      fail(e);
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
  }, [setError, fail, syncUnresponsive, syncMode, requestContextStats]);

  return {
    state,
    error: error?.message,
    unresponsive,
    coreStopped,
    send,
    abort,
    abortRetry,
    restarting,
    restart,
    respondUi,
    selectModel,
    refreshModels,
    pendingModel,
    modelLocked: state.messages.length > 0 || (historyPath !== null && !historyReady),
    connected,
    refreshStats,
    requestContextStats,
    compact,
    setAutoCompaction,
  };
}
