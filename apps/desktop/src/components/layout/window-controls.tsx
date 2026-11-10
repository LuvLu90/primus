"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { type WindowControls as Controls, getWindowControls } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.layout;

/**
 * 拖动区属性：主窗口没有系统标题栏，带这个属性的元素按住可拖动窗口、双击最大化/还原。
 * 只对元素自身生效（不含子元素），子元素里的纯文字要加 pointer-events-none 才不挡拖动。
 */
export const dragRegion = { "data-tauri-drag-region": "" } as const;

function CaptionButton({
  label,
  danger,
  className,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(
          // Windows 11 标题栏按钮：46px 宽、贴边、无圆角；关闭按钮悬停为系统红
          "flex h-9 w-[46px] items-center justify-center text-fg transition-colors duration-100",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
          danger
            ? "hover:bg-caption-close hover:text-on-danger active:bg-caption-close-pressed active:text-on-danger"
            : "hover:bg-hover active:bg-[var(--color-border)]",
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/**
 * 自绘的窗口按钮（最小化 · 最大化/还原 · 关闭），Windows 11 样式，贴在窗口右上角，
 * 让标题栏与界面连成一体。调用方用负外边距把它推到窗口上沿和右沿。浏览器预览没有窗口控制，不渲染。
 */
export function WindowControls({ className }: { className?: string }) {
  const [controls, setControls] = useState<Controls>();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getWindowControls().then(async (c) => {
      if (disposed || !c) return;
      setControls(c);
      const off = await c.onMaximizedChange(setMaximized);
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!controls) return null;

  return (
    <div className={cn("flex shrink-0 self-start", className)}>
      <CaptionButton label={t.minimize} onClick={() => void controls.minimize()}>
        <Icon name="minus" />
      </CaptionButton>
      <CaptionButton
        label={maximized ? t.restore : t.maximize}
        onClick={() => void controls.toggleMaximize()}
      >
        {maximized ? (
          <Icon name="window-restore" size="xs" />
        ) : (
          <Icon name="window-maximize" size="xs" />
        )}
      </CaptionButton>
      <CaptionButton
        label={t.close}
        danger
        // 跟随 Windows 11 窗口圆角；最大化时没有圆角
        className={maximized ? undefined : "rounded-tr-lg"}
        onClick={() => void controls.close()}
      >
        <Icon name="x" />
      </CaptionButton>
    </div>
  );
}

/** 没有自己顶栏的页面用的细标题栏：整条可拖动，窗口按钮贴在右上角。调用方让它横向铺满窗口 */
export function WindowTitleBar({ className }: { className?: string }) {
  return (
    <div {...dragRegion} className={cn("flex min-h-2 shrink-0 justify-end", className)}>
      <WindowControls />
    </div>
  );
}
