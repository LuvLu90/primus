// RPC 记录与 primus:* 数据的 TS 类型定义（技术方案第 7 章、附录 A）。
// 字段与锁定版本的 Core RPC 文档逐项对照：agent-core/packages/coding-agent/docs/ 下的
// rpc.md、rpc-commands.md、json.md、rpc-extension-ui.md、message-types.md、session-format.md；
// 对照清单见本包 README.md，名称层面的覆盖由 coverage.test.ts 在 CI 中自动核对。
//
// 四类记录（rpc.md「Protocol records」）：
//   stdin  命令（commands.ts）          stdout 响应（responses.ts）
//   stdout 会话事件（events.ts）         双向  扩展 UI 记录（extension-ui.ts）

export * from "./commands.ts";
export * from "./content.ts";
export * from "./events.ts";
export * from "./extension-ui.ts";
export * from "./model.ts";
export * from "./primus-data.ts";
export * from "./responses.ts";
export * from "./session.ts";

import type { RpcCommand } from "./commands.ts";
import type { ExtensionErrorEvent, SessionEvent } from "./events.ts";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./extension-ui.ts";
import type { RpcResponse } from "./responses.ts";

// ---------- 链路上的记录 ----------

/** 前端写入 Core stdin 的一条记录 */
export type StdinRecord = RpcCommand | ExtensionUiResponse;

/**
 * Core stdout 的一条记录。Core 升级可能带来新的记录类型：消费方按 `type` 分派，
 * 在 default 分支忽略不认识的类型（薄壳原样透传，不做校验）。
 */
export type CoreRecord = RpcResponse | SessionEvent | ExtensionErrorEvent | ExtensionUiRequest;

export type CoreRecordType = CoreRecord["type"];

// ---------- 薄壳 → 前端：批次（第 7.3 节） ----------

export interface CoreBatch {
  sessionKey: string;
  /** 按会话单调递增；不连续时前端用 get_messages + get_state 重建 */
  seq: number;
  /** Core 输出的原始记录，薄壳不修改内容 */
  records: CoreRecord[];
  /** 薄壳缓冲溢出时丢弃的记录数；非零时同样需要重建 */
  dropped: number;
}

// ---------- 扩展 → 前端：primus:* 数据（第 6.6 节、附录 A） ----------

/** setWidget 的 widgetKey 前缀 */
export const PRIMUS_DATA_PREFIX = "primus:";

/** primus:* widget 数据的统一外壳；前端遇到不认识的 `v` 忽略并记日志 */
export interface PrimusData<T = unknown> {
  v: 1;
  type: string;
  data: T;
}
