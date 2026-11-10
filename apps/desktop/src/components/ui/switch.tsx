"use client";

import { cn } from "@/lib/utils";

interface SwitchProps {
  ariaLabel: string;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 开关（自绘）：原生 checkbox（role="switch"）负责语义与键盘，外观是凹槽轨道 + 液态玻璃水滴滑块。
 * 打开时轨道变强调色、水滴平滑滑到右侧。不用过冲缓动、按压时也不变宽：
 * 两者叠加会让点击瞬间滑块先鼓一下再回弹，看起来像“先弹一下”。
 */
export function Switch({ ariaLabel, checked, onCheckedChange, disabled, className }: SwitchProps) {
  return (
    <label
      className={cn(
        "relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer",
        disabled && "cursor-not-allowed opacity-80",
        className,
      )}
    >
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        readOnly={!onCheckedChange}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className="peer absolute inset-0 z-10 m-0 cursor-[inherit] appearance-none rounded-full opacity-0"
      />
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full transition-colors duration-200 motion-reduce:transition-none",
          "bg-black/[0.09] shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)] dark:bg-white/[0.12]",
          "peer-checked:bg-accent peer-checked:shadow-[inset_0_1px_2px_rgb(0_0_0/0.18)]",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40 peer-focus-visible:ring-offset-1",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "glass-knob pointer-events-none absolute top-[2px] left-[2px] h-[22px] w-[22px] rounded-full",
          "transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
          "peer-checked:translate-x-[20px]",
        )}
      />
    </label>
  );
}
