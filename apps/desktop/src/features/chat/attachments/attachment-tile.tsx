"use client";

// 一个附件图块（56px）：图片显示缩略图，其他文件显示类型图标与文件名。
// 排队/读取中外圈有进度环、右上角是加载点（排队时为静止的点）；落地后加载点模糊消失、删除键在同一位置去模糊出现。
// 读取失败：环变红并抖动一次，保留删除键，悬停看原因。移除：先缩小淡出，再收起宽度让邻居滑过来。
import { type CSSProperties, useEffect } from "react";
import { FileIcon, Icon } from "@/components/icons";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { fileIconForName } from "../file-ref";
import { ProgressRing } from "./progress-ring";
import type { AttachmentView } from "./use-attachments";

const t = strings.chat;

/** 移除动画（160ms + 140ms）没有触发 animationend 时（如元素被隐藏）的兜底 */
const REMOVE_FALLBACK_MS = 450;

function statusLabel(a: AttachmentView): string | undefined {
  if (a.status === "error") return `${t.attachments.failed}：${a.error ?? ""}`;
  if (a.byPath) return t.attachments.byPathHint;
  if (a.status === "queued") return t.attachments.queued;
  if (a.status === "reading") return t.attachments.reading;
  return undefined;
}

export function AttachmentTile({
  item,
  onRemove,
  onRemoved,
}: {
  item: AttachmentView;
  onRemove: (id: string) => void;
  onRemoved: (id: string) => void;
}) {
  const { id, removing } = item;
  // 动画结束（或兜底超时）后才从状态删除
  useEffect(() => {
    if (!removing) return;
    const timer = setTimeout(() => onRemoved(id), REMOVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [removing, id, onRemoved]);

  const isImage = item.kind === "image";
  const status = statusLabel(item);
  const title = [item.path ?? item.name, status].filter(Boolean).join("\n");
  return (
    <li
      className="att-slot"
      data-removing={removing || undefined}
      style={{ "--i": item.order } as CSSProperties}
      aria-label={status ? `${item.name}（${status}）` : item.name}
      onAnimationEnd={(e) => {
        if (removing && e.target === e.currentTarget && e.animationName.startsWith("att-"))
          onRemoved(id);
      }}
    >
      <div
        className="att-tile"
        data-status={item.status}
        data-busy={item.busy || undefined}
        title={title}
      >
        <div className="att-body">
          <div className="att-inner">
            {isImage && item.thumb ? (
              // biome-ignore lint/performance/noImgElement: 静态导出，缩略图是内存里的 data URL
              <img src={item.thumb} alt={item.name} draggable={false} />
            ) : isImage ? (
              <FileIcon name="image" size="xl" />
            ) : (
              <>
                <FileIcon name={fileIconForName(item.name)} size="xl" />
                <span className="max-w-12 truncate text-3xs text-muted">{item.name}</span>
              </>
            )}
            {item.byPath && <span className="att-warn">{t.attachments.byPath}</span>}
          </div>
          {isImage && <ProgressRing progress={item.progress ?? 0} />}
          {isImage && (
            <span aria-hidden className="att-badge att-spinner">
              {item.status === "queued" ? (
                <svg aria-hidden width="10" height="10" viewBox="0 0 10 10">
                  <circle cx="5" cy="5" r="1.6" className="fill-muted" />
                </svg>
              ) : (
                <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" data-spinning>
                  <circle
                    cx="6"
                    cy="6"
                    r="4.2"
                    fill="none"
                    strokeWidth="1.6"
                    className="stroke-track-strong"
                  />
                  <path
                    d="M6 1.8A4.2 4.2 0 0 1 10.2 6"
                    fill="none"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    className="stroke-accent"
                  />
                </svg>
              )}
            </span>
          )}
          <button
            type="button"
            aria-label={`${t.removeAttachment} ${item.name}`}
            onClick={() => onRemove(id)}
            className={cn(
              "att-badge att-remove",
              isImage && item.thumb ? "att-remove-frost" : "att-remove-solid",
            )}
          >
            <Icon name="x" size="2xs" />
          </button>
        </div>
      </div>
    </li>
  );
}
