// 输入框底栏的“幽灵按钮”：无描边、无阴影，静止时只有弱化文字色，悬停 / 聚焦 / 菜单展开时铺一层 hover 底色。
// 左侧（附件、权限模式）与右侧（模型、上下文圆环）共用这一份样式，保证高度、圆角、内边距与配色不会各自漂移。
import { cn } from "@/lib/utils";

const base =
  "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full text-xs outline-hidden transition-colors disabled:opacity-40";

const tones = {
  /** 默认：弱化文字色，悬停变正文色 */
  muted:
    "text-muted hover:bg-hover hover:text-fg focus-visible:bg-hover data-[state=open]:bg-hover data-[state=open]:text-fg",
  /** 警示（完全访问）：文字与图标保持警示色，底色是淡淡的警示色 */
  warning:
    "text-warning hover:bg-warning/10 focus-visible:bg-warning/10 data-[state=open]:bg-warning/10",
} as const;

export type ComposerGhostTone = keyof typeof tones;

/**
 * 幽灵按钮的类名。`icon`：只有图标的方形按钮（32×32）；否则是带文字的胶囊（左右 10px 内边距）。
 * 图标统一用 `size="sm"`（14px），与 `text-xs` 文字搭配
 */
export function composerGhostClass({
  icon = false,
  tone = "muted",
  className,
}: {
  icon?: boolean;
  tone?: ComposerGhostTone;
  className?: string;
} = {}): string {
  return cn(base, icon ? "w-8" : "px-2.5", tones[tone], className);
}
