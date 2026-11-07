"use client";

// 输入框上方的附件图块条：横向滚动；有附件时 grid 行 0fr → 1fr 展开，输入框随之平滑长高。
import { strings } from "@/lib/strings";
import { AttachmentTile } from "./attachment-tile";
import type { AttachmentView } from "./use-attachments";

export function AttachmentStrip({
  items,
  onRemove,
  onRemoved,
}: {
  items: AttachmentView[];
  onRemove: (id: string) => void;
  onRemoved: (id: string) => void;
}) {
  // 全部移除时等图块的离场动画放完（从状态删除）再收起
  const open = items.length > 0;
  return (
    <div className="att-strip-wrap -mx-1 -mt-1.5" data-open={open || undefined} inert={!open}>
      <div className="min-h-0 overflow-hidden">
        {items.length > 0 && (
          <ul aria-label={strings.chat.attachments.list} className="att-strip">
            {items.map((item) => (
              <AttachmentTile key={item.id} item={item} onRemove={onRemove} onRemoved={onRemoved} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
