import { create } from "zustand";
import {
  getPlatform,
  PlatformError,
  UPDATE_BUSY,
  type UpdateSettings,
  type UpdateStatus,
} from "@/lib/platform";

// 自动更新状态（第 3.6 节、ADR 0007）。薄壳的 update_watch 只保留一个订阅，所以由这里统一订阅一次，
// 重启提示与设置页都读这个 store。

/** 立即重启更新的结果：started（App 即将退出）、busy（有运行中的 Agent，需确认后 force 再试）、error */
export type InstallResult =
  | { kind: "started" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

export interface UpdateState {
  status: UpdateStatus | null;
  /** 读取或订阅失败的原因 */
  loadError: string | null;
  /** 用户选择“下次启动时更新”的版本：本次运行不再弹提示 */
  dismissedVersion: string | null;
  /** 开始订阅（多次调用只订阅一次） */
  start: () => Promise<void>;
  check: () => Promise<UpdateStatus>;
  setSettings: (patch: Partial<UpdateSettings>) => Promise<void>;
  install: (force?: boolean) => Promise<InstallResult>;
  dismiss: (version: string) => void;
}

let started: Promise<void> | undefined;

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : typeof e === "string" ? e : fallback;
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  status: null,
  loadError: null,
  dismissedVersion: null,
  start: () => {
    started ??= getPlatform()
      .then((p) => p.updateWatch((status) => set({ status, loadError: null })))
      .catch((e: unknown) => {
        started = undefined;
        set({ loadError: message(e, "") });
      });
    return started;
  },
  check: async () => {
    const status = await (await getPlatform()).updateCheck();
    set({ status });
    return status;
  },
  setSettings: async (patch) => {
    const status = await (await getPlatform()).updateSettingsSet(patch);
    set({ status });
  },
  install: async (force) => {
    try {
      await (await getPlatform()).updateInstall(force);
      return { kind: "started" };
    } catch (e) {
      if (e instanceof PlatformError && e.code === UPDATE_BUSY) return { kind: "busy" };
      return { kind: "error", message: message(e, "") };
    }
  },
  dismiss: (version) => set({ dismissedVersion: version }),
}));

/** 仅测试用：重置 store 与订阅 */
export function resetUpdateStoreForTesting(): void {
  started = undefined;
  useUpdateStore.setState({ status: null, loadError: null, dismissedVersion: null });
}
