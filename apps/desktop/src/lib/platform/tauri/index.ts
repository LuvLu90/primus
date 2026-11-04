import type { CoreBatch } from "@primus/protocol";
import { Channel, invoke } from "@tauri-apps/api/core";
import { COMMANDS, type Platform, type SessionIndexEvent, toPlatformError } from "../types";

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
    workspaceTrust: (path, trusted) => call("workspaceTrust", { path, trusted }),
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

    shellDetect: () => call("shellDetect"),
    fsTree: (workspace, path) => call("fsTree", { workspace, path }),
    fsRead: (workspace, path) => call("fsRead", { workspace, path }),
    gitStatus: (workspace) => call("gitStatus", { workspace }),
    gitDiff: (workspace, path) => call("gitDiff", { workspace, path }),

    terminalOpen: (cwd, onData) => {
      const channel = new Channel<string>();
      channel.onmessage = onData;
      return call("terminalOpen", { cwd, onData: channel });
    },
    terminalWrite: (terminalId, data) => call("terminalWrite", { terminalId, data }),
    terminalResize: (terminalId, cols, rows) => call("terminalResize", { terminalId, cols, rows }),
    terminalClose: (terminalId) => call("terminalClose", { terminalId }),

    openExternal: (target) => call("openExternal", { target }),
    storageUsage: () => call("storageUsage"),
    storageClean: (category) => call("storageClean", { category }),
    diagnosticsExport: (options) => call("diagnosticsExport", { options }),
    updateCheck: (channel) => call("updateCheck", { channel }),
    updateInstall: () => call("updateInstall"),
    logWrite: (level, message) => call("logWrite", { level, message }),
  };
}
