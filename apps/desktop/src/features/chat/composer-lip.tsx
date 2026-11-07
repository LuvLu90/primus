"use client";

// 输入框上沿后面的“唇条”：一条灰色小舌，显示当前 Git 分支与工作区（工作区选择从底栏移到这里，功能不变）。
// 不是 Git 仓库时不显示分支；会话开始后工作区锁定，只显示名称。
import { Folder, FolderOpen, GitBranch, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getPlatform } from "@/lib/platform";
import type { GitBranch as Branch, WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { WorkspacePicker } from "./composer-menus";

const t = strings.chat;

/** 工作区所在仓库的当前分支；路径变化时重新读取，迟到的旧结果丢弃 */
function useGitBranch(path: string | null): Branch | null {
  const [branch, setBranch] = useState<{ path: string; value: Branch | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    getPlatform()
      .then((p) => p.gitBranch(path))
      .then((value) => !cancelled && setBranch({ path, value }))
      .catch(() => !cancelled && setBranch({ path, value: null }));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return path && branch?.path === path ? branch.value : null;
}

export function ComposerLip({
  workspace,
  locked,
  onPicked,
  onClear,
  onError,
}: {
  workspace: WorkspaceInfo | null;
  /** 会话已开始：工作区不能再切换 */
  locked: boolean;
  onPicked: (ws: WorkspaceInfo) => void;
  onClear: () => void;
  onError: (message: string | null) => void;
}) {
  const branch = useGitBranch(workspace?.path ?? null);
  if (!workspace && locked) return null;
  const item = "lip-item-in flex min-w-0 items-center gap-1.5";
  return (
    <div className="composer-lip mx-3.5 -mb-3 flex h-11 items-center gap-4 rounded-t-2xl bg-lip px-3.5 pb-3 text-[12px] text-muted shadow-[inset_0_0_0_1px_var(--color-border)]">
      {branch && (
        <span
          key={`${workspace?.path}:${branch.name}`}
          className={item}
          title={`${t.lip.branch}：${branch.name}${branch.detached ? `（${t.lip.detached}）` : ""}`}
        >
          <GitBranch aria-hidden size={13} className="shrink-0" />
          <span className="max-w-40 truncate">{branch.name}</span>
        </span>
      )}
      {!workspace ? (
        <WorkspacePicker current={null} onPicked={onPicked} onError={onError}>
          <button
            type="button"
            className="flex items-center gap-1.5 outline-none transition-colors hover:text-fg focus-visible:text-fg data-[state=open]:text-fg"
          >
            <FolderOpen aria-hidden size={13} />
            <span>{t.chooseFolder}</span>
          </button>
        </WorkspacePicker>
      ) : locked ? (
        // 会话已绑定到开始时的工作区，之后不能切换，避免界面与 Core 实际工作区不一致
        <span
          className={item}
          title={`${t.currentWorkspace}：${workspace.path}\n${t.workspaceLocked}`}
        >
          <Folder aria-hidden size={13} className="shrink-0" />
          <span className="max-w-48 truncate">{workspace.name}</span>
        </span>
      ) : (
        // 悬停（或键盘聚焦）时文件夹图标换成关闭按钮，取消已选的工作区。
        // 关闭按钮是触发器的兄弟元素、叠在图标位置上（按钮里不能嵌套按钮），点它不会打开菜单
        <span key={workspace.path} className={`${item} group/ws relative`}>
          <WorkspacePicker current={workspace} onPicked={onPicked} onError={onError}>
            <button
              type="button"
              title={`${t.currentWorkspace}：${workspace.path}`}
              className="flex min-w-0 items-center gap-1.5 outline-none transition-colors hover:text-fg focus-visible:text-fg data-[state=open]:text-fg"
            >
              <Folder
                aria-hidden
                size={13}
                className="shrink-0 transition-opacity group-focus-within/ws:opacity-0 group-hover/ws:opacity-0"
              />
              <span className="max-w-48 truncate">{workspace.name}</span>
            </button>
          </WorkspacePicker>
          <button
            type="button"
            aria-label={`${t.clearWorkspace} ${workspace.name}`}
            title={t.clearWorkspace}
            onClick={onClear}
            className="absolute -left-[3px] top-1/2 grid size-[19px] -translate-y-1/2 place-items-center rounded-full opacity-0 outline-none transition-opacity hover:bg-black/[0.07] hover:text-fg focus-visible:opacity-100 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100 dark:hover:bg-white/[0.1]"
          >
            <X aria-hidden size={12} strokeWidth={2} />
          </button>
        </span>
      )}
    </div>
  );
}
