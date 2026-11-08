import { createElement, type ReactNode, type SVGProps } from "react";
import { cn } from "@/lib/utils";
import { FILE_ICONS, type FileIconName } from "./file-icons.generated";
import type { IconSize } from "./icon";
import type { IconNode } from "./icon-node";

export type { FileIconName };

// 写成完整类名，Tailwind 才能扫描到（与 <Icon> 同一套尺寸令牌）
const SIZE_CLASS: Record<IconSize, string> = {
  "2xs": "size-icon-2xs",
  xs: "size-icon-xs",
  sm: "size-icon-sm",
  md: "size-icon-md",
  lg: "size-icon-lg",
  xl: "size-icon-xl",
};

export interface FileIconProps
  extends Omit<SVGProps<SVGSVGElement>, "children" | "fill" | "stroke" | "color" | "strokeWidth"> {
  name: FileIconName;
  size?: IconSize;
}

function render(nodes: readonly IconNode[]): ReactNode[] {
  return nodes.map(([tag, attrs, children], i) =>
    createElement(tag, { key: i, ...attrs }, children ? render(children) : undefined),
  );
}

/**
 * 彩色文件类型图标（Material Icon Theme，见 NOTICE.md）：文件引用胶囊、附件、工具行里按扩展名显示。
 * 是图标规范里唯一的多色图标：颜色来自 globals.css 的 --color-file-* 令牌，不继承文字颜色，
 * 所以不要给它加 text-* 颜色类。总是装饰性的（aria-hidden）：文件名就在旁边。
 */
export function FileIcon({ name, size = "md", className, ...rest }: FileIconProps) {
  const icon = FILE_ICONS[name];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={icon.viewBox}
      fill="none"
      focusable="false"
      aria-hidden="true"
      data-file-icon={name}
      className={cn("shrink-0", SIZE_CLASS[size], className)}
      {...rest}
    >
      {render(icon.nodes)}
    </svg>
  );
}
