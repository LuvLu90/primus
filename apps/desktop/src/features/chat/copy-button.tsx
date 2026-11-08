"use client";

// 时间线里的复制按钮：助手回复、用户消息与错误卡片共用。复制成功后图标换成对勾约 1.5 秒，
// 无障碍名称同步换成“已复制”。剪贴板不可用或写入失败时保持原样（不打扰用户）。
import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** 复制成功的提示持续时间 */
export const COPIED_MS = 1500;

/**
 * 悬停（或键盘焦点在其中）时才显示的操作行；不支持悬停的触屏设备上常显。
 * 配合父元素的 `group/<名称>` 使用；Tailwind 只识别源码里的完整类名，所以每个分组名各写一份。
 */
const revealBase =
  "opacity-0 transition-opacity duration-200 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100";
export const revealOnTurnHover = `${revealBase} group-hover/turn:opacity-100`;
export const revealOnUserHover = `${revealBase} group-hover/user:opacity-100`;

export function CopyButton({
  text,
  label = strings.chat.copy,
  size = "md",
}: {
  text: string;
  /** 未复制时的无障碍名称与提示 */
  label?: string;
  /** md：消息下方的操作行；sm：卡片内的紧凑按钮 */
  size?: "md" | "sm";
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const name = copied ? strings.chat.copied : label;
  return (
    <button
      type="button"
      aria-label={name}
      title={name}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
      className={cn(
        "grid place-items-center text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40",
        size === "sm" ? "size-6 rounded-md" : "size-7 rounded-lg",
      )}
    >
      {copied ? (
        <Icon name="check" size="sm" className="step-in" />
      ) : (
        <Icon name="copy" size="sm" />
      )}
    </button>
  );
}
