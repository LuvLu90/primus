"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  type ComponentProps,
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const CONTENT_CLASS =
  "ui-tooltip z-[100] max-w-80 select-none whitespace-pre-line break-words rounded-md px-2 py-1 text-2xs";

/** 悬停多久后出现（毫秒）；在提示之间移动时 300 ms 内直接切换，不再等待 */
export const TOOLTIP_DELAY = 300;

interface TooltipProps
  extends Omit<ComponentProps<typeof TooltipPrimitive.Trigger>, "content" | "children"> {
  /** 提示内容；为空（undefined / null / false / ""）时不加提示，直接渲染子元素 */
  content: ReactNode;
  /** 触发元素：单个能接收 ref 与事件属性的元素（原生元素或转发了它们的组件） */
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /**
   * 用一层 inline-flex 的 span 包住触发元素。禁用的按钮收不到指针事件，提示出不来；
   * 会在禁用与可用之间切换的按钮传 true（包装层始终存在，切换时按钮不会重新挂载）。
   */
  wrap?: boolean;
  className?: string;
}

/**
 * 统一的悬停提示，替代原生 title（原生提示样式随系统、延迟约 1 秒、不跟随主题）。
 * 深色底小字（text-2xs）、圆角，约 300 ms 后轻微淡入；靠近窗口边缘时自动翻转/平移避让（Radix 碰撞检测）；
 * 打开时触发元素带 aria-describedby 指向提示内容，键盘聚焦也会显示。
 * 每个提示自带 Provider，单独渲染（含测试）时不需要外层包裹。
 *
 * 其余属性与 ref 原样交给触发元素，所以可以放在别的 asChild 触发器（弹出菜单、Popover）里面。
 * 内容为空时仍渲染同样的结构、只是不弹出，内容出现/消失不会让触发元素重新挂载。
 * 只有键盘聚焦（:focus-visible）才弹出：弹出菜单关闭后把焦点还给按钮时不冒出提示。
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  wrap = false,
  className,
  onFocus,
  ...triggerProps
}: TooltipProps) {
  const empty = content === undefined || content === null || content === false || content === "";
  // 始终受控：内容在有无之间切换时不在受控/非受控间来回变
  const [open, setOpen] = useState(false);
  // 内容变空时把打开状态也清掉：受控值已是 false，移开时 Radix 不会再通知关闭，
  // 否则下次内容出现时没有悬停也会直接弹出
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);
  return (
    <TooltipPrimitive.Provider delayDuration={TOOLTIP_DELAY} skipDelayDuration={TOOLTIP_DELAY}>
      <TooltipPrimitive.Root open={!empty && open} onOpenChange={setOpen}>
        <TooltipPrimitive.Trigger
          asChild
          {...triggerProps}
          onFocus={(e: FocusEvent<HTMLButtonElement>) => {
            onFocus?.(e);
            if (!e.defaultPrevented && !isFocusVisible(e.target)) e.preventDefault();
          }}
        >
          {wrap ? <span className="ui-tooltip-wrap inline-flex">{children}</span> : children}
        </TooltipPrimitive.Trigger>
        {!empty && (
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side={side}
              align={align}
              sideOffset={6}
              collisionPadding={8}
              className={cn(
                "ui-tooltip z-[100] max-w-80 select-none whitespace-pre-line break-words rounded-md px-2 py-1 text-2xs",
                className,
              )}
            >
              {content}
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        )}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    // 不支持 :focus-visible 的环境（旧版 jsdom）按键盘聚焦处理
    return true;
  }
}

/** 委托提示读取的属性：dangerouslySetInnerHTML 渲染的 HTML（如 Markdown 里的文件引用）用它代替 title */
export const TOOLTIP_ATTR = "data-tooltip";

interface DelegatedTip {
  el: HTMLElement;
  text: string;
  rect: DOMRect;
}

/**
 * 给一块 HTML 字符串渲染的内容加上与 Tooltip 相同的悬停提示：内容里的元素写 `data-tooltip="…"`，
 * 容器挂上返回的 handlers、在旁边渲染 ui。外观、延迟、边缘避让与 Tooltip 一致（同一个 Radix 定位，
 * 锚点是盖在目标元素位置上的透明占位），打开时目标元素带 aria-describedby。
 */
export function useDelegatedTooltip(): {
  handlers: {
    onPointerOver: (e: { target: EventTarget }) => void;
    onPointerOut: (e: { relatedTarget: EventTarget | null }) => void;
    onPointerDown: () => void;
    onFocus: (e: { target: EventTarget }) => void;
    onBlur: () => void;
  };
  ui: ReactNode;
} {
  const [tip, setTip] = useState<DelegatedTip | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 刚关掉一个提示后马上移到下一个：直接显示，不再等待（与 Tooltip 的 skipDelayDuration 一致）
  const lastClosed = useRef(0);
  const id = useId();

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (current.current) lastClosed.current = Date.now();
    current.current = null;
    setTip(null);
  }, []);

  const show = useCallback((el: HTMLElement, immediate: boolean) => {
    const text = el.getAttribute(TOOLTIP_ATTR);
    if (!text) return;
    clearTimeout(timer.current);
    current.current = el;
    const open = () => {
      if (current.current === el && el.isConnected)
        setTip({ el, text, rect: el.getBoundingClientRect() });
    };
    if (immediate || Date.now() - lastClosed.current < TOOLTIP_DELAY) open();
    else timer.current = setTimeout(open, TOOLTIP_DELAY);
  }, []);

  const find = (target: EventTarget | null): HTMLElement | null =>
    target instanceof Element ? target.closest<HTMLElement>(`[${TOOLTIP_ATTR}]`) : null;

  // 打开期间：目标元素带 aria-describedby；任何滚动或窗口变化都会让位置过时，直接关闭
  useEffect(() => {
    if (!tip) return;
    const { el } = tip;
    const before = el.getAttribute("aria-describedby");
    el.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    const close = () => hide();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      if (before === null) el.removeAttribute("aria-describedby");
      else el.setAttribute("aria-describedby", before);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [tip, id, hide]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const handlers = {
    onPointerOver: (e: { target: EventTarget }) => {
      const el = find(e.target);
      if (el && el !== current.current) show(el, false);
    },
    onPointerOut: (e: { relatedTarget: EventTarget | null }) => {
      const el = current.current;
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    },
    onPointerDown: hide,
    onFocus: (e: { target: EventTarget }) => {
      const el = find(e.target);
      if (el && e.target instanceof Element && isFocusVisible(e.target)) show(el, true);
    },
    onBlur: hide,
  };

  const ui =
    tip &&
    typeof document !== "undefined" &&
    createPortal(
      <TooltipPrimitive.Provider delayDuration={0}>
        <TooltipPrimitive.Root open onOpenChange={(open) => !open && hide()}>
          <TooltipPrimitive.Trigger asChild>
            <span
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none fixed"
              style={{
                left: tip.rect.left,
                top: tip.rect.top,
                width: tip.rect.width,
                height: tip.rect.height,
              }}
            />
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              side="top"
              sideOffset={6}
              collisionPadding={8}
              className={CONTENT_CLASS}
            >
              <span id={id}>{tip.text}</span>
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
      </TooltipPrimitive.Provider>,
      document.body,
    );

  return { handlers, ui };
}
