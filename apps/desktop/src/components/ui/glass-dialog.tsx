"use client";

// 移植自 lore-glass（MIT，见本目录 LICENSE-lore-glass）：无障碍原语由 @base-ui/react 换成本项目统一使用的 Radix UI，
// 视觉沿用原组件；进出场动画改用 globals.css 中的 glass-pop 关键帧（Radix 以 data-state 驱动）。
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { GlassSurface } from "@/components/ui/glass-surface";
import { cn } from "@/lib/utils";

const GlassDialog = DialogPrimitive.Root;
const GlassDialogTrigger = DialogPrimitive.Trigger;
const GlassDialogClose = DialogPrimitive.Close;

interface GlassDialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  tint?: number;
  tintColor?: string;
}

function GlassDialogContent({
  tint = 0.75,
  tintColor,
  className,
  children,
  ...props
}: GlassDialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="glass-fade fixed inset-0 z-50 bg-black/35 backdrop-blur-[8px]" />
      <DialogPrimitive.Content
        className={cn(
          "glass-pop -translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 outline-none [--glass-origin:center]",
          className,
        )}
        {...props}
      >
        <GlassSurface blur={24} radius={28} tint={tint} tintColor={tintColor}>
          <div className="w-[min(calc(100vw-2rem),400px)] p-6 text-fg">{children}</div>
        </GlassSurface>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function GlassDialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("font-semibold text-lg tracking-tight", className)}
      {...props}
    />
  );
}

function GlassDialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("mt-1.5 text-sm leading-relaxed opacity-65", className)}
      {...props}
    />
  );
}

export type { GlassDialogContentProps };
export {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
  GlassDialogTrigger,
};
