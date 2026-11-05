"use client";

import { PanelLeft, PanelRight } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChatPanel } from "@/features/chat/chat-panel";
import { useSessionsStore } from "@/features/sessions/sessions-store";
import { getWindowControls, type WindowControls } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { BottomDrawer } from "./bottom-drawer";
import { GlassPanel } from "./glass-panel";
import { InspectorPanel } from "./inspector-panel";
import {
  BOTTOM_DRAWER,
  LEFT_PANEL,
  minWindowWidth,
  RIGHT_PANEL,
  resolvePanelLayout,
  SHELL_PADDING,
} from "./panel-layout";
import { ResizeHandle } from "./resize-handle";
import { centerSeamStyle, OUTER_RADIUS, SEAM_BLEED } from "./seam";
import { SessionsSidebar } from "./sessions-sidebar";
import { useViewportSize } from "./use-viewport-size";
import { WindowTitleBar } from "./window-controls";

const t = strings.layout;

// 主界面外壳（第 16.2 节），macOS 27 Liquid Glass 风格：
// 壁纸 → 细标题栏 → 浮动玻璃左栏 / 右栏（可拖动、可收起）→ 中央实色"纸面"时间线 → 通栏底部抽屉（终端 · 日志）。
// 主窗口去掉了系统标题栏：顶部细标题栏可拖动、双击最大化，右上角是自绘窗口按钮。
// 各栏尺寸由 resolvePanelLayout 按视口计算：最小窗口 960×640 到 2560×1440 中央区域都不小于下限、不错位。
export function AppShell() {
  const s = useAppStore();
  const viewport = useViewportSize();
  const layout = resolvePanelLayout(viewport, {
    leftOpen: s.sessionsPanelOpen,
    leftWidth: s.sessionsPanelWidth,
    rightOpen: s.inspectorPanelOpen,
    rightWidth: s.inspectorPanelWidth,
    drawerOpen: s.bottomDrawerOpen,
    drawerHeight: s.bottomDrawerHeight,
  });

  const center = useWindowChoreography(s.sessionsPanelOpen, s.inspectorPanelOpen, {
    left: s.sessionsPanelWidth,
    right: s.inspectorPanelWidth,
  });

  return (
    // 外框始终等于视口（窗口最小尺寸由 Tauri setMinWidth/minHeight 保证）：
    // 页面本身不能比窗口大，否则 html/body 裁掉后右栏贴边、底边错位
    <div className="flex h-screen w-screen flex-col gap-2 overflow-hidden px-2 pb-2 text-fg">
      {/* 不再有顶栏：顶部只留一条可拖动窗口的细标题栏，窗口按钮贴在右上角 */}
      <WindowTitleBar className="-mx-2 h-9" />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <SnapSlot
            side="left"
            open={s.sessionsPanelOpen}
            size={layout.left.size}
            windowMode={center.windowMode}
            fill={center.fill === "left"}
          >
            {(w) => <SessionsSidebar width={w} />}
          </SnapSlot>
          {s.sessionsPanelOpen && (
            <ResizeHandle
              orientation="vertical"
              label={t.resizeSessions}
              value={layout.left.size}
              min={layout.left.min}
              max={layout.left.max}
              direction={1}
              onResize={s.setSessionsPanelWidth}
              onReset={() => s.setSessionsPanelWidth(LEFT_PANEL.initial)}
              className={seamHandleClass}
            />
          )}
          <main
            ref={center.ref}
            aria-label={t.timeline}
            className={cn(
              "seam-mask relative isolate flex min-h-0 flex-col overflow-hidden",
              center.lockedWidth == null ? "flex-1" : "flex-none",
            )}
            style={{
              minWidth: 0,
              width: center.lockedWidth ?? undefined,
              ...seamStyle(center.leftAttached, center.rightAttached, !center.windowMode),
            }}
          >
            {/* 中央与两侧同款液态玻璃、同样透明度；接缝一侧外扩 SEAM_BLEED 由纸面裁掉，接缝不露高光线 */}
            {/* main 带遮罩（seam-mask）且 isolate，玻璃取不到背后画面，模糊/折射看不见却会随时间线每次变化整块重算：关掉 */}
            <GlassPanel
              aria-hidden
              backdrop={false}
              radius={OUTER_RADIUS}
              className="-z-10 pointer-events-none absolute inset-y-0 shadow-none"
              style={{
                position: "absolute",
                left: center.leftAttached ? -SEAM_BLEED : 0,
                right: center.rightAttached ? -SEAM_BLEED : 0,
              }}
            />
            {/* 时间线的实色“纸面”：盖在玻璃之上，让用户气泡与助手回复在接近白色的底上清楚区分（两侧栏仍是玻璃） */}
            <div
              aria-hidden
              className="-z-10 pointer-events-none absolute inset-0 bg-[var(--paper)]"
            />
            {/* 左右栏开关：对称贴在纸面左上角、右上角（圆角与纸面同心） */}
            <PanelToggle
              side="left"
              open={s.sessionsPanelOpen}
              label={s.sessionsPanelOpen ? t.hideSessions : t.showSessions}
              disabled={center.busy}
              onToggle={() => s.setSessionsPanelOpen(!s.sessionsPanelOpen)}
            />
            <PanelToggle
              side="right"
              open={s.inspectorPanelOpen}
              label={s.inspectorPanelOpen ? t.hideInspector : t.showInspector}
              disabled={center.busy}
              onToggle={() => s.setInspectorPanelOpen(!s.inspectorPanelOpen)}
            />
            <ChatTabs />
          </main>
          {s.inspectorPanelOpen && (
            <ResizeHandle
              orientation="vertical"
              label={t.resizeInspector}
              value={layout.right.size}
              min={layout.right.min}
              max={layout.right.max}
              direction={-1}
              onResize={s.setInspectorPanelWidth}
              onReset={() => s.setInspectorPanelWidth(RIGHT_PANEL.initial)}
              className={seamHandleClass}
            />
          )}
          <SnapSlot
            side="right"
            open={s.inspectorPanelOpen}
            size={layout.right.size}
            windowMode={center.windowMode}
            fill={center.fill === "right"}
          >
            {(w) => <InspectorPanel width={w} />}
          </SnapSlot>
        </div>
        {layout.drawer.open && (
          <>
            <ResizeHandle
              orientation="horizontal"
              label={t.resizeDrawer}
              value={layout.drawer.size}
              min={layout.drawer.min}
              max={layout.drawer.max}
              direction={-1}
              onResize={s.setBottomDrawerHeight}
              onReset={() => s.setBottomDrawerHeight(BOTTOM_DRAWER.initial)}
            />
            <BottomDrawer height={layout.drawer.size} />
          </>
        )}
      </div>
    </div>
  );
}

/** 接缝上的拖动条：8px 命中区域用负边距叠在两块面板之间，不占宽度 */
const seamHandleClass = "-mx-1 z-20";

/** 吸附动画：快起慢停，像磁吸一样贴到中央纸面上；圆角、凹口、侧栏宽度、窗口宽度都用同一条曲线同步 */
export const SNAP_MS = 320;
/** 侧栏吸附动画实际时长：系统开启"减少动态效果"时几乎瞬时完成（不用 0，避免除零） */
const snapDuration = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? 1
    : SNAP_MS;
const SNAP_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const SEAM_TRANSITION = `border-radius ${SNAP_MS}ms ${SNAP_EASE}, --nl ${SNAP_MS}ms ${SNAP_EASE}, --nr ${SNAP_MS}ms ${SNAP_EASE}`;

/** cubic-bezier(0.22, 1, 0.36, 1) 的 JS 版本，供窗口宽度动画与 CSS 过渡同步 */
export function snapEase(t: number): number {
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bez = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/** 中央纸面：接缝形状见 centerSeamStyle；随侧栏同步过渡 */
/**
 * 多会话（ADR 0006）：每个标签一个 ChatPanel，非当前标签隐藏而不卸载，
 * 切回时 Core 进程、时间线、草稿都还在；关闭标签才卸载并关闭会话。
 */
function ChatTabs() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  return tabs.map((tab) => (
    <div
      key={tab.id}
      hidden={tab.id !== activeTabId}
      className={tab.id === activeTabId ? "flex min-h-0 flex-1 flex-col" : "hidden"}
    >
      <ChatPanel tab={tab} />
    </div>
  ));
}

function seamStyle(leftOpen: boolean, rightOpen: boolean, animate: boolean): CSSProperties {
  return {
    ...centerSeamStyle(leftOpen, rightOpen),
    // 窗口模式下贴合/分离在动画端点瞬间切换（侧栏宽度为 0 时），过程中圆角、凹口、描边都不变
    transition: animate ? SEAM_TRANSITION : undefined,
  };
}

/**
 * 中央界面不变宽：开关侧栏时窗口右边缘跟着侧栏一起逐帧伸缩（同一条曲线、同一时长）。
 *   展开：锁住中央像素宽度，中央该侧立即变成接缝（此时侧栏宽 0，看不出切换）→ 窗口向该侧逐帧加宽，
 *         侧栏填满新增空间，外侧圆角边缘始终贴着窗口边缘 → 侧栏定宽、解锁
 *   收起：锁住中央 → 窗口逐帧收窄，侧栏随之被收进接缝 → 侧栏卸载，中央该侧恢复圆角与描边、解锁
 * 侧栏宽度直接等于"窗口宽 − 中央 − 另一侧"，窗口走到哪侧栏就到哪，不会出现空白或错位。
 * 窗口只动右边缘、原点不动（移动左边缘在 WebView2 上必然让画面抖一帧）：左栏开合时左边缘不动，
 * 中央与右栏随左栏平移，宽度不变。收起前先放宽窗口最小宽度，保证窗口能收到目标宽度、中央不被撑宽。
 * 一次开关进行中按钮禁用防叠加；窗口目标宽度按"记住的中央宽度 + 已开侧栏"计算（不低于最小窗口），
 * 不累加增量，反复开关不会越来越大；用户手动改窗口或拖动侧栏后重新记住中央宽度。
 * 最大化或浏览器预览下窗口不能变，退回到中央随侧栏伸缩（windowMode=false）。
 */
function useWindowChoreography(
  leftOpen: boolean,
  rightOpen: boolean,
  widths: { left: number; right: number },
) {
  const ref = useRef<HTMLElement>(null);
  const controls = useRef<WindowControls | undefined>(undefined);
  const [maximized, setMaximized] = useState(false);
  const [hasWindow, setHasWindow] = useState(false);
  const prev = useRef({ left: leftOpen, right: rightOpen });
  const centerWidth = useRef<number | null>(null);
  const stableWidth = useRef<number | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  const [fill, setFill] = useState<"left" | "right" | null>(null);
  const windowMode = hasWindow && !maximized;
  // 只在开关状态变化时编排；宽度与窗口模式取最新值即可
  const latest = useRef({ widths, windowMode });
  // 渲染期间不写 ref；layout effect 按声明顺序执行，这里先于下面的编排
  useLayoutEffect(() => {
    latest.current = { widths, windowMode };
  });

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void getWindowControls().then(async (c) => {
      if (!alive || !c) return;
      controls.current = c;
      setHasWindow(true);
      void c.setMinWidth(minWindowWidth(prev.current.left, prev.current.right));
      off = await c.onMaximizedChange(setMaximized);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 中央宽度被用户改变（拖侧栏、改窗口大小）时重新记住；编排过程中的变化不算
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!busyRef.current) centerWidth.current = null;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { left: leftOpen, right: rightOpen };
    const c = controls.current;
    const side = p.left !== leftOpen ? "left" : p.right !== rightOpen ? "right" : null;
    const main = ref.current;
    if (!side || !c || !main) return;
    if (!latest.current.windowMode) {
      // 最大化/非窗口模式只做 CSS 开合，但最小宽度仍要跟上，还原窗口后不会小于当前布局
      void c.setMinWidth(minWindowWidth(leftOpen, rightOpen)).catch(() => {});
      return;
    }
    const w = latest.current.widths;
    // 本次渲染已按新状态排过版，取上一次提交时记下的中央宽度
    const current = stableWidth.current ?? main.offsetWidth;
    if (centerWidth.current == null) centerWidth.current = current;
    const minBefore = minWindowWidth(p.left, p.right);
    const minAfter = minWindowWidth(leftOpen, rightOpen);
    const target = Math.max(
      minAfter,
      centerWidth.current + SHELL_PADDING * 2 + (leftOpen ? w.left : 0) + (rightOpen ? w.right : 0),
    );
    const delta = target - window.innerWidth;

    busyRef.current = true;
    setBusy(true);
    setLockedWidth(current);
    setFill(side);

    let alive = true;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
    void (async () => {
      // 收起时先放宽最小宽度再收窄；展开时加宽完再收紧，窗口永远不被夹住
      try {
        if (minAfter < minBefore) await c.setMinWidth(minAfter);
        await c.animateWidth(delta, snapDuration(), snapEase);
        if (minAfter > minBefore) await c.setMinWidth(minAfter);
      } catch {
        // 窗口操作失败也要走完清理，否则开关按钮会一直禁用、中央宽度被锁住
      }
      await frame();
      if (!alive) return;
      setFill(null);
      setLockedWidth(null);
      await frame();
      busyRef.current = false;
      setBusy(false);
    })();
    return () => {
      alive = false;
      busyRef.current = false;
      setBusy(false);
      setFill(null);
      setLockedWidth(null);
    };
  }, [leftOpen, rightOpen]);

  // 每次提交后记下中央宽度（编排进行中不记），供下一次开关锁定用；必须排在上面的编排之后
  useLayoutEffect(() => {
    if (!busyRef.current && ref.current) stableWidth.current = ref.current.offsetWidth;
  });

  return {
    ref,
    lockedWidth,
    fill,
    busy,
    windowMode,
    leftAttached: leftOpen || fill === "left",
    rightAttached: rightOpen || fill === "right",
  };
}

/**
 * 侧栏插槽。
 * 窗口模式：fill 期间占满"窗口 − 中央 − 另一侧"的空间，内容按满宽绘制并贴着外侧（窗口边缘）对齐，
 * 接缝一侧被裁掉——接缝那边本来就是直角，所以过程中没有圆角跳变；结束后定宽。
 * 非窗口模式（最大化/浏览器）：宽度 0 ↔ 目标宽度 CSS 过渡，中央随之伸缩。
 */
function SnapSlot({
  side,
  open,
  size,
  windowMode,
  fill,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  size: number;
  windowMode: boolean;
  fill: boolean;
  children: (width: number) => ReactNode;
}) {
  const last = useRef(size);
  const width = open && size > 0 ? size : last.current;
  useLayoutEffect(() => {
    if (open && size > 0) last.current = size;
  });
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  const [animating, setAnimating] = useState(false);
  const [ms, setMs] = useState(SNAP_MS);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (windowMode) return;
    setAnimating(true);
    setMs(snapDuration());
    let frame = 0;
    if (open) {
      setMounted(true);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setShown(true));
      });
    } else {
      setShown(false);
    }
    const timer = setTimeout(() => {
      setAnimating(false);
      if (!open) setMounted(false);
    }, snapDuration() + 20);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [open, windowMode]);

  if (windowMode) {
    if (!open && !fill) return null;
    return (
      <div
        className="flex min-h-0 overflow-hidden"
        style={
          fill
            ? {
                flex: "1 1 0",
                minWidth: 0,
                justifyContent: side === "left" ? "flex-start" : "flex-end",
              }
            : { flex: "none", width }
        }
      >
        {children(width)}
      </div>
    );
  }

  if (!mounted) return null;
  return (
    <div
      className={cn(
        "flex min-h-0 shrink-0",
        side === "left" ? "justify-end" : "justify-start",
        animating && "overflow-hidden",
      )}
      style={{
        width: shown ? width : 0,
        transition: animating ? `width ${ms}ms ${SNAP_EASE}` : undefined,
      }}
    >
      {children(width)}
    </div>
  );
}

function PanelToggle({
  side,
  open,
  label,
  onToggle,
  disabled = false,
}: {
  side: "left" | "right";
  open: boolean;
  label: string;
  onToggle: () => void;
  /** 一次开关动画进行中禁用，避免叠加 */
  disabled?: boolean;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={open}
      onClick={() => {
        if (!disabled) onToggle();
      }}
      aria-disabled={disabled || undefined}
      className={cn(
        "absolute top-1.5 z-20 grid size-7 place-items-center rounded-[10px] text-muted transition-colors hover:bg-hover hover:text-fg aria-pressed:text-fg",
        side === "left" ? "left-1.5" : "right-1.5",
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </button>
  );
}
