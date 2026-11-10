"use client";

import { usePathname } from "next/navigation";
// 回复里文件引用胶囊的操作：点击在右栏预览（文件夹列出其中的文件）；右键（或菜单键 / Shift+F10）弹出菜单：
// 预览、用默认程序打开、在文件夹中显示、复制路径。相对路径按会话工作区解析（FileRefBase），失败时在胶囊下方短暂提示。
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverItem,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { showPreview } from "@/features/files/preview-store";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { COPIED_MS } from "./copy-button";
import { resolveFileRefPath } from "./file-ref";

/** 当前会话的工作区路径：回复里的相对路径从这里算起；没有工作区时为 null */
export const FileRefBase = createContext<string | null>(null);

/** 提示停留时间（毫秒） */
export const NOTICE_MS = 4000;

const t = strings.chat.fileRef;

interface Notice {
  x: number;
  y: number;
  text: string;
  tone: "info" | "error";
}

interface Menu {
  x: number;
  y: number;
  el: HTMLElement;
}

/**
 * 复制路径（带行号，编辑器能直接跳转的 `path:42`）。成功后图标换成对勾、无障碍名称换成“已复制路径”约 1.5 秒；
 * 剪贴板不可用时不打扰用户。
 */
export function copyFileRef(el: HTMLElement) {
  const text = el.dataset.fileRef ?? "";
  if (!text) return;
  void navigator.clipboard?.writeText(text).then(
    () => {
      const label = el.dataset.label ?? el.getAttribute("aria-label") ?? "";
      el.dataset.label = label;
      el.dataset.copied = "";
      el.setAttribute("aria-label", t.copied);
      setTimeout(() => {
        delete el.dataset.copied;
        el.setAttribute("aria-label", label);
      }, COPIED_MS);
    },
    () => {},
  );
}

/** 错误对象 → 可显示的原因（薄壳返回的是中文文案字符串） */
function reasonOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 文件引用的点击与右键处理。`onClick` / `onContextMenu` 挂在 Markdown 容器上（事件委托），
 * 返回 true 表示事件属于文件引用、已处理；`ui` 是菜单与提示，放在容器旁渲染。
 */
export function useFileRefActions(): {
  onClick: (e: MouseEvent) => boolean;
  onContextMenu: (e: MouseEvent) => boolean;
  ui: ReactNode;
} {
  const base = useContext(FileRefBase);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  // 主界面隐藏时（如 Alt+← 回到设置页）关掉菜单与提示，否则它们会盖在别的页面上
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 变化即关闭
  useEffect(() => {
    setMenu(null);
    setNotice(null);
  }, [pathname]);

  const showNotice = (el: HTMLElement, text: string, tone: Notice["tone"]) => {
    const box = el.getBoundingClientRect();
    clearTimeout(timer.current);
    setNotice({ x: box.left, y: box.bottom + 6, text, tone });
    timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };

  /** 解析成可交给薄壳的路径；无法定位时提示并返回 null */
  const resolve = (el: HTMLElement): string | null => {
    const name = el.dataset.name ?? "";
    const path = resolveFileRefPath(el.dataset.path ?? "", base);
    if (!path)
      showNotice(el, (base ? t.unresolved : t.noWorkspace).replace("{name}", name), "error");
    return path;
  };

  const fail = (el: HTMLElement) => (e: unknown) =>
    showNotice(
      el,
      t.openFailed.replace("{name}", el.dataset.name ?? "").replace("{reason}", reasonOf(e)),
      "error",
    );

  const open = (el: HTMLElement) => {
    const path = resolve(el);
    if (!path) return;
    setNotice(null);
    getPlatform()
      .then((platform) => platform.openPath(path))
      .then((outcome) => {
        if (outcome === "revealed")
          showNotice(el, t.revealed.replace("{name}", el.dataset.name ?? ""), "info");
      }, fail(el));
  };

  /** 文件与文件夹都在右栏预览（文件夹列出其中的文件） */
  const preview = (el: HTMLElement) => {
    const path = resolve(el);
    if (!path) return;
    setNotice(null);
    showPreview(path);
  };

  const reveal = (el: HTMLElement) => {
    const path = resolve(el);
    if (!path) return;
    setNotice(null);
    getPlatform()
      .then((platform) => platform.revealPath(path))
      .catch(fail(el));
  };

  const target = (e: MouseEvent) =>
    (e.target as HTMLElement).closest?.<HTMLElement>("[data-file-ref]") ?? null;

  const onClick = (e: MouseEvent) => {
    const el = target(e);
    if (!el) return false;
    e.preventDefault();
    preview(el);
    return true;
  };

  const onContextMenu = (e: MouseEvent) => {
    const el = target(e);
    if (!el) return false;
    e.preventDefault();
    // 键盘（菜单键、Shift+F10）触发时没有指针坐标：菜单放在胶囊左下角
    const box = el.getBoundingClientRect();
    const fromKeyboard = e.clientX === 0 && e.clientY === 0;
    setNotice(null);
    setMenu({
      x: fromKeyboard ? box.left : e.clientX,
      y: fromKeyboard ? box.bottom : e.clientY,
      el,
    });
    return true;
  };

  const portal = (node: ReactNode) =>
    typeof document === "undefined" ? null : createPortal(node, document.body);

  const ui = (
    <>
      {menu &&
        portal(
          <GlassPopover open onOpenChange={(isOpen) => !isOpen && setMenu(null)}>
            <GlassPopoverTrigger asChild>
              <span
                aria-hidden
                tabIndex={-1}
                className="pointer-events-none fixed size-0"
                style={{ left: menu.x, top: menu.y }}
              />
            </GlassPopoverTrigger>
            <GlassPopoverContent
              side="bottom"
              align="start"
              sideOffset={2}
              tint={0.75}
              minWidth={168}
              aria-label={t.menu}
              // 触发点是不可见的零尺寸元素：关闭后把焦点还给胶囊
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                menu.el.focus();
              }}
            >
              <GlassPopoverItem
                icon={<Icon name="sidebar-right" />}
                label={t.preview}
                onSelect={() => preview(menu.el)}
              />
              <GlassPopoverItem
                icon={<Icon name="external-link" />}
                label={t.open}
                onSelect={() => open(menu.el)}
              />
              <GlassPopoverItem
                icon={<Icon name="folder-open" />}
                label={t.reveal}
                onSelect={() => reveal(menu.el)}
              />
              <GlassPopoverItem
                icon={<Icon name="copy" />}
                label={t.copy}
                onSelect={() => copyFileRef(menu.el)}
              />
            </GlassPopoverContent>
          </GlassPopover>,
        )}
      {notice &&
        portal(
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "fixed z-50 max-w-sm rounded-xl bg-surface px-3 py-2 text-xs shadow-lg ring-1 ring-border",
              notice.tone === "error" ? "text-danger" : "text-fg",
            )}
            style={{ left: notice.x, top: notice.y }}
          >
            {notice.text}
          </div>,
        )}
    </>
  );

  return { onClick, onContextMenu, ui };
}
