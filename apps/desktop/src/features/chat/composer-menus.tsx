"use client";

// 输入框周边的弹出菜单：选择工作区、权限模式；以及附件（本地路径引用）小标签。
import {
  Check,
  FileText,
  Folder,
  Hand,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { DropdownMenu as Menu } from "radix-ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { canPickFiles, canUseWorkspaces, getPlatform } from "@/lib/platform";
import type { WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { PermissionMode } from "@/stores/app-store";
import { TrustDialog } from "./trust-dialog";

const t = strings.chat;

/** 菜单行：圆角高亮、图标 + 文字，高亮态用轻微的黑/白叠色 */
const rowClass =
  "mx-1.5 flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-[13px] text-fg outline-none " +
  "data-[highlighted]:bg-black/[0.06] data-[disabled]:opacity-45 dark:data-[highlighted]:bg-white/[0.1]";

const separatorClass = "mx-3 my-1 h-px bg-black/[0.07] dark:bg-white/[0.09]";

/** 取路径最后一段作为显示名（兼容 \ 与 /） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 操作失败的提示：说明哪一步失败，再附上原因 */
export function failure(what: string, e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  return reason ? `${what}：${reason}` : what;
}

/** 当前平台是否能弹系统文件对话框（首帧为 false） */
export function useCanPickFiles(): boolean {
  const [can, setCan] = useState(false);
  // 只在客户端判断运行环境，避免水合不一致
  useEffect(() => setCan(canPickFiles()), []);
  return can;
}

/** 当前平台是否能列出/打开工作区（首帧为 false） */
export function useCanUseWorkspaces(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => setCan(canUseWorkspaces()), []);
  return can;
}

/**
 * 选择工作区：顶部搜索、最近工作区列表（当前项打勾）、底部"打开文件夹…"调用系统对话框。
 * 需要信任确认的工作区（首次打开或 `.primus/` 已变化）先弹出确认，选择后才交给 `onPicked`。
 */
export function WorkspacePicker({
  current,
  onPicked,
  onError,
  children,
}: {
  current: WorkspaceInfo | null;
  onPicked: (ws: WorkspaceInfo) => void;
  /** 打开工作区或选择文件夹失败（此时菜单通常已关闭）；成功时传 null 清除提示 */
  onError?: (message: string | null) => void;
  children: ReactNode;
}) {
  const [items, setItems] = useState<WorkspaceInfo[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingTrust, setPendingTrust] = useState<WorkspaceInfo | null>(null);
  // 只处理最近一次打开请求的结果：较早的请求晚到时丢弃，不覆盖用户最后的选择
  const openSeq = useRef(0);
  // 卸载（如清除工作区）后作废仍在途的打开请求，晚到的结果不再回调 onPicked
  useEffect(
    () => () => {
      openSeq.current++;
    },
    [],
  );
  const canPick = useCanPickFiles();
  // 菜单内显示（菜单仍开着时），同时交给外层显示（选择后菜单已关闭）
  const fail = (message: string) => {
    setError(message);
    onError?.(message);
  };

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    setQuery("");
    setError(null);
    getPlatform()
      .then((p) => p.workspaceList())
      .then(setItems)
      .catch((e) => setError(failure(t.workspaceListFailed, e)));
  };

  const open = (path: string) => {
    const seq = ++openSeq.current;
    return getPlatform()
      .then((p) => p.workspaceOpen(path))
      .then((ws) => {
        if (seq !== openSeq.current) return;
        setError(null);
        onError?.(null);
        if (ws.needsTrust) setPendingTrust(ws);
        else onPicked(ws);
      })
      .catch((e) => {
        if (seq === openSeq.current) fail(failure(t.workspaceOpenFailed, e));
      });
  };

  const browse = () =>
    getPlatform()
      .then((p) => p.dialogPickFolder())
      .then((path) => (path ? open(path) : undefined))
      .catch((e) => fail(failure(t.pickFolderFailed, e)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((w) => `${w.name} ${w.path}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  return (
    <>
      <TrustDialog
        workspace={pendingTrust}
        onDecided={(ws) => {
          setPendingTrust(null);
          onPicked(ws);
        }}
        onCancel={() => setPendingTrust(null)}
      />
      <GlassPopover onOpenChange={onOpenChange}>
        <GlassPopoverTrigger asChild>{children}</GlassPopoverTrigger>
        <GlassPopoverContent
          side="top"
          sideOffset={10}
          tint={0.8}
          minWidth={264}
          className="max-w-80"
        >
          <div className="-mt-0.5 flex items-center gap-2 px-4 pb-2 pt-0.5">
            <Search aria-hidden size={14} className="shrink-0 text-muted" />
            <input
              // biome-ignore lint/a11y/noAutofocus: 打开菜单即可输入筛选
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // 不让菜单的首字母跳转吞掉输入；方向键交给菜单
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape")
                  e.stopPropagation();
              }}
              placeholder={t.searchWorkspaces}
              aria-label={t.searchWorkspaces}
              className="h-6 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted/70"
            />
          </div>
          <div className={separatorClass} />
          {error && (
            <p role="alert" className="px-4 pt-1.5 text-[12px] text-danger">
              {error}
            </p>
          )}
          <div className="scroll-thin max-h-60 overflow-y-auto py-0.5">
            {filtered.length === 0 ? (
              <p className="px-4 py-2 text-[12px] text-muted">
                {items.length === 0 ? t.noRecentWorkspaces : t.noMatchingWorkspaces}
              </p>
            ) : (
              filtered.map((ws) => (
                <Menu.Item
                  key={ws.path}
                  className={rowClass}
                  textValue={ws.name}
                  title={ws.path}
                  onSelect={() => void open(ws.path)}
                >
                  <Folder
                    aria-hidden
                    size={15}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted"
                  />
                  <span className="min-w-0 flex-1 truncate">{ws.name}</span>
                  {current?.path === ws.path && (
                    <Check aria-hidden size={14} className="shrink-0" />
                  )}
                </Menu.Item>
              ))
            )}
          </div>
          {canPick && (
            <>
              <div className={separatorClass} />
              <Menu.Item
                className={cn(rowClass, "text-muted data-[highlighted]:text-fg")}
                onSelect={() => void browse()}
              >
                <Plus aria-hidden size={15} strokeWidth={1.75} className="shrink-0" />
                <span>{strings.layout.openFolder}</span>
              </Menu.Item>
            </>
          )}
        </GlassPopoverContent>
      </GlassPopover>
    </>
  );
}

/** 各权限模式的图标与强调色：完全访问用警示色，提醒风险 */
export const permissionMeta: Record<PermissionMode, { icon: typeof Hand; tone: string }> = {
  ask: { icon: Hand, tone: "" },
  edit: { icon: ShieldCheck, tone: "text-success" },
  full: { icon: ShieldAlert, tone: "text-warning" },
};

const MODES: PermissionMode[] = ["ask", "edit", "full"];

/** 权限模式：三档，每档一句说明；当前项右侧打勾，完全访问整行用警示色。选择后由会话同步给 primus-guard 执行 */
export function PermissionPicker({
  mode,
  onChange,
  children,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  children: ReactNode;
}) {
  return (
    <GlassPopover>
      <GlassPopoverTrigger asChild>{children}</GlassPopoverTrigger>
      <GlassPopoverContent
        side="top"
        sideOffset={10}
        tint={0.8}
        minWidth={300}
        className="max-w-[340px]"
      >
        <Menu.RadioGroup value={mode} onValueChange={(v) => onChange(v as PermissionMode)}>
          {MODES.map((m) => {
            const { icon: Icon, tone } = permissionMeta[m];
            const p = t.permissions[m];
            return (
              <Menu.RadioItem
                key={m}
                value={m}
                textValue={p.label}
                className={cn(rowClass, "items-start gap-3 py-2", m === "full" && tone)}
              >
                <Icon
                  aria-hidden
                  size={16}
                  strokeWidth={1.75}
                  className={cn("mt-0.5 shrink-0", tone || "text-muted")}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium leading-snug">{p.label}</span>
                  <span
                    className={cn(
                      "text-[12px] leading-snug",
                      m === "full" ? "opacity-80" : "text-muted",
                    )}
                  >
                    {p.hint}
                  </span>
                </span>
                <Menu.ItemIndicator className="mt-0.5 shrink-0">
                  <Check aria-hidden size={14} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            );
          })}
        </Menu.RadioGroup>
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/** 附件小标签：只显示文件名，悬停看完整路径，可移除 */
export function AttachmentChips({
  paths,
  onRemove,
}: {
  paths: string[];
  onRemove: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  return (
    <ul aria-label={t.attach} className="flex flex-wrap gap-1.5 px-1 pb-1">
      {paths.map((p) => (
        <li
          key={p}
          title={p}
          className="group flex h-7 max-w-56 items-center gap-1.5 rounded-[9px] bg-black/[0.045] pl-2 pr-1 text-[12px] ring-1 ring-black/[0.05] dark:bg-white/[0.07] dark:ring-white/[0.06]"
        >
          <FileText aria-hidden size={13} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate">{baseName(p)}</span>
          <button
            type="button"
            aria-label={`${t.removeAttachment} ${baseName(p)}`}
            onClick={() => onRemove(p)}
            className="grid size-5 shrink-0 place-items-center rounded-md text-muted outline-none hover:bg-black/[0.07] hover:text-fg dark:hover:bg-white/[0.1]"
          >
            <X aria-hidden size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 发送时把附件作为路径引用附在消息末尾（本地应用：不复制、不上传，Core 按路径读取） */
export function withAttachments(message: string, paths: string[]): string {
  if (paths.length === 0) return message;
  return `${message}\n\n${t.attachmentsPrompt}\n${paths.map((p) => `- ${p}`).join("\n")}`;
}
