"use client";

// 项目信任确认（第 17.2 节）：首次打开工作区，或信任后 `.primus/` 内容变化时显示。
// 展示项目路径、AGENTS.md（可展开查看）以及 `.primus/` 下的扩展、技能、MCP 配置；
// 选择“信任”或“不信任”都会记下，会话据此以 --approve / --no-approve 启动（由薄壳判定）。
import { useEffect, useRef, useState } from "react";
import {
  GlassDialog,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { getPlatform } from "@/lib/platform";
import type { TrustDetails, WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { failure } from "./composer-menus";

const t = strings.chat;

export function TrustDialog({
  workspace,
  onDecided,
  onCancel,
}: {
  /** 待确认的工作区；null 时不显示 */
  workspace: WorkspaceInfo | null;
  /** 选择已保存：返回更新后的工作区信息 */
  onDecided: (ws: WorkspaceInfo) => void;
  onCancel: () => void;
}) {
  const [details, setDetails] = useState<TrustDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存失败（如内容在展示后变化）时重新读取，让用户看到当前内容再决定
  const [reload, setReload] = useState(0);
  const path = workspace?.path ?? null;
  const shownPath = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 变化时重新读取
  useEffect(() => {
    setDetails(null);
    // 换了工作区时清掉提示；同一工作区重新读取时保留保存失败的原因
    if (shownPath.current !== path) setError(null);
    shownPath.current = path;
    setSaving(false);
    if (!path) return;
    let live = true;
    getPlatform()
      .then((p) => p.workspaceInspect(path))
      .then((d) => live && setDetails(d))
      .catch((e) => live && setError(failure(t.trustInspectFailed, e)));
    return () => {
      live = false;
    };
  }, [path, reload]);

  const decide = (trusted: boolean) => {
    if (!workspace) return;
    setSaving(true);
    setError(null);
    getPlatform()
      .then((p) => p.workspaceTrust(workspace.path, trusted, trusted ? details?.fingerprint : null))
      .then(() => onDecided({ ...workspace, trusted, needsTrust: false }))
      .catch((e) => {
        setError(failure(t.trustSaveFailed, e));
        setReload((n) => n + 1);
      });
  };

  const groups = details
    ? ([
        [t.trustExtensions, details.extensions],
        [t.trustSkills, details.skills],
        [t.trustMcp, details.mcpServers],
      ] as const)
    : [];
  const empty =
    details !== null && details.agentsMd === null && groups.every(([, items]) => !items.length);
  // 内容读取失败时仍允许选择“不信任”（只用用户级资源）；“信任”需要用户看到完整的项目内容
  const incomplete = details !== null && details.fingerprint === null;
  const canTrust = details !== null && !incomplete && !saving;

  return (
    <GlassDialog
      open={workspace !== null}
      // 保存进行中不能关闭（Esc、点遮罩），否则保存成功后仍会选中工作区
      onOpenChange={(open) => !open && !saving && onCancel()}
    >
      <GlassDialogContent>
        <GlassDialogTitle>{t.trustTitle}</GlassDialogTitle>
        <GlassDialogDescription>{t.trustDescription}</GlassDialogDescription>
        <p className="mt-3 break-all font-mono text-xs text-muted">{workspace?.path}</p>

        <div className="scroll-thin mt-3 max-h-64 space-y-2 overflow-y-auto text-sm">
          {!details && !error && <p className="text-muted">{t.trustLoading}</p>}
          {incomplete && <p className="text-warning">{t.trustIncomplete}</p>}
          {empty && !incomplete && <p className="text-muted">{t.trustNothing}</p>}
          {groups.map(([label, items]) =>
            items.length ? (
              <div key={label}>
                <span className="font-medium">{label}</span>
                <span className="text-muted">：{items.join("、")}</span>
              </div>
            ) : null,
          )}
          {details?.agentsMd != null && (
            <details>
              <summary className="cursor-pointer font-medium">
                {t.trustAgentsMd}
                {details.agentsMdTruncated && (
                  <span className="font-normal text-muted">{t.trustAgentsMdTruncated}</span>
                )}
              </summary>
              <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-[10px] bg-hover p-2.5 font-mono text-xs">
                {details.agentsMd}
              </pre>
            </details>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2 text-sm">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full px-4 py-1.5 text-muted disabled:opacity-45"
          >
            {t.trustCancel}
          </button>
          <button
            type="button"
            onClick={() => decide(false)}
            disabled={saving}
            className="rounded-full bg-hover px-4 py-1.5 disabled:opacity-45"
          >
            {t.trustReject}
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            disabled={!canTrust}
            className="rounded-full bg-hover px-4 py-1.5 font-medium ring-1 ring-fg/25 disabled:opacity-45"
          >
            {t.trustAccept}
          </button>
        </div>
      </GlassDialogContent>
    </GlassDialog>
  );
}
