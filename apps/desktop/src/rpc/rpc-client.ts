import type {
  CoreBatch,
  CoreRecord,
  ExtensionUiResponse,
  RpcCommand,
  RpcCommandParams,
  RpcCommandType,
  RpcResponse,
  RpcResponseFor,
  StdinRecord,
} from "@primus/protocol";

// 前端 RPC 客户端（第 7 章）：一个会话一个实例，不依赖 React，便于单测。
// - 命令 id：`<sessionKey>-<自增序号>`（第 7.2 节），response 按 id 关联，不依赖顺序。
// - 超时：命令发出后 10 秒没有 response，判定“内核无响应”（第 7.5 节）。
// - seq 缺口：批次序号不连续或薄壳丢弃过记录时，自动发 get_messages + get_state 重建（第 7.3 节）。
//   重建结果本身也是普通 response 记录，按顺序交给会话 store 在原位置应用，保证与前后事件的先后关系。

/** 命令发出后等待 response 的上限（第 7.5 节） */
export const RESPONSE_TIMEOUT_MS = 10_000;

/**
 * 不设超时的命令：Core 在操作完成后才回 response，耗时取决于用户命令或模型调用，
 * 不能据此判断内核无响应（用户可用 abort_bash / abort 中断）。
 */
export const UNBOUNDED_COMMANDS: ReadonlySet<RpcCommandType> = new Set<RpcCommandType>([
  "bash",
  "compact",
]);

/**
 * 只用于展示的可选命令：超时只让调用方拿到 RpcTimeoutError，
 * 不判定内核无响应，也不参与“迟到响应即恢复”的跟踪（否则它的迟到响应会误解除别的命令造成的锁）。
 */
export const OPTIONAL_COMMANDS: ReadonlySet<RpcCommandType> = new Set<RpcCommandType>([
  "get_session_stats",
]);

/** 命令参数：没有必填字段的命令可以省略 */
export type OptionalParams<T extends RpcCommandType> =
  Partial<RpcCommandParams<T>> extends RpcCommandParams<T>
    ? [params?: RpcCommandParams<T>]
    : [params: RpcCommandParams<T>];

// 错误类只携带结构化字段，message 仅供日志与调试；界面文案由调用方用 strings 生成（AGENTS.md：文案集中管理）

export class RpcTimeoutError extends Error {
  constructor(
    readonly id: string,
    readonly command: RpcCommandType,
  ) {
    super(`RPC timeout: ${command} (${id})`);
    this.name = "RpcTimeoutError";
  }
}

/** 重建时 Core 对 get_messages / get_state 返回失败；`reason` 是 Core 给出的原因 */
export class RpcResponseError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`RPC ${command} failed: ${reason}`);
    this.name = "RpcResponseError";
  }
}

export class RpcClosedError extends Error {
  constructor(reason = "session closed") {
    super(reason);
    this.name = "RpcClosedError";
  }
}

export interface RpcClientOptions {
  sessionKey: string;
  /** 写入 Core stdin（platform.coreSend） */
  send: (record: StdinRecord) => Promise<void>;
  /** 去重后按顺序交付的记录；`gap` 表示这批之前有记录丢失，需要重建 */
  onRecords: (records: CoreRecord[], info: { gap: boolean }) => void;
  /** 有命令超时：内核无响应 */
  onUnresponsive?: (info: { id: string; command: RpcCommandType }) => void;
  /** 超时的命令后来收到了 response：内核恢复响应 */
  onResponsive?: () => void;
  /** 重建请求失败（发送失败、超时或 Core 返回失败） */
  onResyncError?: (error: unknown) => void;
  /** 重建完成：get_messages 与 get_state 均已成功 */
  onResynced?: () => void;
  timeoutMs?: number;
}

interface Pending {
  command: RpcCommandType;
  resolve: (response: RpcResponse) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  readonly sessionKey: string;
  private readonly options: RpcClientOptions;
  private readonly timeoutMs: number;
  private nextId = 1;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  /** 已超时、仍可能迟到的命令 id */
  private readonly timedOut = new Set<string>();
  private resyncing: Promise<boolean> | null = null;
  private resyncAgain = false;
  private closed = false;

  constructor(options: RpcClientOptions) {
    this.options = options;
    this.sessionKey = options.sessionKey;
    this.timeoutMs = options.timeoutMs ?? RESPONSE_TIMEOUT_MS;
  }

  /** 已处理的最后一个批次序号 */
  get lastSeq(): number {
    return this.seq;
  }

  /** 正在等待 response 的命令数 */
  get pendingCount(): number {
    return this.pending.size;
  }

  get isResyncing(): boolean {
    return this.resyncing !== null;
  }

  /** 生成下一个命令 id */
  newId(): string {
    return `${this.sessionKey}-${this.nextId++}`;
  }

  /**
   * 发送命令并等待同 id 的 response。失败响应（success: false）正常返回，由调用方判断；
   * 超时抛 RpcTimeoutError，会话关闭抛 RpcClosedError，写入 stdin 失败时抛出原错误。
   */
  request<T extends RpcCommandType>(
    type: T,
    ...[params]: OptionalParams<T>
  ): Promise<RpcResponseFor<T>> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const id = this.newId();
    const response = new Promise<RpcResponseFor<T>>((resolve, reject) => {
      const entry: Pending = {
        command: type,
        // response 按 id 关联到本条命令，因此其 command 必为 T（或失败响应）
        resolve: (r) => resolve(r as RpcResponseFor<T>),
        reject,
      };
      if (!UNBOUNDED_COMMANDS.has(type)) {
        entry.timer = setTimeout(() => this.timeout(id), this.timeoutMs);
      }
      this.pending.set(id, entry);
    });
    const record = { ...params, id, type } as RpcCommand;
    this.options.send(record).catch((error: unknown) => {
      // 写入失败：撤销等待，把原错误交给调用方
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    });
    return response;
  }

  /** 回复扩展 UI 对话框；Core 不会为它产生 response */
  respondUi(response: ExtensionUiResponse): Promise<void> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    return this.options.send(response);
  }

  /** 处理薄壳推来的一个批次 */
  receive(batch: CoreBatch): void {
    if (this.closed || batch.sessionKey !== this.sessionKey) return;
    // 重复或过期的批次
    if (batch.seq <= this.seq) return;
    const gap = batch.seq !== this.seq + 1 || batch.dropped > 0;
    this.seq = batch.seq;

    for (const record of batch.records) {
      if (record.type !== "response" || !record.id) continue;
      this.settle(record.id, record);
    }
    this.options.onRecords(batch.records, { gap });
    if (gap) void this.resync();
  }

  /**
   * 用 get_messages + get_state 重建会话状态。两条 response 随批次交给会话 store 应用；
   * 进行中再次发现缺口时，本轮结束后再重建一次。返回最后一轮是否成功（失败已回调 `onResyncError`）。
   */
  resync(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.resyncing) {
      this.resyncAgain = true;
      return this.resyncing;
    }
    this.resyncing = (async () => {
      let ok = false;
      do {
        this.resyncAgain = false;
        try {
          const [messages, state] = await Promise.all([
            this.request("get_messages"),
            this.request("get_state"),
          ]);
          for (const r of [messages, state])
            if (!r.success) throw new RpcResponseError(r.command, r.error);
          ok = true;
        } catch (error) {
          if (this.closed) return false;
          ok = false;
          // reset()（重启）中止的重建不算失败：重启方会随后再调 resync()，由下一轮给出结果
          if (!(error instanceof RpcClosedError)) this.options.onResyncError?.(error);
          // 本轮失败但期间又发现了缺口：仍为新缺口再重建一轮（第 7.3 节），否则等下一个缺口
        }
      } while (this.resyncAgain && !this.closed);
      if (this.closed) return false;
      if (ok) this.options.onResynced?.();
      return ok;
    })().finally(() => {
      this.resyncing = null;
    });
    return this.resyncing;
  }

  /**
   * 内核重启后调用：等待中的命令都不会再有 response，统一以 RpcClosedError 结束；
   * 之后的批次序号由薄壳决定，因此不重置 seq，由缺口检测兜底。
   */
  reset(reason = "core restarted"): void {
    this.rejectAll(new RpcClosedError(reason));
    this.timedOut.clear();
  }

  /** 会话关闭：拒绝所有等待中的命令，之后的批次与请求都被忽略 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new RpcClosedError());
    this.timedOut.clear();
  }

  private settle(id: string, response: RpcResponse): void {
    const entry = this.pending.get(id);
    if (entry) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(response);
      return;
    }
    // 任何迟到的 response 都说明内核仍在响应：其余超时命令的 response 可能随丢弃的批次永久丢失，
    // 不能等集合清空才解除无响应状态
    if (this.timedOut.delete(id)) {
      this.timedOut.clear();
      this.options.onResponsive?.();
    }
  }

  private timeout(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.reject(new RpcTimeoutError(id, entry.command));
    if (OPTIONAL_COMMANDS.has(entry.command)) return;
    this.timedOut.add(id);
    this.options.onUnresponsive?.({ id, command: entry.command });
  }

  private rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
