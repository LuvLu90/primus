"use client";

// 右栏文件夹预览：像资源管理器一样列出直接子项（图标、名称、大小、修改时间），文件夹在前、按名称排序（薄壳排好）。
// 顶部为“上一级”与面包屑；点文件夹进入，点文件在右栏预览。隐藏 / 系统项默认不显示，底部可切换。
// 最多 2000 项（薄壳 preview_dir），虚拟滚动；修改时间列在右栏较窄时隐藏（悬停提示里仍有）。
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { FileIcon, Icon } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { fileIconForName } from "@/features/chat/file-ref";
import type { DirListing } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { breadcrumbs, formatModified, formatSize, joinPath, parentPath } from "./preview-model";

const t = strings.preview.folder;
/** 行高（px），与样式一致 */
const ROW_HEIGHT = 28;
/** 薄壳 preview_dir 的扫描上限：total 等于它时说明还没读完 */
const DIR_SCAN_LIMIT = 20_000;

export function DirView({
  path,
  listing,
  onOpen,
}: {
  path: string;
  listing: DirListing;
  /** 打开子项、面包屑或上一级（在预览内部导航） */
  onOpen: (path: string) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = useMemo(
    () => listing.entries.filter((e) => e.hidden).length,
    [listing.entries],
  );
  const entries = useMemo(
    () => (showHidden ? listing.entries : listing.entries.filter((e) => !e.hidden)),
    [listing.entries, showHidden],
  );
  const parent = parentPath(path);
  const crumbs = breadcrumbs(path);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // 测量前（含测试环境）按一屏估算，首帧就能渲染出可见行
    initialRect: { width: 0, height: 640 },
  });

  const shown = listing.entries.length;
  const truncatedText = listing.truncated
    ? (listing.total >= DIR_SCAN_LIMIT ? t.truncatedMore : t.truncated)
        .replace("{shown}", String(shown))
        .replace("{total}", String(listing.total))
    : null;

  return (
    <div className="@container flex size-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-border border-b px-1.5">
        <Tooltip content={t.up}>
          <button
            type="button"
            aria-label={t.up}
            disabled={!parent}
            onClick={() => parent && onOpen(parent)}
            className="grid aspect-square size-6 shrink-0 place-items-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-40"
          >
            <Icon name="arrow-up" size="sm" />
          </button>
        </Tooltip>
        <nav aria-label={t.path} className="min-w-0 flex-1 overflow-hidden">
          {/* 从右侧对齐：路径太长时裁掉左边，当前文件夹始终可见 */}
          <ol className="flex min-w-0 items-center justify-end overflow-hidden text-xs whitespace-nowrap">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={c.path} className={cn("flex items-center", !last && "shrink")}>
                  {i > 0 && <Icon name="chevron-right" size="xs" className="shrink-0 text-muted" />}
                  {last ? (
                    <span aria-current="location" className="truncate px-1 font-medium text-fg">
                      {c.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onOpen(c.path)}
                      className="truncate rounded px-1 text-muted outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover"
                    >
                      {c.name}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      <div
        aria-hidden
        className="flex h-7 shrink-0 items-center gap-2 border-border border-b px-3 text-2xs text-muted"
      >
        <span className="min-w-0 flex-1">{t.name}</span>
        <span className="w-16 shrink-0 text-right">{t.size}</span>
        <span className="hidden w-28 shrink-0 @sm:block">{t.modified}</span>
      </div>

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">
            {listing.entries.length === 0 ? t.empty : t.onlyHidden}
          </p>
        ) : (
          <ul
            aria-label={t.list}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const e = entries[item.index];
              if (!e) return null;
              const size = e.size === null ? "" : formatSize(e.size);
              const modified = e.modifiedMs === null ? "" : formatModified(e.modifiedMs);
              const tip = [e.name, size, modified].filter(Boolean).join(" · ");
              return (
                <li
                  key={e.name}
                  className="absolute inset-x-0 px-1"
                  style={{ top: item.start, height: ROW_HEIGHT }}
                >
                  <Tooltip content={tip}>
                    <button
                      type="button"
                      onClick={() => onOpen(joinPath(path, e.name))}
                      className={cn(
                        "flex h-full w-full items-center gap-2 rounded-md px-2 text-left text-xs outline-none hover:bg-hover focus-visible:bg-hover",
                        e.hidden && "text-muted",
                      )}
                    >
                      <FileIcon
                        name={e.dir ? "folder" : fileIconForName(e.name)}
                        size="sm"
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-fg">{e.name}</span>
                      <span className="w-16 shrink-0 text-right text-muted tabular-nums">
                        {size}
                      </span>
                      <span className="hidden w-28 shrink-0 text-muted tabular-nums @sm:block">
                        {modified}
                      </span>
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 border-border border-t px-3 py-1 text-2xs text-muted">
        <span>{t.count.replace("{n}", String(entries.length))}</span>
        {truncatedText && <span>{truncatedText}</span>}
        {hiddenCount > 0 && (
          <button
            type="button"
            aria-pressed={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            className="ml-auto rounded px-1 outline-none hover:bg-hover hover:text-fg focus-visible:bg-hover"
          >
            {showHidden ? t.hideHidden : t.showHidden.replace("{n}", String(hiddenCount))}
          </button>
        )}
      </div>
    </div>
  );
}
