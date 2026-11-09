// 左栏会话分组：有项目（工作区文件夹）的会话归到该项目下（可折叠），未选工作区的会话放在“最近”。
// 纯函数，把分组展开成一维行列表，交给虚拟列表渲染。
import type { SessionSummary } from "@/lib/platform/types";

/** 未选工作区时会话的默认工作目录 `…/users/<SID>/chat`（薄壳 sessions.rs 的 default_workspace_dir） */
const DEFAULT_WORKSPACE = /[\\/]users[\\/][^\\/]+[\\/]chat[\\/]*$/i;

/** 会话是否属于某个项目：工作区非空且不是未选工作区时的默认目录 */
export function isProjectWorkspace(workspace: string): boolean {
  return workspace.trim() !== "" && !DEFAULT_WORKSPACE.test(workspace);
}

/** 比较用的工作区键：统一斜杠、去掉末尾斜杠、不区分大小写（Windows 路径） */
export function workspaceKey(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 项目名：工作区路径的最后一段 */
export function workspaceName(workspace: string): string {
  const parts = workspace.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? workspace;
}

export type ListRow =
  | { kind: "header"; key: string; section: "projects" | "recent" }
  | { kind: "project"; key: string; workspace: string; name: string; expanded: boolean }
  | { kind: "session"; key: string; session: SessionSummary; nested: boolean };

export interface GroupOptions {
  /** “项目”分组是否展开 */
  projectsOpen: boolean;
  /** 用户手动展开 / 折叠过的项目（键为 workspaceKey） */
  toggled: Readonly<Record<string, boolean>>;
  /** 当前标签所在项目的键：默认展开 */
  activeKey?: string | null;
}

/**
 * 按项目分组并展开成行。会话已按最后活动时间倒序，项目顺序取其最新会话的位置。
 * 项目默认折叠，最近活动的项目与当前标签所在项目默认展开；用户切换过的以用户为准。
 */
export function buildRows(sessions: readonly SessionSummary[], options: GroupOptions): ListRow[] {
  const projects = new Map<string, { workspace: string; sessions: SessionSummary[] }>();
  const recent: SessionSummary[] = [];
  for (const s of sessions) {
    if (!isProjectWorkspace(s.workspace)) {
      recent.push(s);
      continue;
    }
    const key = workspaceKey(s.workspace);
    const group = projects.get(key);
    if (group) group.sessions.push(s);
    else projects.set(key, { workspace: s.workspace, sessions: [s] });
  }

  const rows: ListRow[] = [];
  if (projects.size > 0) {
    rows.push({ kind: "header", key: "h:projects", section: "projects" });
    if (options.projectsOpen) {
      let first = true;
      for (const [key, group] of projects) {
        const expanded = options.toggled[key] ?? (first || key === options.activeKey);
        first = false;
        rows.push({
          kind: "project",
          key: `p:${key}`,
          workspace: group.workspace,
          name: workspaceName(group.workspace),
          expanded,
        });
        if (expanded)
          for (const s of group.sessions)
            rows.push({ kind: "session", key: s.path, session: s, nested: true });
      }
    }
  }
  if (recent.length > 0) {
    if (projects.size > 0) rows.push({ kind: "header", key: "h:recent", section: "recent" });
    for (const s of recent) rows.push({ kind: "session", key: s.path, session: s, nested: false });
  }
  return rows;
}
