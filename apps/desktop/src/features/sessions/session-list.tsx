"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArchiveRestore, Ellipsis, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverItem,
  GlassPopoverSeparator,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { getPlatform } from "@/lib/platform";
import type { SessionSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { findTab, tabsForDeletion, useSessionsStore } from "./sessions-store";
import { useSessionIndex, useSessionSearch } from "./use-session-index";

// 左栏会话列表（第 10.2、16.2 节，ADR 0006）：搜索框 + 虚拟滚动的会话列表，滚到底加载下一页；
// 点击打开（已在某个标签中则切过去），菜单里可归档、删除（删除前确认，永久删除、不可恢复）。
// 打开中的会话也可以直接删除：先关掉它的标签，薄壳删除时一并结束它的 Core。

const t = strings.sessions;
/** 行高（px），与样式一致，供虚拟列表估算 */
export const ROW_HEIGHT = 52;
/** 距底部还剩这么多行时加载下一页 */
const LOAD_MORE_THRESHOLD = 10;

/** 相对时间（刚刚 / n 分钟前 / n 小时前 / n 天前，超过 30 天显示日期） */
export function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return t.minutesAgo.replace("{n}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.hoursAgo.replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  if (days <= 30) return t.daysAgo.replace("{n}", String(days));
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const sessionTitle = (s: SessionSummary) => s.name || s.title || t.untitled;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SessionList() {
  const index = useSessionIndex();
  const [query, setQuery] = useState("");
  const search = useSessionSearch(query, index.version);
  const [actionError, setActionError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const tabs = useSessionsStore((s) => s.tabs);
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  const openSession = useSessionsStore((s) => s.openSession);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const tabsFull = useSessionsStore((s) => s.tabsFull);

  const searching = search.results !== null;
  const rows = search.results ?? index.items;
  const listError = searching ? search.error : index.error;
  // 相对时间每分钟刷新一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // 测量前（含测试环境）按一屏估算，首帧就能渲染出可见行
    initialRect: { width: 0, height: 640 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  const { hasMore, loading, loadMore, error: indexError } = index;
  // 加载失败后不自动重试（否则 loading 复位即再次触发，连续请求）：等用户点“重试”
  useEffect(() => {
    if (
      !searching &&
      !indexError &&
      hasMore &&
      !loading &&
      lastIndex >= rows.length - LOAD_MORE_THRESHOLD
    )
      loadMore();
  }, [searching, indexError, hasMore, loading, lastIndex, rows.length, loadMore]);

  const archive = (s: SessionSummary) => {
    setActionError(undefined);
    getPlatform()
      .then((p) => p.sessionArchive(s.path, !s.archived))
      .catch((e) => setActionError(errorText(e)));
  };
  const confirmDelete = () => {
    const s = pendingDelete;
    setPendingDelete(null);
    if (!s) return;
    setActionError(undefined);
    for (const tab of tabsForDeletion(useSessionsStore.getState().tabs, s)) closeTab(tab.id);
    getPlatform()
      .then((p) => p.sessionDelete(s.path))
      .catch((e) => setActionError(errorText(e)));
  };

  // 没有会话时列表区留空，不显示提示文字
  const emptyText = searching
    ? search.pending
      ? t.searching
      : search.error
        ? null
        : t.noResults
    : index.loading
      ? t.loading
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <label className="flex h-8 shrink-0 items-center gap-2 rounded-full bg-hover px-3 text-sm">
        <Search aria-hidden size={14} className="text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={strings.layout.searchSessions}
          aria-label={strings.layout.searchSessions}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
        />
      </label>

      {actionError && (
        <div role="alert" className="flex items-center gap-2 px-1 text-xs text-danger">
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
        </div>
      )}

      {listError && (
        <div role="alert" className="flex items-center gap-2 px-1 text-xs text-danger">
          <span className="min-w-0 flex-1 break-words">
            {`${searching ? t.searchFailed : t.loadFailed}：${listError}`}
          </span>
          <button
            type="button"
            onClick={searching ? search.retry : index.reload}
            className="shrink-0 underline"
          >
            {t.retry}
          </button>
        </div>
      )}

      {tabsFull && (
        <p role="status" className="px-1 text-xs text-muted">
          {t.tabsFull}
        </p>
      )}

      <div ref={scrollRef} className="scroll-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {rows.length === 0 ? (
          emptyText && <p className="px-2 py-3 text-xs text-muted">{emptyText}</p>
        ) : (
          <ul
            aria-label={searching ? t.searchResults : strings.layout.sessions}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const s = rows[item.index];
              if (!s) return null;
              const tab = findTab(tabs, s);
              return (
                <SessionRow
                  key={s.path}
                  session={s}
                  top={item.start}
                  now={now}
                  active={tab !== undefined && tab.id === activeTabId}
                  running={tab?.running ?? false}
                  onOpen={() => openSession(s)}
                  onArchive={() => archive(s)}
                  onDelete={() => setPendingDelete(s)}
                />
              );
            })}
          </ul>
        )}
      </div>

      <GlassDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <GlassDialogContent>
          <GlassDialogTitle>{t.deleteTitle}</GlassDialogTitle>
          <GlassDialogDescription>
            {pendingDelete ? `${sessionTitle(pendingDelete)}。${t.deleteDescription}` : null}
          </GlassDialogDescription>
          <div className="mt-5 flex justify-end gap-2 text-sm">
            <GlassDialogClose asChild>
              <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                {t.cancel}
              </button>
            </GlassDialogClose>
            <button
              type="button"
              onClick={confirmDelete}
              className="rounded-full bg-hover px-4 py-1.5 font-medium text-danger ring-1 ring-danger/40"
            >
              {t.deleteConfirm}
            </button>
          </div>
        </GlassDialogContent>
      </GlassDialog>
    </div>
  );
}

interface SessionRowProps {
  session: SessionSummary;
  top: number;
  now: number;
  active: boolean;
  running: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  top,
  now,
  active,
  running,
  onOpen,
  onArchive,
  onDelete,
}: SessionRowProps) {
  const title = sessionTitle(session);
  return (
    <li className="group absolute inset-x-0 flex items-center" style={{ top, height: ROW_HEIGHT }}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        title={title}
        className={cn(
          "flex h-[46px] min-w-0 flex-1 flex-col justify-center rounded-[12px] py-1 pr-8 pl-3 text-left outline-none hover:bg-hover focus-visible:bg-hover",
          active && "bg-hover",
        )}
      >
        <span className="flex w-full items-center gap-1.5">
          {running && (
            <span
              role="img"
              aria-label={t.running}
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            />
          )}
          <span className="truncate text-[13px] leading-tight">{title}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
          <span>{relativeTime(session.updatedAt, now)}</span>
          {session.archived && <span>· {t.archived}</span>}
        </span>
      </button>
      <GlassPopover>
        <GlassPopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${t.moreActions}：${title}`}
            className="absolute right-1.5 flex size-6 items-center justify-center rounded-full text-muted opacity-0 outline-none hover:bg-hover focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <Ellipsis aria-hidden size={14} />
          </button>
        </GlassPopoverTrigger>
        <GlassPopoverContent side="right" align="start" sideOffset={6} tint={0.75} minWidth={160}>
          <GlassPopoverItem
            icon={session.archived ? <ArchiveRestore /> : <Archive />}
            label={session.archived ? t.unarchive : t.archive}
            onSelect={onArchive}
          />
          <GlassPopoverSeparator />
          <GlassPopoverItem icon={<Trash2 />} label={t.delete} destructive onSelect={onDelete} />
        </GlassPopoverContent>
      </GlassPopover>
    </li>
  );
}
