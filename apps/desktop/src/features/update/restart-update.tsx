"use client";

import { type ReactNode, useState } from "react";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { strings } from "@/lib/strings";
import { useUpdateStore } from "./update-store";

const t = strings.update;

/**
 * “立即重启更新”的流程（重启提示与设置页共用）：先不带 force 调 update_install；有运行中的 Agent（busy）时
 * 弹确认框，确认后带 force 再调。成功时 App 退出；失败（含用户取消管理员授权）显示原因，更新包保留。
 */
export function useRestartUpdate(): {
  restart: () => void;
  working: boolean;
  error: string | null;
  dialog: ReactNode;
} {
  const install = useUpdateStore((s) => s.install);
  const installing = useUpdateStore((s) => s.status?.phase === "installing");
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (force: boolean) => {
    setWorking(true);
    setError(null);
    setConfirming(false);
    try {
      const result = await install(force);
      if (result.kind === "busy") setConfirming(true);
      else if (result.kind === "error") setError(result.message || t.installFailed);
    } finally {
      setWorking(false);
    }
  };

  const dialog = (
    <GlassDialog open={confirming} onOpenChange={setConfirming}>
      <GlassDialogContent>
        <GlassDialogTitle>{t.busyTitle}</GlassDialogTitle>
        <GlassDialogDescription>{t.busyDescription}</GlassDialogDescription>
        <div className="mt-5 flex justify-end gap-2 text-sm">
          <GlassDialogClose asChild>
            <button type="button" className="rounded-full bg-hover px-4 py-1.5">
              {t.cancel}
            </button>
          </GlassDialogClose>
          <button
            type="button"
            onClick={() => void run(true)}
            className="rounded-full bg-hover px-4 py-1.5 font-medium text-danger ring-1 ring-danger/40"
          >
            {t.busyConfirm}
          </button>
        </div>
      </GlassDialogContent>
    </GlassDialog>
  );

  return { restart: () => void run(false), working: working || installing, error, dialog };
}
