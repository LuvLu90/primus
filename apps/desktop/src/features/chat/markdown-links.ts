// Markdown 回复里的链接与文件引用（markdown-it 插件）：
// - 链接地址或行内代码是本地文件路径时，换成文件引用胶囊：类型图标 + 文件名 + 行号，完整路径在提示里；
// - http(s) 链接保持普通文字链接，末尾加一个弱化的外链图标，与文件引用一眼区分。
// 文件引用渲染成 <button data-file-ref data-path>，点击由 MarkdownText 统一处理：用系统默认程序打开，
// 右键菜单可在文件夹中显示、复制路径（见 file-ref-actions.tsx）。
import type MarkdownIt from "markdown-it";
import type { StateCore, Token } from "markdown-it";
import { fileIconHtml, iconHtml } from "@/components/icons";
import { strings } from "@/lib/strings";
import {
  type FileRef,
  fileRefCopyText,
  fileRefFromCode,
  fileRefFromHref,
  fileRefIcon,
  fileRefLineLabel,
} from "./file-ref";

interface FileRefMeta {
  ref: FileRef;
  /** 链接文字与路径不同（如“发送逻辑”）时显示它，否则显示文件名 */
  label?: string;
}

const EXTERNAL = /^https?:\/\//i;

/** 文件引用的无障碍名称 */
export function fileRefAriaLabel(ref: FileRef, name = ref.name): string {
  const t = strings.chat.fileRef;
  const tpl = ref.isDir ? t.folder : ref.endLine ? t.labelRange : ref.line ? t.labelLine : t.label;
  return tpl
    .replace("{name}", name)
    .replace("{line}", String(ref.line ?? ""))
    .replace("{end}", String(ref.endLine ?? ""));
}

/** 链接文字：只取文本与行内代码的内容 */
function plainText(tokens: Token[]): string {
  return tokens
    .map((t) =>
      t.type === "text" || t.type === "code_inline" || t.type === "text_special" ? t.content : "",
    )
    .join("")
    .trim();
}

/** 链接文字本身就是这个路径（或其文件名、带不带行号）时不另外显示 */
function sameTarget(label: string, ref: FileRef): boolean {
  if (!label) return true;
  const other = fileRefFromHref(label);
  return !!other && (other.path === ref.path || other.name === ref.name);
}

function transform(children: Token[], TokenCtor: StateCore["Token"]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < children.length; i++) {
    const tok = children[i] as Token;
    if (tok.type === "code_inline") {
      const ref = fileRefFromCode(tok.content);
      if (ref) {
        const t = new TokenCtor("file_ref", "", 0);
        t.meta = { ref } satisfies FileRefMeta;
        t.content = tok.content;
        out.push(t);
        continue;
      }
    }
    if (tok.type === "link_open") {
      let close = i + 1;
      while (close < children.length && children[close]?.type !== "link_close") close++;
      const href = tok.attrGet("href") ?? "";
      // 自动识别出的链接（linkify）只会是网址、邮箱，不当文件：markdown-it 15 默认关闭 fuzzyLink，
      // README.md、main.rs 这类不带协议的文字不会被识别成网址（见测试）
      const ref = tok.markup === "linkify" ? null : fileRefFromHref(href);
      if (ref && close < children.length) {
        const label = plainText(children.slice(i + 1, close));
        const t = new TokenCtor("file_ref", "", 0);
        t.meta = { ref, label: sameTarget(label, ref) ? undefined : label } satisfies FileRefMeta;
        out.push(t);
        i = close;
        continue;
      }
      if (EXTERNAL.test(href) && close < children.length) {
        tok.attrSet("class", "md-link");
        (children[close] as Token).meta = { external: true };
      }
    }
    out.push(tok);
  }
  return out;
}

export function renderFileRef(meta: FileRefMeta, escapeHtml: (s: string) => string): string {
  const { ref, label } = meta;
  const name = label || ref.name;
  const line = fileRefLineLabel(ref);
  const copy = fileRefCopyText(ref);
  return [
    `<button type="button" class="md-file" data-file-ref="${escapeHtml(copy)}"`,
    ` data-path="${escapeHtml(ref.path)}" data-name="${escapeHtml(ref.name)}"`,
    ` title="${escapeHtml(`${ref.path}${line}\n${strings.chat.fileRef.hint}`)}"`,
    ` aria-label="${escapeHtml(fileRefAriaLabel(ref, name))}">`,
    fileIconHtml(fileRefIcon(ref), "md-file-icon"),
    iconHtml("check", "md-file-done"),
    `<span class="md-file-name">${escapeHtml(name)}</span>`,
    line ? `<span class="md-file-line">${escapeHtml(line)}</span>` : "",
    "</button>",
  ].join("");
}

/** 安装插件：识别文件引用、标记外部链接 */
export function linksPlugin(md: MarkdownIt): void {
  const validate = md.validateLink.bind(md);
  // 默认不认 file:// 链接；能识别成文件引用的才放行（渲染成按钮，不会跳转），
  // 识别不了的（如 file:///）仍不生成链接，避免出现可中键打开的 file: 地址
  md.validateLink = (url) =>
    /^file:/i.test(url.trim()) ? fileRefFromHref(url) !== null : validate(url);
  md.core.ruler.push("primus_links", (state) => {
    for (const block of state.tokens) {
      if (block.type === "inline" && block.children)
        block.children = transform(block.children, state.Token);
    }
  });
  const escapeHtml = md.utils.escapeHtml;
  md.renderer.rules.file_ref = (tokens, idx) =>
    renderFileRef(tokens[idx]?.meta as FileRefMeta, escapeHtml);

  const defaultOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  // 链接不在应用窗口内跳转：点击时由 MarkdownText 拦截，确认后交给系统浏览器（open_external）
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    tokens[idx]?.attrSet("target", "_blank");
    tokens[idx]?.attrSet("rel", "noreferrer noopener");
    return defaultOpen(tokens, idx, options, env, self);
  };
  const defaultClose =
    md.renderer.rules.link_close ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const externalIcon = iconHtml("external-link", "md-link-icon", "xs");
  md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
    const external = (tokens[idx]?.meta as { external?: boolean } | null)?.external;
    const tail = external
      ? `<span class="sr-only">${escapeHtml(strings.chat.linkExternal)}</span>${externalIcon}`
      : "";
    return tail + defaultClose(tokens, idx, options, env, self);
  };
}
