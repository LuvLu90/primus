"use client";

// 移植自 lore-glass（MIT，见本目录 LICENSE-lore-glass）：无障碍原语由 @base-ui/react 换成本项目统一使用的 Radix UI，
// 视觉沿用原组件；进出场动画改用 globals.css 中的 glass-pop 关键帧（Radix 以 data-state 驱动）。
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { GlassSurface } from "@/components/ui/glass-surface";
import { cn } from "@/lib/utils";

const GlassTooltipProvider = TooltipPrimitive.Provider;

/** 每个提示自带 Provider（与 shadcn 当前做法一致），单独渲染组件时无需外层包裹 */
function GlassTooltip({
  delayDuration = 500,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  );
}
const GlassTooltipTrigger = TooltipPrimitive.Trigger;

interface GlassTooltipContentProps extends ComponentProps<typeof TooltipPrimitive.Content> {
  tint?: number;
  tintColor?: string;
}

function GlassTooltipContent({
  align = "center",
  side = "top",
  sideOffset = 8,
  tint = 0.6,
  tintColor,
  className,
  children,
  ...props
}: GlassTooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "glass-pop z-50 [--glass-origin:var(--radix-tooltip-content-transform-origin)]",
          className,
        )}
        {...props}
      >
        <GlassSurface blur={12} radius={999} tint={tint} tintColor={tintColor}>
          <span className="block whitespace-nowrap px-3 py-1.5 font-medium text-xs text-fg leading-none">
            {children}
          </span>
        </GlassSurface>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export type { GlassTooltipContentProps };
export { GlassTooltip, GlassTooltipContent, GlassTooltipProvider, GlassTooltipTrigger };
