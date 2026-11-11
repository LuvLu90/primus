"use client";

// 打开外部链接前先确认（技术方案：点击外部链接前先确认）：回复正文、右栏 Word / PowerPoint 预览共用。
// 只接受 http / https；确认后经平台接口 openExternal 用系统浏览器打开，不在 App 的 WebView 里导航。
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";

const t = strings.chat;

/** 是否是可在浏览器中打开的外部链接（http / https） */
export const isExternalUrl = (href: string) => /^https?:\/\//i.test(href);

/**
 * 外部链接确认框。`confirm(url)` 对 http / https 链接弹出确认（其他协议忽略），`ui` 放进组件树。
 * `description` 说明链接来自哪里（默认“来自回复内容”）。
 */
export function useExternalLinkConfirm(description: string = t.linkDescription): {
  confirm: (url: string) => void;
  ui: ReactNode;
} {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 主界面隐藏时（如 Alt+← 回到设置页）关掉确认框，否则它会盖在别的页面上
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 变化即关闭
  useEffect(() => {
    setPending(null);
    setError(null);
  }, [pathname]);

  const confirm = useCallback((url: string) => {
    if (!isExternalUrl(url)) return;
    setError(null);
    setPending(url);
  }, []);

  const open = () => {
    const url = pending;
    if (!url) return;
    getPlatform()
      .then((platform) => platform.openExternal(url))
      .then(
        () => setPending(null),
        () => setError(t.linkFailed),
      );
  };

  const ui =
    pending === null ? null : (
      <GlassDialog open onOpenChange={(next) => !next && setPending(null)}>
        <GlassDialogContent>
          <GlassDialogTitle>{t.linkTitle}</GlassDialogTitle>
          <GlassDialogDescription>{description}</GlassDialogDescription>
          <p className="mt-3 max-h-32 overflow-y-auto break-all font-mono text-xs text-muted">
            {pending}
          </p>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <GlassDialogClose asChild>
              <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                {t.linkCancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              onClick={open}
              className="rounded-full bg-hover px-4 py-1.5 font-medium ring-1 ring-border"
            >
              {t.linkOpen}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    );
  return { confirm, ui };
}
