"use client";

import { Download, X } from "lucide-react";
import { useEffect } from "react";
import { GlassSurface } from "@/components/ui/glass-surface";
import { strings } from "@/lib/strings";
import { useRestartUpdate } from "./restart-update";
import { useUpdateStore } from "./update-store";

const t = strings.update;

/**
 * 下载完成后的非阻塞提示（第 3.6 节）：右下角卡片“Primus x.y.z 已下载并校验，重启即可更新”，
 * “立即重启更新”或“下次启动时更新”（下次打开 Primus 时直接安装）。有运行中的 Agent 时先确认。
 * 挂在根布局中，同时负责启动更新状态订阅。
 */
export function UpdatePrompt() {
  const start = useUpdateStore((s) => s.start);
  const pending = useUpdateStore((s) => s.status?.pending ?? null);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const { restart, working, error, dialog } = useRestartUpdate();

  useEffect(() => {
    void start();
  }, [start]);

  if (!pending || pending.version === dismissedVersion) return null;
  const text = t.ready.replace("{version}", pending.version);

  return (
    <>
      <section
        aria-label={text}
        className="fixed right-4 bottom-4 z-40 w-[min(calc(100vw-2rem),360px)]"
      >
        <GlassSurface blur={24} radius={22} tint={0.8}>
          <div className="flex gap-3 p-4 text-fg">
            <Download aria-hidden size={18} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p role="status" className="text-sm font-medium">
                {text}
              </p>
              {error && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {error}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                <button
                  type="button"
                  disabled={working}
                  onClick={restart}
                  className="rounded-full bg-fg px-3 py-1 font-medium text-surface transition-opacity enabled:hover:opacity-90 disabled:opacity-50"
                >
                  {t.restartNow}
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => dismiss(pending.version)}
                  className="rounded-full px-3 py-1 ring-1 ring-border transition-colors enabled:hover:bg-hover disabled:opacity-50"
                >
                  {t.nextLaunch}
                </button>
              </div>
            </div>
            <button
              type="button"
              aria-label={t.close}
              disabled={working}
              onClick={() => dismiss(pending.version)}
              className="-mt-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X aria-hidden size={14} />
            </button>
          </div>
        </GlassSurface>
      </section>
      {dialog}
    </>
  );
}
