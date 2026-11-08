import { createElement, type ReactNode, type SVGProps } from "react";
import { cn } from "@/lib/utils";
import type { IconNode } from "./icon-node";
import { ICON_NODES, type IconName } from "./icons.generated";

export type { IconName };

/**
 * 图标尺寸令牌（globals.css @theme 的 --spacing-icon-*）：
 *   2xs 10px  附件图块角标、语音停止
 *   xs  12px  11px 文字旁、标题栏最大化 / 还原、发送区的停止
 *   sm  14px  12–13px 文字旁（菜单项、列表行、唇条、小按钮）
 *   md  16px  14–15px 文字旁、工具栏按钮（默认）
 *   lg  20px  空状态、对话框与提示条的主图标
 *   xl  24px  附件图块、大号空状态
 */
export type IconSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl";

// 写成完整类名，Tailwind 才能扫描到
const SIZE_CLASS: Record<IconSize, string> = {
  "2xs": "size-icon-2xs",
  xs: "size-icon-xs",
  sm: "size-icon-sm",
  md: "size-icon-md",
  lg: "size-icon-lg",
  xl: "size-icon-xl",
};

export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, "children" | "fill" | "stroke" | "color" | "strokeWidth"> {
  name: IconName;
  size?: IconSize;
  /** 有独立含义的图标才给名称（role="img"）；默认装饰性，aria-hidden */
  label?: string;
}

const SIZE_PX: Record<IconSize, number> = { "2xs": 10, xs: 12, sm: 14, md: 16, lg: 20, xl: 24 };

/** 渲染后的线宽（px），所有尺寸一致；与 globals.css 里图标尺寸阶梯的说明保持一致 */
export const ICON_STROKE_PX = 1.25;
/** 源图标在 24 网格上的线宽 */
const SOURCE_STROKE = 1.5;

/**
 * 统一线宽：源图标线宽 1.5/24 随尺寸缩放（16px 时只有 1px，10px 时 0.6px）。
 * 小尺寸给每条线加粗 extra（网格单位），使渲染线宽都约为 ICON_STROKE_PX：
 * 描边元素直接加到 stroke-width；Reicon 的轮廓化（填充）路径外加一圈同色描边，效果相同。
 */
export function strokeExtra(size: IconSize): number {
  const extra = (ICON_STROKE_PX * 24) / SIZE_PX[size] - SOURCE_STROKE;
  return extra > 0.01 ? Math.round(extra * 100) / 100 : 0;
}

function render(nodes: readonly IconNode[], extra: number): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) => {
    let props: Record<string, string> = attrs;
    if (extra > 0 && tag !== "g") {
      if (attrs.strokeWidth) props = { ...attrs, strokeWidth: String(SOURCE_STROKE + extra) };
      else if (attrs.fill === "currentColor")
        props = {
          ...attrs,
          stroke: "currentColor",
          strokeWidth: String(extra),
          strokeLinejoin: "round",
        };
    }
    return createElement(tag, { key: i, ...props }, children ? render(children, extra) : undefined);
  });
}

/**
 * 全局唯一的图标组件（Reicon Outline，24px 网格，见 NOTICE.md）。各尺寸渲染线宽统一为 ICON_STROKE_PX。
 * 颜色只继承文字颜色（currentColor）：需要弱化、危险、警告等颜色时给图标或其父元素加
 * text-muted / text-danger / text-warning / text-success 等设计令牌类，不写 opacity 或任意颜色。
 */
export function Icon({ name, size = "md", label, className, ...rest }: IconProps) {
  const props = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    focusable: "false",
    "data-icon": name,
    className: cn("shrink-0", SIZE_CLASS[size], className),
    ...rest,
  } as const;
  const children = render(ICON_NODES[name], strokeExtra(size));
  return label ? (
    <svg {...props} role="img" aria-label={label}>
      {children}
    </svg>
  ) : (
    <svg {...props} aria-hidden="true">
      {children}
    </svg>
  );
}
