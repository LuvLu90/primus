"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

// 对话索引：替代长对话右侧的滚动条，放在时间线左侧。每条用户提问一道刻度，
// 当前所在的提问加长加深；悬停刻度弹出预览卡片（首行加粗、后两行灰色），点击平滑滚到那条提问。
// 刻度长短按提问长短分三档，扫一眼就能分辨长短问题。

export interface IndexItem {
  /** 时间线中对应用户消息元素的 data-msg-index */
  index: number;
  text: string;
}

/** 刻度最多显示这么多道；更多时按比例取样，保证首尾都在 */
const MAX_TICKS = 24;

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

const tickWidth = (text: string) => (text.length > 120 ? 18 : text.length > 30 ? 14 : 10);

export function MessageIndex({
  items,
  scrollRef,
}: {
  items: IndexItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<{ item: IndexItem; top: number } | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  if (items.length < 2 || !overflowing) return null;
  const ticks = sample(items, active);

  const jump = (item: IndexItem) => {
    const el = scrollRef.current;
    const node = elementOf(item.index);
    if (!el || !node) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTo({ top: Math.max(0, top - 24), behavior: reduce ? "auto" : "smooth" });
  };

  const show = (item: IndexItem, target: HTMLElement) => {
    clearTimeout(hideTimer.current);
    const rail = railRef.current?.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    setHover({ item, top: r.top + r.height / 2 - (rail?.top ?? 0) });
  };
  const hide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHover(null), 120);
  };

  const [title, ...rest] = (hover?.item.text ?? "").trim().split("\n");

  return (
    <nav
      aria-label={strings.chat.work.index}
      className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-20"
    >
      <div ref={railRef} className="pointer-events-auto relative flex flex-col py-1">
        {ticks.map((item) => {
          const isActive = item.index === active;
          return (
            <button
              key={item.index}
              type="button"
              aria-label={item.text.slice(0, 40)}
              aria-current={isActive || undefined}
              onClick={() => jump(item)}
              onMouseEnter={(e) => show(item, e.currentTarget)}
              onMouseLeave={hide}
              onFocus={(e) => show(item, e.currentTarget)}
              onBlur={hide}
              className="group/tick flex h-[11px] w-7 items-center outline-none"
            >
              <span
                aria-hidden
                className={cn(
                  "block h-[1.5px] rounded-full transition-[width,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  isActive
                    ? "bg-fg"
                    : "bg-muted/35 group-hover/tick:bg-muted/80 group-focus-visible/tick:bg-muted/80",
                )}
                style={{ width: isActive ? 22 : tickWidth(item.text) }}
              />
            </button>
          );
        })}
        {hover && (
          <div
            key={hover.item.index}
            role="tooltip"
            onMouseEnter={() => clearTimeout(hideTimer.current)}
            onMouseLeave={hide}
            className="index-pop absolute left-9 w-64 rounded-2xl bg-surface/95 px-3.5 py-2.5 shadow-[0_8px_30px_-8px_rgb(0_0_0/0.18)] ring-1 ring-border backdrop-blur-md"
            style={{ top: hover.top, translate: "0 -50%" }}
          >
            <p className="truncate font-medium text-sm text-fg">{title}</p>
            {rest.join(" ").trim() && (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted leading-relaxed">
                {rest.join(" ").trim()}
              </p>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
