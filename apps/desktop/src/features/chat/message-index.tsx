"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { strings } from "@/lib/strings";

// 对话索引：替代长对话右侧的滚动条，放在时间线左侧。每条用户提问一道刻度，
// 当前所在的提问加长加深；点击平滑滚到那条提问。刻度长短按提问长短分三档。
//
// 指针在刻度条上移动时像手指划过尺子：以指针为中心、半径约 3.5 道刻度的余弦衰减，
// 越近的刻度越长、越粗、越深（macOS 程序坞放大的同一思路：距离 → 目标值 → 弹簧追随）。
// 离指针最近的一道弹出预览卡片，卡片随指针滑动。实现不走 React 渲染：pointermove 只记坐标，
// 每帧一次把每道刻度的放大量写进 CSS 变量 --index-mag（@property 注册为数字，
// 用 transition 做追随与离开时的弹簧回落），刻度只动 transform 与颜色，不改宽度、不触发布局。

export interface IndexItem {
  /** 时间线中对应用户消息元素的 data-msg-index */
  index: number;
  text: string;
}

/** 刻度最多显示这么多道；更多时按比例取样，保证首尾都在 */
const MAX_TICKS = 24;
/** 每道刻度占的高度与刻度条上下内边距（与下方 h-[11px]、py-1 一致） */
export const TICK_PITCH = 11;
export const RAIL_PAD = 4;
/** 放大影响的半径（以刻度为单位）：指针两侧各约 3 道刻度有响应 */
export const FALLOFF_TICKS = 3.5;

export function sample(items: IndexItem[], active: number | null = null): IndexItem[] {
  if (items.length <= MAX_TICKS) return items;
  const out: IndexItem[] = [];
  for (let i = 0; i < MAX_TICKS; i++)
    out.push(items[Math.round((i * (items.length - 1)) / (MAX_TICKS - 1))] as IndexItem);
  // 当前提问必须有自己的刻度（高亮与 aria-current 指向它本身）：替换离它最近的中间刻度，首尾保留
  const current = active === null ? undefined : items.find((x) => x.index === active);
  if (current && !out.includes(current)) {
    let at = 1;
    for (let i = 2; i < out.length - 1; i++)
      if (
        Math.abs((out[i] as IndexItem).index - current.index) <
        Math.abs((out[at] as IndexItem).index - current.index)
      )
        at = i;
    out[at] = current;
    out.sort((a, b) => a.index - b.index);
  }
  return out;
}

/** 余弦衰减：距离 0 时为 1，到半径处平滑降到 0（两端导数都为 0，没有折角） */
export function falloff(distance: number, radius: number): number {
  if (!(radius > 0)) return 0;
  const d = Math.abs(distance) / radius;
  return d >= 1 ? 0 : (1 + Math.cos(Math.PI * d)) / 2;
}

/** 指针（相对刻度条顶部的 y）下每道刻度的放大量 0–1；指针不在时全为 0 */
export function magnitudes(
  y: number | null,
  count: number,
  pitch = TICK_PITCH,
  pad = RAIL_PAD,
  radiusTicks = FALLOFF_TICKS,
): number[] {
  return Array.from({ length: count }, (_, i) =>
    y === null ? 0 : falloff(y - (pad + pitch * (i + 0.5)), radiusTicks * pitch),
  );
}

/** 离指针最近的刻度序号 */
export function nearestTick(y: number, count: number, pitch = TICK_PITCH, pad = RAIL_PAD) {
  return Math.min(count - 1, Math.max(0, Math.floor((y - pad) / pitch)));
}

/** 静止时的刻度长度（px），按提问长短分三档；当前提问 22 */
const tickLength = (text: string) => (text.length > 120 ? 18 : text.length > 30 ? 14 : 10);

export function MessageIndex({
  items,
  scrollRef,
}: {
  items: IndexItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const tickRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 指针位置只存在 ref 里，每帧最多写一次 DOM
  // hoverY：指针在刻度条上的位置（不在时为 null），焦点离开后据此恢复指针的放大与预览
  const pointer = useRef<{
    y: number | null;
    hoverY: number | null;
    railTop: number;
    frame: number;
  }>({
    y: null,
    hoverY: null,
    railTop: 0,
    frame: 0,
  });

  const elementOf = useCallback(
    (index: number) =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-msg-index="${index}"]`) ?? null,
    [scrollRef],
  );

  // 当前提问：顶部已滚过的最后一条（滚到底时取最后一条）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setOverflowing(el.scrollHeight > el.clientHeight + 40);
      const top = el.getBoundingClientRect().top;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      let current: number | null = null;
      for (const item of items) {
        const node = elementOf(item.index);
        if (!node) continue;
        if (atBottom || node.getBoundingClientRect().top - top <= el.clientHeight * 0.35)
          current = item.index;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items, scrollRef, elementOf]);

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      cancelAnimationFrame(pointer.current.frame);
    },
    [],
  );

  // 把当前指针位置画成一帧：每道刻度的 --index-mag 与最近一道的 data-near
  const paint = useCallback(() => {
    const p = pointer.current;
    p.frame = 0;
    const nodes = tickRefs.current;
    const count = nodes.length;
    const mags = magnitudes(p.y, count);
    const near = p.y === null || count === 0 ? -1 : nearestTick(p.y, count);
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      if (!node) continue;
      node.style.setProperty("--index-mag", (mags[i] ?? 0).toFixed(3));
      node.toggleAttribute("data-near", i === near);
    }
    if (near >= 0) {
      clearTimeout(hideTimer.current);
      setHover(near);
    }
  }, []);

  const track = useCallback(
    (y: number | null) => {
      pointer.current.y = y;
      if (!pointer.current.frame) pointer.current.frame = requestAnimationFrame(paint);
    },
    [paint],
  );

  /** 刻度回落、预览稍后收起（指针移到预览卡片上会取消收起） */
  const release = useCallback(() => {
    railRef.current?.removeAttribute("data-scrub");
    track(null);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 120);
  }, [track]);

  if (items.length < 2 || !overflowing) return null;
  const ticks = sample(items, active);
  tickRefs.current.length = ticks.length;

  const jump = (item: IndexItem) => {
    const el = scrollRef.current;
    const node = elementOf(item.index);
    if (!el || !node) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTo({ top: Math.max(0, top - 24), behavior: reduce ? "auto" : "smooth" });
  };

  const onPointerEnter = (e: PointerEvent<HTMLDivElement>) => {
    // 每次都重新读刻度条位置：指针停留期间窗口或聊天区高度可能变化（刻度条垂直居中，会跟着移动）
    pointer.current.railTop = e.currentTarget.getBoundingClientRect().top;
    e.currentTarget.setAttribute("data-scrub", "");
    pointer.current.hoverY = e.clientY - pointer.current.railTop;
    track(pointer.current.hoverY);
  };
  const onPointerMove = onPointerEnter;

  /** 指针离开：键盘焦点（focus-visible）仍在某个刻度上时保留它的放大与预览，否则回落 */
  const onPointerLeave = () => {
    pointer.current.hoverY = null;
    const rail = railRef.current;
    const focused = document.activeElement;
    let keyboard = false;
    try {
      keyboard = !!focused && focused.matches(":focus-visible");
    } catch {
      keyboard = false;
    }
    const at =
      rail && keyboard
        ? Array.from(rail.querySelectorAll("button[data-tick]")).indexOf(focused as Element)
        : -1;
    if (at < 0) {
      release();
      return;
    }
    rail?.removeAttribute("data-scrub");
    clearTimeout(hideTimer.current);
    track(RAIL_PAD + TICK_PITCH * (at + 0.5));
  };

  /** 刻度失焦：指针仍停在刻度条上时恢复指针位置的放大与预览，否则回落 */
  const onTickBlur = () => {
    const y = pointer.current.hoverY;
    if (y === null) {
      release();
      return;
    }
    clearTimeout(hideTimer.current);
    track(y);
  };

  // 键盘：Tab 进入后上下方向键 / Home / End 在刻度间移动，聚焦的刻度同样有“划过”的放大与预览
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-tick]"),
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      e.key === "ArrowDown"
        ? Math.min(buttons.length - 1, at + 1)
        : e.key === "ArrowUp"
          ? Math.max(0, at - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    buttons[next]?.focus();
  };

  const hovered = hover === null ? undefined : ticks[Math.min(hover, ticks.length - 1)];
  const [title, ...rest] = (hovered?.text ?? "").trim().split("\n");
  const detail = rest.join(" ").trim();

  return (
    <nav
      aria-label={strings.chat.work.index}
      className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-20"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 刻度条只是放大效果的感应区，交互都在内部按钮上 */}
      <div
        ref={railRef}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        className="index-rail pointer-events-auto relative flex flex-col py-1"
      >
        {ticks.map((item, i) => {
          const isActive = item.index === active;
          return (
            <button
              key={item.index}
              type="button"
              data-tick=""
              aria-label={item.text.slice(0, 40)}
              aria-current={isActive || undefined}
              onClick={() => jump(item)}
              onFocus={() => track(RAIL_PAD + TICK_PITCH * (i + 0.5))}
              onBlur={onTickBlur}
              className="flex h-[11px] w-7 items-center outline-none"
            >
              <span
                aria-hidden
                ref={(node) => {
                  tickRefs.current[i] = node;
                }}
                className="index-tick"
                style={{ "--index-base": isActive ? 22 : tickLength(item.text) } as CSSProperties}
              />
            </button>
          );
        })}
      </div>
      {hovered && hover !== null && (
        <div
          className="index-pop-anchor absolute top-0 left-9"
          style={{ transform: `translateY(${RAIL_PAD + TICK_PITCH * (hover + 0.5)}px)` }}
        >
          <div
            role="tooltip"
            onMouseEnter={() => clearTimeout(hideTimer.current)}
            onMouseLeave={onPointerLeave}
            className="index-pop pointer-events-auto w-72 rounded-2xl bg-surface/95 px-3.5 py-2.5 shadow-[0_8px_30px_-8px_rgb(0_0_0/0.18)] ring-1 ring-border backdrop-blur-md"
            style={{ translate: "0 -50%" }}
          >
            <p className="truncate font-medium text-sm text-fg">{title}</p>
            {detail && (
              <p className="mt-0.5 line-clamp-2 text-muted text-xs leading-relaxed">{detail}</p>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
