"use client";

import type { CoreBatch, ExtensionUiResponse, ThinkingLevel } from "@primus/protocol";
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
  /** 发送成功返回 true；失败时设置 error 并返回 false */
  send: (message: string) => Promise<boolean>;
  /** abort 成功（Core 已回成功响应）返回 true；失败时设置 error 并返回 false */
  abort: () => Promise<boolean>;
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
  // Core 里当前生效的权限模式（新进程默认“每次询问”，打开或重启后重新同步）
  const syncedMode = useRef<PermissionMode | null>(null);
  const [pendingModel, setPendingModel] = useState<{
    model?: string;
    thinkingLevel?: ThinkingLevel;
  }>({});
  const pendingModelRef = useRef(pendingModel);
  pendingModelRef.current = pendingModel;

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
      const { model, thinkingLevel } = pendingModelRef.current;
      const [provider, ...rest] = model?.split("/") ?? [];
      setPendingModel({});
      // 失败响应同样报错（由调用方提示）；按钮随后按 get_state 显示 Core 实际使用的模型
      const failures: string[] = [];
      if (provider && rest.length > 0) {
        const res = await client.request("set_model", { provider, modelId: rest.join("/") });
        if (!res.success) failures.push(res.error || "set_model");
      }
      if (thinkingLevel) {
        const res = await client.request("set_thinking_level", { level: thinkingLevel });
        if (!res.success) failures.push(res.error || "set_thinking_level");
      }
      await syncMode(client);
      await Promise.all([
        client.request("get_state"),
        client.request("get_available_thinking_levels"),
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
            if (resyncFailures.current === failures) clearError("resync");
          });
        },
      });
      for (const batch of early) client.receive(batch);
      conn.current = { platform, client };
      syncedMode.current = null;
      optionsRef.current.onOpening?.(false);
      optionsRef.current.onOpened?.({ sessionId: sessionId ?? null, workspace: path });
      // 会话已建立：打开后的设置失败不影响会话本身（提示错误；权限模式在下一次发送前会再同步）
      await applySession(client).catch(fail);
    })().finally(() => {
      opening.current = null;
      // 失败时也结束“打开中”（成功时已在 onOpened 之前结束，重复调用无影响）
      if (!disposed.current) optionsRef.current.onOpening?.(false);
    });
    return opening.current;
  }, [enqueue, setError, clearError, syncUnresponsive, applySession, fail]);

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
    async (message: string): Promise<boolean> => {
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
        // 权限模式没能在打开时同步（如当时失败）：发送前再同步一次，确保按界面上的模式审批
        await syncMode(c.client);
        const res = await c.client.request("prompt", { message });
        return res.success;
      } catch (e) {
        // 超时时 Core 可能已受理（它不按 id 去重）：保留草稿，但由界面在内核恢复或重启前禁止重发
        fail(e);
        return false;
      }
    },
    [ensureOpen, loadHistory, fail, syncMode],
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

  const selectModel = useCallback(
    async (choice: { model?: string; thinkingLevel?: ThinkingLevel }): Promise<boolean> => {
      const c = conn.current;
      if (!c) {
        setPendingModel((p) => ({ ...p, ...choice }));
        return true;
      }
      try {
        if (choice.model) {
          const [provider, ...rest] = choice.model.split("/");
          const res = await c.client.request("set_model", {
            provider: provider ?? "",
            modelId: rest.join("/"),
          });
          if (!res.success) throw new Error(`${strings.chat.model.switchFailed}：${res.error}`);
          await c.client.request("get_available_thinking_levels");
        }
        if (choice.thinkingLevel) {
          const res = await c.client.request("set_thinking_level", { level: choice.thinkingLevel });
          if (!res.success) throw new Error(`${strings.chat.model.switchFailed}：${res.error}`);
          store.setState((s) => withModel(s, undefined, choice.thinkingLevel), true);
          // Core 会把强度夹到模型支持的范围内：读回实际生效的值
          await c.client.request("get_state");
        }
        return true;
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
      lock.current.timeout = false;
      lock.current.stopped = false;
      // 新进程的权限模式回到默认：重新同步
      syncedMode.current = null;
      // 重建成功前不解除发送限制：失败时保留重建错误与“重启内核”入口
      const ok = await c.client.resync();
      if (ok) await syncMode(c.client).catch(() => {});
      lock.current.restart = !ok;
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
  }, [setError, fail, syncUnresponsive, syncMode]);

  return {
    state,
    error: error?.message,
    unresponsive,
    coreStopped,
    send,
    abort,
    restarting,
    restart,
    respondUi,
    selectModel,
    pendingModel,
  };
}
