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
  /** 当前有效的信任状态：已信任且 `.primus/` 未变化 */
  trusted: boolean;
  /** 需要显示信任确认：从未确认过，或信任后 `.primus/` 已变化（第 17.2 节） */
  needsTrust: boolean;
}

/** 信任确认展示的项目内容（`workspace_inspect`，第 17.2 节） */
export interface TrustDetails {
  path: string;
  /** 根目录 AGENTS.md 的内容；不存在为 null */
  agentsMd: string | null;
  agentsMdTruncated: boolean;
  extensions: string[];
  skills: string[];
  mcpServers: string[];
  /** 此刻 `.primus/` 的内容指纹，信任时原样带回；内容过多或无法完整读取时为 null（不能信任） */
  fingerprint: string | null;
}

/** 会话索引中的一条会话（`session_list` / `session_search`，第 10.2 节、ADR 0006） */
export interface SessionSummary {
  /** 会话文件绝对路径：打开、删除、归档都用它 */
  path: string;
  id: string;
  /** 会话名；没有时显示 `title` */
  name: string | null;
  /** 首条用户消息（截断）；还没有用户消息时为空串 */
  title: string;
  /** 所属工作区（会话文件头的 cwd） */
  workspace: string;
  /** 创建时间（毫秒） */
  createdAt: number;
  /** 最后活动时间（毫秒） */
  updatedAt: number;
  messageCount: number;
  archived: boolean;
}

/** 会话索引变化的信号（`session_watch`）：`seq` 递增，收到后重新拉取列表 */
export interface SessionIndexEvent {
  seq: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface SessionHandle {
  sessionKey: string;
  /** 新会话的会话 ID（与 SessionSummary.id 对应）；恢复已有会话时为 null */
  sessionId?: string | null;
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
  /** 信任确认要展示的 AGENTS.md 与 `.primus/` 下的扩展、技能、MCP 配置 */
  workspaceInspect(path: string): Promise<TrustDetails>;
  /**
   * 记录信任确认的选择（“信任”或“不信任”都算已确认）。信任时传入 `workspaceInspect` 给出的指纹，
   * 内容在展示后有变化则拒绝
   */
  workspaceTrust(path: string, trusted: boolean, fingerprint?: string | null): Promise<void>;

  /** 系统文件夹对话框；取消时返回 null */
  dialogPickFolder(): Promise<string | null>;
  /** 系统文件对话框（可多选）；只返回本地路径，文件不复制 */
  dialogPickFiles(): Promise<string[]>;

  /**
   * 会话列表：最后活动时间倒序、每页 50 条、不含已归档。`workspace` 为 null 时列出全部工作区，
   * 空串为未选工作区的默认目录；`cursor` 为上一页的 `nextCursor`
   */
  sessionList(workspace: string | null, cursor?: string): Promise<Page<SessionSummary>>;
  /** 搜索会话（含已归档，最多 50 条）；3 个字符以上匹配消息全文，更短只匹配会话名与首条消息 */
  sessionSearch(workspace: string | null, query: string): Promise<SessionSummary[]>;
  /** 订阅会话索引变化；再次调用替换旧的订阅 */
  sessionWatch(onChange: (event: SessionIndexEvent) => void): Promise<void>;
  /** 分配或启动 Core 进程；`onBatch` 接收该会话的事件批次（第 7.3 节） */
  sessionOpen(
    workspace: string,
    sessionPath: string | undefined,
    onBatch: BatchListener,
  ): Promise<SessionHandle>;
  sessionClose(sessionKey: string): Promise<void>;
  /** 移到回收站并删除索引；打开中的会话以 code `sessionOpen` 拒绝 */
  sessionDelete(sessionPath: string): Promise<void>;
  /** 归档或取消归档（只改索引） */
  sessionArchive(sessionPath: string, archived: boolean): Promise<void>;

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

/** 删除会话的错误码：会话正在打开中，需先关闭 */
export const SESSION_OPEN = "sessionOpen";

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
  workspaceInspect: "workspace_inspect",
  workspaceTrust: "workspace_trust",
  dialogPickFolder: "dialog_pick_folder",
  dialogPickFiles: "dialog_pick_files",
  sessionList: "session_list",
  sessionSearch: "session_search",
  sessionWatch: "session_watch",
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
