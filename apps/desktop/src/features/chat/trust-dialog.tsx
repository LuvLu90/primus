"use client";

// 项目信任确认（第 17.2 节）：首次打开工作区，或信任后 `.primus/` 内容变化时显示。
// 展示项目路径、AGENTS.md（可展开查看）以及 `.primus/` 下的扩展、技能、MCP 配置；
// 选择“信任”或“不信任”都会记下，会话据此以 --approve / --no-approve 启动（由薄壳判定）。
import { useEffect, useState } from "react";
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
  const path = workspace?.path ?? null;

  useEffect(() => {
    setDetails(null);
    setError(null);
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
  }, [path]);

  const decide = (trusted: boolean) => {
    if (!workspace) return;
    setSaving(true);
    setError(null);
    getPlatform()
      .then((p) => p.workspaceTrust(workspace.path, trusted))
      .then(() => onDecided({ ...workspace, trusted, needsTrust: false }))
      .catch((e) => {
        setSaving(false);
        setError(failure(t.trustSaveFailed, e));
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
  // 内容读取失败时仍允许选择“不信任”（只用用户级资源）；“信任”需要先让用户看到项目内容
  const canTrust = details !== null && !saving;

  return (
    <GlassDialog open={workspace !== null} onOpenChange={(open) => !open && onCancel()}>
      <GlassDialogContent>
        <GlassDialogTitle>{t.trustTitle}</GlassDialogTitle>
        <GlassDialogDescription>{t.trustDescription}</GlassDialogDescription>
        <p className="mt-3 break-all font-mono text-[12px] text-muted">{workspace?.path}</p>

        <div className="scroll-thin mt-3 max-h-64 space-y-2 overflow-y-auto text-[13px]">
          {!details && !error && <p className="text-muted">{t.trustLoading}</p>}
          {empty && <p className="text-muted">{t.trustNothing}</p>}
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
              <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-[10px] bg-hover p-2.5 font-mono text-[12px]">
                {details.agentsMd}
              </pre>
            </details>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
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
