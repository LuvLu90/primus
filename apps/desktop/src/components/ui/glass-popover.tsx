"use client";

// 移植自 lore-glass（MIT，见本目录 LICENSE-lore-glass）：无障碍原语由 @base-ui/react 换成本项目统一使用的 Radix UI，
// 视觉沿用原组件；进出场动画改用 globals.css 中的 glass-pop 关键帧（Radix 以 data-state 驱动）。
// 原组件是 iOS 上下文菜单（菜单语义），这里对应 Radix DropdownMenu。
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { GlassSurface } from "@/components/ui/glass-surface";
import { cn } from "@/lib/utils";

const GlassPopover = MenuPrimitive.Root;
const GlassPopoverTrigger = MenuPrimitive.Trigger;

interface GlassPopoverContentProps extends ComponentProps<typeof MenuPrimitive.Content> {
  tint?: number;
  tintColor?: string;
  /** 菜单最小宽度（px） */
  minWidth?: number;
}

function GlassPopoverContent({
  align = "start",
  side = "bottom",
  sideOffset = 10,
  tint = 0.55,
  tintColor,
  minWidth = 220,
  className,
  children,
  ...props
}: GlassPopoverContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "glass-pop z-50 outline-none [--glass-origin:var(--radix-dropdown-menu-content-transform-origin)]",
          className,
        )}
        {...props}
      >
        <GlassSurface blur={30} radius={22} tint={tint} tintColor={tintColor}>
          <div className="py-2" style={{ minWidth }}>
            {children}
          </div>
        </GlassSurface>
      </MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

interface GlassPopoverItemProps
  extends Omit<ComponentProps<typeof MenuPrimitive.Item>, "children"> {
  destructive?: boolean;
  icon?: ReactNode;
  label: string;
  sublabel?: string;
}

function GlassPopoverItem({
  destructive = false,
  icon,
  label,
  sublabel,
  className,
  ...props
}: GlassPopoverItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "mx-2 flex cursor-default select-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-fg outline-none data-[highlighted]:bg-black/8 data-[disabled]:opacity-45 dark:data-[highlighted]:bg-white/12",
        destructive && "text-danger",
        className,
      )}
      textValue={label}
      {...props}
    >
      {icon ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm leading-tight">{label}</span>
        {sublabel ? (
          <span className="truncate text-xs leading-tight opacity-55">{sublabel}</span>
        ) : null}
      </span>
    </MenuPrimitive.Item>
  );
}

function GlassPopoverSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-4 my-1.5 h-px bg-black/10 dark:bg-white/12", className)}
      {...props}
    />
  );
}

export type { GlassPopoverContentProps, GlassPopoverItemProps };
export {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverItem,
  GlassPopoverSeparator,
  GlassPopoverTrigger,
};
