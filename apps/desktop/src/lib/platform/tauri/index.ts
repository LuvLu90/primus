import type { CoreBatch } from "@primus/protocol";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  COMMANDS,
  type ModelsInfo,
  type Platform,
  type SessionIndexEvent,
  type SpeechEvent,
  toPlatformError,
  type UpdateStatus,
} from "../types";

/** 去掉值为 undefined 的键：薄壳严格校验字段，缺省的可选字段不传 */
function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// 真实实现：逐个映射到薄壳命令（附录 B）。参数名用 camelCase，Tauri 会转换为 Rust 端的 snake_case。
// 会话事件与终端输出经 Channel 推送（第 7.1 节）。
export function createTauriPlatform(): Platform {
  // 结构化错误（{ code, message }）转成 PlatformError，界面据 code 区分处理
  const call = <T>(name: keyof Platform, args?: Record<string, unknown>) =>
    invoke<T>(COMMANDS[name], args).catch((e: unknown) => {
      throw toPlatformError(e);
    });

  return {
    appInfo: async () => ({ ...(await call("appInfo")), runtime: "tauri" }),

    workspaceOpen: (path) => call("workspaceOpen", { path }),
    workspaceList: () => call("workspaceList"),
    workspaceInspect: (path) => call("workspaceInspect", { path }),
    workspaceTrust: (path, trusted, fingerprint) =>
      call("workspaceTrust", { path, trusted, fingerprint: fingerprint ?? null }),
    dialogPickFolder: () => call("dialogPickFolder"),
    dialogPickFiles: () => call("dialogPickFiles"),

    sessionList: (workspace, cursor) => call("sessionList", { workspace, cursor }),
    sessionSearch: (workspace, query) => call("sessionSearch", { workspace, query }),
    sessionWatch: (onChange) => {
      const channel = new Channel<SessionIndexEvent>();
      channel.onmessage = onChange;
      return call("sessionWatch", { onEvent: channel });
    },
    sessionOpen: (workspace, sessionPath, onBatch) => {
      const channel = new Channel<CoreBatch>();
      channel.onmessage = onBatch;
      return call("sessionOpen", { workspace, sessionPath, onEvent: channel });
    },
    sessionClose: (sessionKey) => call("sessionClose", { sessionKey }),
    sessionDelete: (sessionPath) => call("sessionDelete", { sessionPath }),
    sessionArchive: (sessionPath, archived) => call("sessionArchive", { sessionPath, archived }),

    coreSend: (sessionKey, record) => call("coreSend", { sessionKey, record }),
    coreRestart: (sessionKey) => call("coreRestart", { sessionKey }),

    settingsGet: () => call("settingsGet"),
    settingsSet: (patch) => call("settingsSet", { patch }),

    authStatus: () => call("authStatus"),
    authLogin: () => call("authLogin"),
    authLogout: () => call("authLogout"),
    modelsGet: () => call("modelsGet"),
    modelsRefresh: () => call("modelsRefresh"),
    modelsSetDefault: (model) => call("modelsSetDefault", { model }),
    modelsWatch: (onChange) => {
      const channel = new Channel<ModelsInfo>();
      channel.onmessage = onChange;
      return call("modelsWatch", { onEvent: channel });
    },
    providersList: () => call("providersList"),
    // 薄壳严格校验字段：只传契约里的字段，缺省的可选字段不传
    providerSave: (input) =>
      call("providerSave", {
        input: defined({
          id: input.id,
          name: input.name,
          api: input.api,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          enabled: input.enabled,
          models: input.models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.reasoning,
            input: m.input,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
          })),
        }),
      }),
    providerDelete: (id) => call("providerDelete", { id }),
    providerFetchModels: (input) =>
      call("providerFetchModels", {
        input: defined({
          id: input.id,
          api: input.api,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
        }),
      }),

    shellDetect: () => call("shellDetect"),
    fsTree: (workspace, path) => call("fsTree", { workspace, path }),
    fsRead: (workspace, path) => call("fsRead", { workspace, path }),
    gitStatus: (workspace) => call("gitStatus", { workspace }),
    gitDiff: (workspace, path) => call("gitDiff", { workspace, path }),
    gitBranch: (workspace) => call("gitBranch", { workspace }),
    attachmentImage: (path, maxEdge) => call("attachmentImage", { path, maxEdge }),
    speechAvailable: () => call("speechAvailable"),
    speechStart: (onEvent) => {
      const channel = new Channel<SpeechEvent>();
      channel.onmessage = onEvent;
      return call("speechStart", { onEvent: channel });
    },
    speechStop: () => call("speechStop"),

    terminalOpen: (cwd, onData) => {
      const channel = new Channel<string>();
      channel.onmessage = onData;
      return call("terminalOpen", { cwd, onData: channel });
    },
    terminalWrite: (terminalId, data) => call("terminalWrite", { terminalId, data }),
    terminalResize: (terminalId, cols, rows) => call("terminalResize", { terminalId, cols, rows }),
    terminalClose: (terminalId) => call("terminalClose", { terminalId }),

    openExternal: (target) => call("openExternal", { target }),
    openPath: (path) => call("openPath", { path }),
    revealPath: (path) => call("revealPath", { path }),
    previewFile: (path) => call("previewFile", { path }),
    storageUsage: () => call("storageUsage"),
    storageClean: (category) => call("storageClean", { category }),
    diagnosticsExport: (options) => call("diagnosticsExport", { options }),
    updateStatus: () => call("updateStatus"),
    updateWatch: (onChange) => {
      const channel = new Channel<UpdateStatus>();
      channel.onmessage = onChange;
      return call("updateWatch", { onEvent: channel });
    },
    updateCheck: (channel) => call("updateCheck", { channel: channel ?? null }),
    updateSettingsSet: (patch) =>
      call("updateSettingsSet", {
        autoUpdate: patch.autoUpdate ?? null,
        channel: patch.channel ?? null,
      }),
    updateInstall: (force) => call("updateInstall", { force: force ?? false }),
    logWrite: (level, message) => call("logWrite", { level, message }),
  };
}
