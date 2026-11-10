import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// 左栏会话列表的界面偏好（第 16.2 节）：分组与项目的展开状态、置顶、显示名称、已移除的项目。
// 只影响左栏怎么显示，不改会话文件与工作区；存 localStorage（与外观设置一样），
// skipHydration 避免静态预渲染与客户端首帧不一致，由 SessionList 挂载后恢复。
// 项目一律以 workspaceKey（统一斜杠、不分大小写）为键。

export interface SessionListPrefs {
  /** “项目”分组是否展开 */
  projectsOpen: boolean;
  /** 用户手动展开 / 折叠过的项目 */
  expanded: Record<string, boolean>;
  /** 置顶的项目，最近置顶的在前 */
  pinned: string[];
  /** 用户改过的项目显示名称 */
  names: Record<string, string>;
  /**
   * 从列表移除的项目 → 移除时间（ms）。该项目在这之后没有新活动的会话就不显示；
   * 之后又在里面对话（会话更新时间晚于移除时间）时重新出现。会话本身不删除，仍可搜索到。
   */
  removed: Record<string, number>;
}

export interface SessionListPrefsState extends SessionListPrefs {
  setProjectsOpen: (open: boolean) => void;
  setExpanded: (key: string, expanded: boolean) => void;
  togglePinned: (key: string) => void;
  /** 空名称恢复为文件夹名 */
  rename: (key: string, name: string) => void;
  /** 移除项目：同时取消置顶 */
  remove: (key: string, at: number) => void;
}

/** 显示名称上限（字符） */
export const PROJECT_NAME_MAX = 80;

export const initialSessionListPrefs: SessionListPrefs = {
  projectsOpen: true,
  expanded: {},
  pinned: [],
  names: {},
  removed: {},
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function pick<T>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) if (ok(x)) out[k] = x;
  return out;
}

/** 从本地存储读出的数据只保留类型正确的字段 */
export function sanitizePrefs(v: unknown): Partial<SessionListPrefs> {
  if (!isRecord(v)) return {};
  const out: Partial<SessionListPrefs> = {
    expanded: pick(v.expanded, (x): x is boolean => typeof x === "boolean"),
    names: pick(v.names, (x): x is string => typeof x === "string" && x.trim() !== ""),
    removed: pick(v.removed, (x): x is number => typeof x === "number" && Number.isFinite(x)),
    pinned: Array.isArray(v.pinned)
      ? [...new Set(v.pinned.filter((x): x is string => typeof x === "string"))]
      : [],
  };
  if (typeof v.projectsOpen === "boolean") out.projectsOpen = v.projectsOpen;
  return out;
}

export const useSessionListPrefs = create<SessionListPrefsState>()(
  persist(
    (set) => ({
      ...initialSessionListPrefs,
      setProjectsOpen: (projectsOpen) => set({ projectsOpen }),
      setExpanded: (key, value) => set((s) => ({ expanded: { ...s.expanded, [key]: value } })),
      togglePinned: (key) =>
        set((s) => ({
          pinned: s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [key, ...s.pinned],
        })),
      rename: (key, name) =>
        set((s) => {
          const names = { ...s.names };
          const trimmed = [...name.trim()].slice(0, PROJECT_NAME_MAX).join("");
          if (trimmed) names[key] = trimmed;
          else delete names[key];
          return { names };
        }),
      remove: (key, at) =>
        set((s) => ({
          removed: { ...s.removed, [key]: at },
          pinned: s.pinned.filter((k) => k !== key),
        })),
    }),
    {
      name: "primus.sessionList",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: ({ projectsOpen, expanded, pinned, names, removed }) => ({
        projectsOpen,
        expanded,
        pinned,
        names,
        removed,
      }),
      // 本地存储可能被改坏：类型不对的字段丢掉，用默认值
      merge: (persisted, current) => ({ ...current, ...sanitizePrefs(persisted) }),
    },
  ),
);
