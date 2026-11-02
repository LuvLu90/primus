import type { CoreBatch, RpcCommand } from "@primus/protocol";

// 平台接口（附录 B 薄壳命令）。前端只依赖这里的类型，不直接依赖 Tauri。
// 返回值中细节尚未定稿的字段先用宽松类型，随对应模块落地再收紧。

export interface AppInfo {
  appVersion: string;
  coreVersion: string;
  dataDir: string;
  platform: string;
  /** 运行环境：真实薄壳或浏览器预览用的 mock */
  runtime: "tauri" | "mock";
}

export interface WorkspaceInfo {
  path: string;
  name: string;
  trusted: boolean;
}

export interface SessionSummary {
  path: string;
  name?: string;
  workspace: string;
  updatedAt: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface SessionHandle {
  sessionKey: string;
}

export type BatchListener = (batch: CoreBatch) => void;

/** 账号信息（第 9.7 节）。`builtin` 为内置测试账号（临时方案），接入账号服务后为 `service` */
export interface AccountInfo {
  id: string;
  name: string;
  kind: "builtin" | "service";
}

/** `auth_status` 的返回值 */
export interface AuthStatus {
  loggedIn: boolean;
  account: AccountInfo | null;
  /** 是否可以发起登录 / 登出；内置账号阶段为 false */
  loginAvailable: boolean;
}

/** 可选模型（第 9.5 节下拉框显示的字段）；`key` 为 `provider/modelId` */
export interface ModelSummary {
  key: string;
  provider: string;
  id: string;
  name: string;
  api: "openai-responses" | "anthropic-messages";
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** `models_get` / `models_refresh` / `models_set_default` 的返回值 */
export interface ModelsInfo {
  version: number | null;
  models: ModelSummary[];
  defaultModel: string | null;
  compactionModel: string | null;
  titleModel: string | null;
  /** 模型配置未能生效的原因；null 表示可以对话 */
  error: string | null;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Platform {
  appInfo(): Promise<AppInfo>;

  workspaceOpen(path: string): Promise<WorkspaceInfo>;
  workspaceList(): Promise<WorkspaceInfo[]>;
  workspaceTrust(path: string, trusted: boolean): Promise<void>;

  /** 系统文件夹对话框；取消时返回 null */
  dialogPickFolder(): Promise<string | null>;
  /** 系统文件对话框（可多选）；只返回本地路径，文件不复制 */
  dialogPickFiles(): Promise<string[]>;

  sessionList(workspace: string, cursor?: string): Promise<Page<SessionSummary>>;
  sessionSearch(workspace: string, query: string): Promise<SessionSummary[]>;
  /** 分配或启动 Core 进程；`onBatch` 接收该会话的事件批次（第 7.3 节） */
  sessionOpen(
    workspace: string,
    sessionPath: string | undefined,
    onBatch: BatchListener,
  ): Promise<SessionHandle>;
  sessionClose(sessionKey: string): Promise<void>;
  sessionDelete(sessionPath: string): Promise<void>;
  sessionArchive(sessionPath: string): Promise<void>;

  /** 写入 Core 的 stdin；响应与事件经 `sessionOpen` 的批次返回 */
  coreSend(sessionKey: string, record: RpcCommand | { type: string; id: string }): Promise<void>;
  coreRestart(sessionKey: string): Promise<void>;

  settingsGet(): Promise<Record<string, unknown>>;
  settingsSet(patch: Record<string, unknown>): Promise<void>;

  /** 账号状态；内置账号阶段恒为已登录 */
  authStatus(): Promise<AuthStatus>;
  /** 系统浏览器登录；内置账号阶段以 code `notAvailable` 拒绝 */
  authLogin(): Promise<AuthStatus>;
  /** 登出；内置账号阶段以 code `notAvailable` 拒绝 */
  authLogout(): Promise<void>;
  modelsGet(): Promise<ModelsInfo>;
  /** 重新获取并写入模型配置 */
  modelsRefresh(): Promise<ModelsInfo>;
  /** 改选默认模型（`provider/modelId`），新会话生效 */
  modelsSetDefault(model: string): Promise<ModelsInfo>;

  shellDetect(): Promise<unknown>;
  fsTree(workspace: string, path: string): Promise<FsEntry[]>;
  fsRead(workspace: string, path: string): Promise<string>;
  gitStatus(workspace: string): Promise<unknown>;
  gitDiff(workspace: string, path?: string): Promise<string>;

  terminalOpen(cwd: string, onData: (data: string) => void): Promise<{ terminalId: string }>;
  terminalWrite(terminalId: string, data: string): Promise<void>;
  terminalResize(terminalId: string, cols: number, rows: number): Promise<void>;
  terminalClose(terminalId: string): Promise<void>;

  openExternal(target: string): Promise<void>;
  storageUsage(): Promise<Record<string, number>>;
  storageClean(category: string): Promise<void>;
  diagnosticsExport(options?: Record<string, unknown>): Promise<string>;
  updateCheck(channel?: string): Promise<unknown>;
  updateInstall(): Promise<void>;
  logWrite(level: LogLevel, message: string): Promise<void>;
}

/** 账号命令错误码：功能尚未开放（内置账号阶段的登录 / 登出） */
export const AUTH_NOT_AVAILABLE = "notAvailable";

/** 会话命令错误码：会话的内核未运行（重启失败、因进程上限被淘汰或已自行退出），需重启内核 */
export const CORE_NOT_RUNNING = "coreNotRunning";

/** 薄壳命令返回的结构化错误（`{ code, message }`，见 core_send / core_restart）；code 供界面区分处理 */
export class PlatformError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
  }
}

/** 把命令的拒绝值转成 PlatformError：结构化错误带上 code；字符串等其他值原样返回 */
export function toPlatformError(e: unknown): unknown {
  if (typeof e === "object" && e !== null && !(e instanceof Error) && "message" in e) {
    const { message, code } = e as { message: unknown; code?: unknown };
    return new PlatformError(String(message), typeof code === "string" ? code : undefined);
  }
  return e;
}

/** Platform 方法名 → 薄壳命令名（附录 B）。tauri 实现按此表 invoke；测试用它核对覆盖面 */
export const COMMANDS = {
  appInfo: "app_info",
  workspaceOpen: "workspace_open",
  workspaceList: "workspace_list",
  workspaceTrust: "workspace_trust",
  dialogPickFolder: "dialog_pick_folder",
  dialogPickFiles: "dialog_pick_files",
  sessionList: "session_list",
  sessionSearch: "session_search",
  sessionOpen: "session_open",
  sessionClose: "session_close",
  sessionDelete: "session_delete",
  sessionArchive: "session_archive",
  coreSend: "core_send",
  coreRestart: "core_restart",
  settingsGet: "settings_get",
  settingsSet: "settings_set",
  authStatus: "auth_status",
  authLogin: "auth_login",
  authLogout: "auth_logout",
  modelsGet: "models_get",
  modelsRefresh: "models_refresh",
  modelsSetDefault: "models_set_default",
  shellDetect: "shell_detect",
  fsTree: "fs_tree",
  fsRead: "fs_read",
  gitStatus: "git_status",
  gitDiff: "git_diff",
  terminalOpen: "terminal_open",
  terminalWrite: "terminal_write",
  terminalResize: "terminal_resize",
  terminalClose: "terminal_close",
  openExternal: "open_external",
  storageUsage: "storage_usage",
  storageClean: "storage_clean",
  diagnosticsExport: "diagnostics_export",
  updateCheck: "update_check",
  updateInstall: "update_install",
  logWrite: "log_write",
} as const satisfies Record<keyof Platform, string>;
