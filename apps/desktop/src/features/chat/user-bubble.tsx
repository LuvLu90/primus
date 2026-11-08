"use client";

// 时间线里的一条用户消息：附件标签 + 正文气泡，下方右对齐的操作行（复制正文）。
// 操作行悬停或键盘焦点进入时显示，触屏常显；与助手回复的操作行同一套按钮与显隐规则。
import { splitFileTags } from "@primus/protocol";
import { memo, useMemo } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { SentFiles } from "./attachments/sent-files";
import { CopyButton, revealOnUserHover } from "./copy-button";

const t = strings.chat;

export const UserBubble = memo(function UserBubble({
  text,
  index,
}: {
  text: string;
  index: number;
}) {
  // 末尾的 `<file>` 引用显示成文件标签（内联的文件内容不铺在气泡里）
  const { message, files } = useMemo(() => splitFileTags(text), [text]);
  return (
    <article
      aria-label={t.you}
      data-msg-index={index}
      className="msg-in group/user flex max-w-[80%] scroll-mt-6 flex-col items-end gap-1.5 self-end"
    >
      <SentFiles files={files} />
      {message && (
        <p className="whitespace-pre-wrap rounded-[18px] rounded-br-md bg-bubble px-3.5 py-2 leading-relaxed text-fg">
          {message}
        </p>
      )}
      {/* 操作行：只复制正文（不含附件的 `<file>` 引用），与助手回复的复制按钮一致 */}
      {message && (
        <div className={cn("-mt-1 -mr-1.5 flex", revealOnUserHover)}>
          <CopyButton text={message} />
        </div>
      )}
    </article>
  );
});
