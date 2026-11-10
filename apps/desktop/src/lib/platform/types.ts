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

/** 账号信息（第 9.7 节）；账号服务接入后提供 */
export interface AccountInfo {
  id: string;
  name: string;
  kind: "service";
}

/** `auth_status` 的返回值；账号服务接入前恒为未登录、不可登录 */
export interface AuthStatus {
  loggedIn: boolean;
  account: AccountInfo | null;
  /** 是否可以发起登录 / 登出；账号服务接入前为 false */
  loginAvailable: boolean;
}

/** 模型端点协议（约束 C1：只有这两种） */
export type ProviderApi = "openai-responses" | "anthropic-messages";

/** 可选模型（第 9.5 节下拉框显示的字段）；`key` 为 `<渠道 ID>/<模型 ID>`，`provider` 为渠道 ID */
export interface ModelSummary {
  key: string;
  provider: string;
  id: string;
  name: string;
  api: ProviderApi;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
}

/**
 * 渠道下的一个模型（`provider_save` 的 `models` 项，也是 `provider_fetch_models` 的返回项）。
 * 薄壳严格校验字段：不得带多余字段
 */
export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** 必须含 `text`；支持图片时再含 `image` */
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

/** 模型渠道（`providers_list`）；密钥不会返回，只有是否已保存与末 4 位 */
export interface ProviderView {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  enabled: boolean;
  models: ProviderModel[];
  hasKey: boolean;
  /** 密钥末 4 位；没有密钥或密钥太短时为 null */
  keyHint: string | null;
}

/** `provider_save` 的参数：无 `id` 为新建（必须带 `apiKey`）；有 `id` 为修改，`apiKey` 缺省保留已存密钥 */
export interface ProviderSaveInput {
  id?: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  models: ProviderModel[];
}

/** `provider_fetch_models` 的参数：有 `id` 时用已保存的渠道，提供的字段覆盖之；无 `id` 时三项必填 */
export interface ProviderFetchInput {
  id?: string;
  api?: ProviderApi;
  baseUrl?: string;
  apiKey?: string;
}

/** `provider_save` / `provider_delete` 的返回值 */
export interface ProvidersChanged {
  providers: ProviderView[];
  models: ModelsInfo;
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

/** 更新通道（第 18 章“更新”分组） */
export type UpdateChannel = "stable" | "beta";

/** 更新设置（`users/<SID>/app/update.json`）：自动更新默认开、稳定版 */
export interface UpdateSettings {
  autoUpdate: boolean;
  channel: UpdateChannel;
}

export type UpdatePhase = "idle" | "checking" | "downloading" | "installing";

/** `update_status` 的返回值，也是 `update_watch` 推送的内容（第 3.6 节、ADR 0007） */
export interface UpdateStatus {
  currentVersion: string;
  /** 是否可以自动更新：发布构建编译进了更新公钥、Windows、架构受支持 */
  available: boolean;
  settings: UpdateSettings;
  phase: UpdatePhase;
  /** 下载进度（字节）；不在下载时为 null */
  progress: { downloaded: number; total: number | null } | null;
  /** 已下载并校验、等待安装的版本 */
  pending: { version: string; notes: string | null } | null;
  /** 上次检查完成的时间（毫秒） */
  lastCheck: number | null;
  /** 上次检查或下载失败的原因；自动检查失败不弹提示，只在设置页显示 */
  lastError: string | null;
}

/** 工作区所在 Git 仓库的当前分支（`git_branch`）；分离 HEAD 时 `name` 为短 SHA */
export interface GitBranch {
  name: string;
  detached: boolean;
}

/** 输入框图片附件（`attachment_image`）：在内存中缩小并编码，不写任何文件（约束 C2） */
export interface AttachmentImage {
  /** `image/png` 或 `image/jpeg` */
  mimeType: string;
  /** 缩小后图片的 base64（不含 data: 前缀），直接放进 prompt 的 `images` */
  data: string;
  /** 缩略图 data URL（短边约 112px），只用于图块显示 */
  thumb: string;
  width: number;
  height: number;
}

/** 语音输入被系统隐私设置拒绝时可以打开的设置页 */
export type SpeechSettingsPage = "microphone" | "speech";

/**
 * 语音输入事件（`speech_start` 的 Channel）。`interim` 为当前这一句的临时文本（随时替换），`final` 为定稿；
 * `level`（0–1）只有浏览器预览的 mock 会推送，真实薄壳的音量由前端 getUserMedia 计算
 */
export type SpeechEvent =
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "level"; level: number }
  /** settings：能解决这个错误的系统设置页（隐私 → 麦克风 / 语音），前端提供“打开设置” */
  | { type: "error"; message: string; settings?: SpeechSettingsPage }
  | { type: "end" };

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
  /** 未选工作区时会话的默认工作目录（完整路径） */
  sessionDefaultWorkspace(): Promise<string>;
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
  /** 永久删除会话文件（不进回收站）并删除索引；打开中的会话先结束其 Core 再删除 */
  sessionDelete(sessionPath: string): Promise<void>;
  /** 归档或取消归档（只改索引） */
  sessionArchive(sessionPath: string, archived: boolean): Promise<void>;

  /** 写入 Core 的 stdin；响应与事件经 `sessionOpen` 的批次返回 */
  coreSend(sessionKey: string, record: RpcCommand | { type: string; id: string }): Promise<void>;
  coreRestart(sessionKey: string): Promise<void>;

  settingsGet(): Promise<Record<string, unknown>>;
  settingsSet(patch: Record<string, unknown>): Promise<void>;

  /** 账号状态；账号服务接入前恒为未登录 */
  authStatus(): Promise<AuthStatus>;
  /** 系统浏览器登录；账号服务接入前以 code `notAvailable` 拒绝 */
  authLogin(): Promise<AuthStatus>;
  /** 登出；账号服务接入前以 code `notAvailable` 拒绝 */
  authLogout(): Promise<void>;
  modelsGet(): Promise<ModelsInfo>;
  /** 按已保存的渠道重写模型配置（不联网） */
  modelsRefresh(): Promise<ModelsInfo>;
  /** 改选默认模型（`<渠道 ID>/<模型 ID>`），新会话生效 */
  modelsSetDefault(model: string): Promise<ModelsInfo>;
  /** 订阅模型配置变化（保存 / 删除渠道、刷新、改默认、启动后台获取成功）；再次调用替换旧的订阅 */
  modelsWatch(onChange: (info: ModelsInfo) => void): Promise<void>;
  /** 全部模型渠道 */
  providersList(): Promise<ProviderView[]>;
  /** 新建或修改渠道，保存后重写模型配置 */
  providerSave(input: ProviderSaveInput): Promise<ProvidersChanged>;
  /** 删除渠道（连同其密钥） */
  providerDelete(id: string): Promise<ProvidersChanged>;
  /** 向渠道获取模型列表（不保存）；已保存的模型保留用户改过的参数 */
  providerFetchModels(input: ProviderFetchInput): Promise<ProviderModel[]>;

  shellDetect(): Promise<unknown>;
  fsTree(workspace: string, path: string): Promise<FsEntry[]>;
  fsRead(workspace: string, path: string): Promise<string>;
  gitStatus(workspace: string): Promise<unknown>;
  gitDiff(workspace: string, path?: string): Promise<string>;
  /** 当前分支（只读）；不是 Git 仓库时为 null */
  gitBranch(workspace: string): Promise<GitBranch | null>;

  /**
   * 读取图片附件：按最长边 `maxEdge` 在内存中缩小并编码，附带缩略图。
   * 不是图片、超过 20 MB 或解码失败时拒绝（错误文案可直接显示）
   */
  attachmentImage(path: string, maxEdge: number): Promise<AttachmentImage>;

  /** 系统语音识别是否可用（不可用时隐藏麦克风按钮） */
  speechAvailable(): Promise<boolean>;
  /** 开始听写；事件经回调推送，最后一定有 `end`。再次调用先结束旧的会话 */
  speechStart(onEvent: (event: SpeechEvent) => void): Promise<void>;
  /** 停止听写（之后推送 `end`） */
  speechStop(): Promise<void>;

  terminalOpen(cwd: string, onData: (data: string) => void): Promise<{ terminalId: string }>;
  terminalWrite(terminalId: string, data: string): Promise<void>;
  terminalResize(terminalId: string, cols: number, rows: number): Promise<void>;
  terminalClose(terminalId: string): Promise<void>;

  openExternal(target: string): Promise<void>;
  /**
   * 用系统默认程序打开本机文件或文件夹（回复里的文件引用）。只接受已存在的绝对路径（可用 `~/`）；
   * 网址、网络路径会被拒绝（错误文案可直接显示）。可执行与脚本类文件不直接运行，改为在文件夹中显示并返回 `revealed`
   */
  openPath(path: string): Promise<OpenPathOutcome>;
  /** 在系统文件管理器中显示并选中文件或文件夹；校验同 `openPath` */
  revealPath(path: string): Promise<void>;
  /** 右栏预览本机文件：校验同 `openPath`，只读，最多 1 MiB；二进制文件不返回内容（图片走 `attachmentImage`） */
  previewFile(path: string): Promise<FilePreview>;
  /**
   * 右栏按“打开后的样子”预览 Word / PowerPoint / Excel / PDF：读取整份文件字节（校验同 `openPath`，只接受
   * docx / pptx / xlsx / xlsm / pdf，
   * 最多 30 MiB，超过时报错，错误文案可直接显示）
   */
  previewFileBytes(path: string): Promise<ArrayBuffer>;
  storageUsage(): Promise<Record<string, number>>;
  storageClean(category: string): Promise<void>;
  diagnosticsExport(options?: Record<string, unknown>): Promise<string>;
  /** 自动更新状态 */
  updateStatus(): Promise<UpdateStatus>;
  /** 订阅更新状态（注册后立即推送一次）；再次调用替换旧的订阅 */
  updateWatch(onChange: (status: UpdateStatus) => void): Promise<void>;
  /** 立即检查；有更高版本时下载并校验，返回检查后的状态。`channel` 只用于本次检查 */
  updateCheck(channel?: UpdateChannel): Promise<UpdateStatus>;
  /** 修改更新设置（自动更新开关、通道） */
  updateSettingsSet(patch: Partial<UpdateSettings>): Promise<UpdateStatus>;
  /**
   * 立即重启并安装已下载的更新（成功时 App 退出）。有运行中的 Agent 时以 code `busy` 拒绝，
   * 用户确认后带 `force` 再调；用户取消管理员授权时以 code `cancelled` 拒绝（更新包保留）
   */
  updateInstall(force?: boolean): Promise<void>;
  logWrite(level: LogLevel, message: string): Promise<void>;
}

/** `previewFile` 的结果 */
export type FilePreview =
  | { kind: "text"; text: string; truncated: boolean; size: number }
  | { kind: "binary"; size: number };

/** `openPath` 的结果：已打开，或因是可执行 / 脚本文件改为在文件夹中显示 */
export type OpenPathOutcome = "opened" | "revealed";

/** 账号命令错误码：功能尚未开放（账号服务接入前的登录 / 登出） */
export const AUTH_NOT_AVAILABLE = "notAvailable";

/** 更新命令错误码：有正在运行的 Agent，需要用户确认后带 force 重试 */
export const UPDATE_BUSY = "busy";
/** 更新命令错误码：用户取消了管理员授权（更新包保留，下次启动再装） */
export const UPDATE_CANCELLED = "cancelled";

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
  workspaceInspect: "workspace_inspect",
  workspaceTrust: "workspace_trust",
  dialogPickFolder: "dialog_pick_folder",
  dialogPickFiles: "dialog_pick_files",
  sessionDefaultWorkspace: "session_default_workspace",
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
  modelsWatch: "models_watch",
  providersList: "providers_list",
  providerSave: "provider_save",
  providerDelete: "provider_delete",
  providerFetchModels: "provider_fetch_models",
  shellDetect: "shell_detect",
  fsTree: "fs_tree",
  fsRead: "fs_read",
  gitStatus: "git_status",
  gitDiff: "git_diff",
  gitBranch: "git_branch",
  attachmentImage: "attachment_image",
  speechAvailable: "speech_available",
  speechStart: "speech_start",
  speechStop: "speech_stop",
  terminalOpen: "terminal_open",
  terminalWrite: "terminal_write",
  terminalResize: "terminal_resize",
  terminalClose: "terminal_close",
  openExternal: "open_external",
  openPath: "open_path",
  revealPath: "reveal_path",
  previewFile: "preview_file",
  previewFileBytes: "preview_file_bytes",
  storageUsage: "storage_usage",
  storageClean: "storage_clean",
  diagnosticsExport: "diagnostics_export",
  updateStatus: "update_status",
  updateWatch: "update_watch",
  updateCheck: "update_check",
  updateSettingsSet: "update_settings_set",
  updateInstall: "update_install",
  logWrite: "log_write",
} as const satisfies Record<keyof Platform, string>;
