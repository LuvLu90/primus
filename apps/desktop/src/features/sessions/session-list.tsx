"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
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
import { Tooltip } from "@/components/ui/tooltip";
import { getPlatform } from "@/lib/platform";
import type { SessionSummary } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { buildRows, type ListRow, workspaceKey } from "./session-groups";
import { findTab, tabsForDeletion, useSessionsStore } from "./sessions-store";
import { useSessionDefaultWorkspace } from "./use-default-workspace";
import { useSessionIndex, useSessionSearch } from "./use-session-index";

// 左栏会话列表（第 10.2、16.2 节，ADR 0006）：搜索框 + 虚拟滚动的会话列表，滚到底加载下一页；
// 有项目的会话归到可折叠的项目文件夹下，未选工作区的会话在“最近”（session-groups.ts）；
// 点击打开（已在某个标签中则切过去），菜单里可归档、删除（删除前确认，永久删除、不可恢复）。
// 打开中的会话也可以直接删除：先关掉它的标签，薄壳删除时一并结束它的 Core。

const t = strings.sessions;
/** 行高（px），与样式一致，供虚拟列表估算 */
export const ROW_HEIGHT = 34;
/** 分组标题（项目 / 最近）的行高 */
const HEADER_HEIGHT = 32;
/** 距底部还剩这么多行时加载下一页 */
const LOAD_MORE_THRESHOLD = 10;
/** 连续自动加载但可见行没有增长（如“项目”已折叠、新页全是项目会话）最多这么多页，之后等用户滚动 */
const MAX_IDLE_PAGES = 2;

/** 当前用户未选工作区时的默认目录键：读取中为 undefined，读取失败为 null（只有空工作区算“最近”） */
function useDefaultWorkspaceKey(): string | null | undefined {
  const path = useSessionDefaultWorkspace();
  return path ? workspaceKey(path) : path;
}

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
  // 主界面切到设置等页面时只隐藏不卸载，Portal 里的浮层要主动关掉，否则会盖在目标页面上
  const shellHidden = useShellHidden();
  useEffect(() => {
    if (shellHidden) setPendingDelete(null);
  }, [shellHidden]);
  // 正在删除的会话路径：删除完成前不允许再打开（否则会留下指向已删除文件的标签）
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const tabs = useSessionsStore((s) => s.tabs);
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  const openSession = useSessionsStore((s) => s.openSession);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const tabsFull = useSessionsStore((s) => s.tabsFull);
  const newTab = useSessionsStore((s) => s.newTab);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const activeWorkspace = tabs.find((x) => x.id === activeTabId)?.workspace;
  const defaultKey = useDefaultWorkspaceKey();
  // 默认目录读到之前不分组，避免默认目录的会话先显示成项目再挪到“最近”
  const grouping = defaultKey !== undefined;

  const searching = search.results !== null;
  const sessions = search.results ?? index.items;
  const rows: ListRow[] = useMemo(
    () =>
      searching
        ? sessions.map((s) => ({ kind: "session", key: s.path, session: s, nested: false }))
        : grouping
          ? buildRows(sessions, {
              projectsOpen,
              toggled,
              activeKey: activeWorkspace ? workspaceKey(activeWorkspace) : null,
              defaultKey,
            })
          : [],
    [searching, grouping, sessions, projectsOpen, toggled, activeWorkspace, defaultKey],
  );
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
    estimateSize: (i) => (rows[i]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    // 测量前（含测试环境）按一屏估算，首帧就能渲染出可见行
    initialRect: { width: 0, height: 640 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  const { hasMore, loading, loadMore, error: indexError } = index;
  // 自动加载的上一页加载前的行数，与此后连续未增长的页数：连续几页都没让列表变长时停下，等用户滚动
  const autoLoad = useRef({ rows: -1, idle: 0 });
  // 自动分页已暂停且列表无法滚动（手动“加载更多”入口）
  const [stalled, setStalled] = useState(false);
  // 加载失败后不自动重试（否则 loading 复位即再次触发，连续请求）：等用户点“重试”
  useEffect(() => {
    if (
      searching ||
      !grouping ||
      indexError ||
      !hasMore ||
      loading ||
      lastIndex < rows.length - LOAD_MORE_THRESHOLD
    )
      return;
    const auto = autoLoad.current;
    auto.idle = rows.length > auto.rows ? 0 : auto.idle + 1;
    auto.rows = rows.length;
    if (auto.idle >= MAX_IDLE_PAGES) {
      // 暂停自动分页；列表不够长、没法滚动触发时，给一个手动“加载更多”
      const el = scrollRef.current;
      setStalled(!el || el.scrollHeight <= el.clientHeight + 1);
      return;
    }
    loadMore();
  }, [searching, grouping, indexError, hasMore, loading, lastIndex, rows.length, loadMore]);
  /** 解除“连续未增长”的限制，继续分页 */
  const resumePaging = () => {
    const auto = autoLoad.current;
    auto.idle = 0;
    auto.rows = -1;
    setStalled(false);
    if (hasMore && !loading && !indexError && !searching) loadMore();
  };
  /** 用户滚到底部附近：继续分页 */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || autoLoad.current.idle < MAX_IDLE_PAGES) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - ROW_HEIGHT * 2) return;
    resumePaging();
  };

  /** 在项目中新建会话：输入框上方的工作区切到该项目，再开一个空标签 */
  const newInProject = (workspace: string) => {
    setActionError(undefined);
    getPlatform()
      .then((p) => p.workspaceOpen(workspace))
      .then((ws) => {
        // 标签已满时 newTab 失败：不动全局工作区，免得当前会话旁显示别的项目
        if (newTab()) useAppStore.getState().setWorkspace(ws);
      })
      .catch((e) => setActionError(errorText(e)));
  };
  const reveal = (workspace: string) => {
    setActionError(undefined);
    getPlatform()
      .then((p) => p.revealPath(workspace))
      .catch((e) => setActionError(errorText(e)));
  };

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
    setDeleting((prev) => new Set(prev).add(s.path));
    for (const tab of tabsForDeletion(useSessionsStore.getState().tabs, s)) closeTab(tab.id);
    getPlatform()
      .then((p) => p.sessionDelete(s.path))
      .catch((e) => setActionError(errorText(e)))
      .finally(() =>
        setDeleting((prev) => {
          const next = new Set(prev);
          next.delete(s.path);
          return next;
        }),
      );
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
        <Icon name="search" size="sm" className="text-muted" />
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

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin -mx-1 min-h-0 flex-1 overflow-y-auto px-1"
      >
        {rows.length === 0 ? (
          emptyText && <p className="px-2 py-3 text-xs text-muted">{emptyText}</p>
        ) : (
          <ul
            aria-label={searching ? t.searchResults : strings.layout.sessions}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              if (row.kind === "header")
                return (
                  <SectionHeader
                    key={row.key}
                    top={item.start}
                    label={row.section === "projects" ? t.projects : t.recent}
                    open={row.section === "projects" ? projectsOpen : undefined}
                    onToggle={
                      row.section === "projects" ? () => setProjectsOpen((o) => !o) : undefined
                    }
                  />
                );
              if (row.kind === "project")
                return (
                  <ProjectRow
                    key={row.key}
                    top={item.start}
                    name={row.name}
                    path={row.workspace}
                    expanded={row.expanded}
                    onToggle={() =>
                      setToggled((prev) => ({
                        ...prev,
                        [workspaceKey(row.workspace)]: !row.expanded,
                      }))
                    }
                    onNewSession={() => newInProject(row.workspace)}
                    onReveal={() => reveal(row.workspace)}
                  />
                );
              const s = row.session;
              const tab = findTab(tabs, s);
              return (
                <SessionRow
                  key={row.key}
                  session={s}
                  top={item.start}
                  now={now}
                  nested={row.nested}
                  active={tab !== undefined && tab.id === activeTabId}
                  running={tab?.running ?? false}
                  deleting={deleting.has(s.path)}
                  onOpen={() => {
                    if (!deleting.has(s.path)) openSession(s);
                  }}
                  onArchive={() => archive(s)}
                  onDelete={() => setPendingDelete(s)}
                />
              );
            })}
          </ul>
        )}
        {stalled && hasMore && !searching && !indexError && (
          <button
            type="button"
            onClick={resumePaging}
            className="mx-auto mt-1 block rounded-md px-2 py-1 text-xs text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover"
          >
            {t.loadMore}
          </button>
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

/** 主界面是否被隐藏（当前不在主页） */
function useShellHidden(): boolean {
  const pathname = usePathname();
  return pathname !== null && pathname !== "/" && pathname !== "";
}

/** 分组标题：“项目”可折叠（带箭头），“最近”只是标题 */
function SectionHeader({
  top,
  label,
  open,
  onToggle,
}: {
  top: number;
  label: string;
  open?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span>{label}</span>
      {onToggle && (
        <Icon
          name="chevron-down"
          size="xs"
          className={cn("motion-safe:transition-[rotate]", !open && "-rotate-90")}
        />
      )}
    </>
  );
  return (
    <li className="absolute inset-x-0 flex items-end pb-1" style={{ top, height: HEADER_HEIGHT }}>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex items-center gap-1 rounded-md px-2 text-xs text-muted outline-none hover:text-fg focus-visible:text-fg"
        >
          {content}
        </button>
      ) : (
        <span className="flex items-center gap-1 px-2 text-xs text-muted">{content}</span>
      )}
    </li>
  );
}

/** 项目行：文件夹图标 + 名称，点击展开 / 折叠；悬停显示“更多操作”与“新建会话” */
function ProjectRow({
  top,
  name,
  path,
  expanded,
  onToggle,
  onNewSession,
  onReveal,
}: {
  top: number;
  name: string;
  path: string;
  expanded: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onReveal: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const shellHidden = useShellHidden();
  useEffect(() => {
    if (shellHidden) setMoreOpen(false);
  }, [shellHidden]);
  return (
    <li className="group absolute inset-x-0 flex items-center" style={{ top, height: ROW_HEIGHT }}>
      <Tooltip content={path}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[10px] pr-16 pl-2 text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover"
        >
          <Icon name={expanded ? "folder-open" : "folder"} size="md" className="shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      </Tooltip>
      <span className="absolute right-1.5 flex items-center gap-0.5">
        <GlassPopover open={moreOpen} onOpenChange={setMoreOpen}>
          <GlassPopoverTrigger asChild>
            <button
              type="button"
              aria-label={`${t.projectActions}：${name}`}
              className={hoverButtonClass}
            >
              <Icon name="more" size="sm" />
            </button>
          </GlassPopoverTrigger>
          <GlassPopoverContent side="right" align="start" sideOffset={6} tint={0.75} minWidth={168}>
            <GlassPopoverItem
              icon={<Icon name="compose" />}
              label={t.newInProject}
              onSelect={onNewSession}
            />
            <GlassPopoverItem
              icon={<Icon name="folder-open" />}
              label={t.revealProject}
              onSelect={onReveal}
            />
          </GlassPopoverContent>
        </GlassPopover>
        <Tooltip content={t.newInProject}>
          <button
            type="button"
            aria-label={`${t.newInProject}：${name}`}
            onClick={onNewSession}
            className={hoverButtonClass}
          >
            <Icon name="compose" size="sm" />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

const hoverButtonClass =
  "flex aspect-square size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 outline-none hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100";

interface SessionRowProps {
  session: SessionSummary;
  top: number;
  now: number;
  /** 项目下的会话：缩进到文件夹名称处 */
  nested: boolean;
  active: boolean;
  running: boolean;
  /** 正在删除：行不可打开 */
  deleting: boolean;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function SessionRow({
  session,
  top,
  now,
  nested,
  active,
  running,
  deleting,
  onOpen,
  onArchive,
  onDelete,
}: SessionRowProps) {
  const title = sessionTitle(session);
  // 右键菜单：在点击位置弹出同一套操作（归档、删除），替代浏览器自带菜单
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const shellHidden = useShellHidden();
  useEffect(() => {
    if (!shellHidden) return;
    setMenuAt(null);
    setMoreOpen(false);
  }, [shellHidden]);
  const items = (
    <>
      <GlassPopoverItem
        icon={<Icon name={session.archived ? "archive-restore" : "archive"} />}
        label={session.archived ? t.unarchive : t.archive}
        onSelect={onArchive}
      />
      <GlassPopoverSeparator />
      <GlassPopoverItem
        icon={<Icon name="trash" />}
        label={t.delete}
        destructive
        onSelect={onDelete}
      />
    </>
  );
  return (
    <li
      className="group absolute inset-x-0 flex items-center"
      style={{ top, height: ROW_HEIGHT }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (deleting) return;
        const box = e.currentTarget.getBoundingClientRect();
        setMenuAt({ x: e.clientX - box.left, y: e.clientY - box.top });
      }}
    >
      <Tooltip content={title}>
        <button
          type="button"
          onClick={onOpen}
          disabled={deleting}
          aria-busy={deleting ? "true" : undefined}
          aria-current={active ? "true" : undefined}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] pr-2 text-left outline-none hover:bg-hover focus-visible:bg-hover",
            nested ? "pl-8" : "pl-2",
            active && "bg-hover",
            deleting && "pointer-events-none opacity-50",
          )}
        >
          {running && (
            <span
              role="img"
              aria-label={t.running}
              className="size-1.5 shrink-0 rounded-full bg-accent"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          <span className="shrink-0 text-2xs text-muted tabular-nums group-hover:invisible">
            {session.archived ? `${t.archived} · ` : ""}
            {relativeTime(session.updatedAt, now)}
          </span>
        </button>
      </Tooltip>
      <GlassPopover open={moreOpen} onOpenChange={setMoreOpen}>
        <GlassPopoverTrigger asChild>
          <button
            ref={moreRef}
            type="button"
            aria-label={`${t.moreActions}：${title}`}
            className={cn("absolute right-1.5", hoverButtonClass)}
          >
            <Icon name="more" size="sm" />
          </button>
        </GlassPopoverTrigger>
        <GlassPopoverContent side="right" align="start" sideOffset={6} tint={0.75} minWidth={160}>
          {items}
        </GlassPopoverContent>
      </GlassPopover>
      <GlassPopover open={menuAt !== null} onOpenChange={(open) => !open && setMenuAt(null)}>
        <GlassPopoverTrigger asChild>
          <span
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none absolute size-0"
            style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0 }}
          />
        </GlassPopoverTrigger>
        <GlassPopoverContent
          side="bottom"
          align="start"
          sideOffset={2}
          tint={0.75}
          minWidth={160}
          // 触发点是不可见的零尺寸元素：关闭后把焦点交给本行可见的“更多操作”按钮
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            moreRef.current?.focus();
          }}
        >
          {items}
        </GlassPopoverContent>
      </GlassPopover>
    </li>
  );
}
