// 图标的 HTML 字符串版本：给 dangerouslySetInnerHTML 渲染的内容用（如 Markdown 回复里的文件引用）。
// 与 <Icon> 同一份数据、同样的线宽规则；尺寸由调用方的 CSS 类决定（例如按 em 跟随文字）。
import { FILE_ICONS, type FileIconName } from "./file-icons.generated";
import { adjustStroke, type IconName, type IconSize, strokeExtra } from "./icon";
import type { IconNode } from "./icon-node";
import { ICON_NODES } from "./icons.generated";

const escapeAttr = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** React 属性名 → SVG 属性名（strokeWidth → stroke-width） */
const svgAttr = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function nodesToHtml(nodes: readonly IconNode[], extra: number): string {
  return nodes
    .map(([tag, attrs, children]) => {
      const props = Object.entries(adjustStroke(tag, attrs, extra))
        .map(([k, v]) => ` ${svgAttr(k)}="${escapeAttr(v)}"`)
        .join("");
      return `<${tag}${props}>${children ? nodesToHtml(children, extra) : ""}</${tag}>`;
    })
    .join("");
}

/**
 * 装饰性图标的 SVG 字符串（aria-hidden）。`strokeFor` 是渲染时大致对应的尺寸令牌，
 * 只用来选线宽，使各处图标线宽一致；实际大小由 `className` 的 CSS 决定。
 */
export function iconHtml(name: IconName, className: string, strokeFor: IconSize = "sm"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" focusable="false" aria-hidden="true" data-icon="${name}" class="${escapeAttr(className)}">${nodesToHtml(ICON_NODES[name], strokeExtra(strokeFor))}</svg>`;
}

/** 彩色文件类型图标的 SVG 字符串（与 <FileIcon> 同一份数据，颜色是 --color-file-* 令牌；装饰性） */
export function fileIconHtml(name: FileIconName, className: string): string {
  const icon = FILE_ICONS[name];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.viewBox}" fill="none" focusable="false" aria-hidden="true" data-file-icon="${name}" class="${escapeAttr(className)}">${nodesToHtml(icon.nodes, 0)}</svg>`;
}
