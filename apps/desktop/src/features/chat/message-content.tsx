"use client";

// 回复正文：Markdown 渲染 + 流式输出时的平滑打字效果，以及“正在思考”提示。
import MarkdownIt from "markdown-it";
import { type MouseEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  GlassDialog,
  GlassDialogClose,
  GlassDialogContent,
  GlassDialogDescription,
  GlassDialogTitle,
} from "@/components/ui/glass-dialog";
import { getPlatform } from "@/lib/platform";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

// 不渲染原始 HTML（回复内容不可信，html: false 时所有 HTML 标签按文本转义）；链接自动识别
const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
// 链接不在应用窗口内跳转：点击时由 MarkdownText 拦截，确认后交给系统浏览器（open_external）
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]?.attrSet("target", "_blank");
  tokens[idx]?.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}

/** 每步追上积压字符的这一比例：积压多时快、少时慢，约 1/3 秒追平，读起来像连续输出 */
const CATCH_UP_STEPS = 10;
/** 两步之间至少间隔（毫秒） */
const MIN_STEP_MS = 32;

/**
 * 平滑显示流式文本：模型往往一次吐出一整段，直接显示会“蹦”出来。
 * 这里按帧逐步揭示新到的字符；`animate` 为 false（历史消息、减少动态效果）时直接显示全文。
 * 流式结束后仍把剩余部分播完，不会在最后一下跳出。
 */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** 系统“减少动态效果”是否开启；设置变化时更新 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(REDUCED_MOTION);
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function useSmoothText(text: string, animate: boolean): string {
  const reducedMotion = usePrefersReducedMotion();
  const canAnimate = animate && !reducedMotion && typeof requestAnimationFrame === "function";
  const [shown, setShown] = useState(() => (canAnimate ? 0 : text.length));
  const shownRef = useRef(shown);
  const playing = useRef(canAnimate);
  if (canAnimate) playing.current = true;
  // 播放中途开启减少动态效果：立即停下并显示全文
  if (reducedMotion) playing.current = false;

  useEffect(() => {
    if (!playing.current || reducedMotion) {
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    // 文本被整体替换得更短（如 message_end 定稿）时从新长度继续
    if (shownRef.current > text.length) {
      shownRef.current = text.length;
      setShown(text.length);
    }
    let frame = 0;
    let lastAt = 0;
    const tick = (at: number) => {
      const backlog = text.length - shownRef.current;
      if (backlog <= 0) {
        if (!animate) playing.current = false;
        return;
      }
      // 最多约 30 次/秒：每次都要重新解析整段 Markdown，逐帧（60~144Hz）刷新对长回复太重
      if (at - lastAt >= MIN_STEP_MS) {
        lastAt = at;
        shownRef.current += Math.max(1, Math.ceil(backlog / CATCH_UP_STEPS));
        setShown(shownRef.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, animate, reducedMotion]);

  return text.slice(0, Math.min(shown, text.length));
}

/** Markdown 正文；`streaming` 时平滑揭示新内容 */
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming,
  className,
}: {
  text: string;
  streaming: boolean;
  className?: string;
}) {
  const shown = useSmoothText(text, streaming);
  const html = useMemo(() => renderMarkdown(shown), [shown]);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  // 回复内容不可信：只处理 http/https 链接，打开前先确认（技术方案：点击外部链接前先确认）
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest?.("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      setLinkError(null);
      setPendingLink(href);
    }
  };
  const openLink = () => {
    const url = pendingLink;
    if (!url) return;
    getPlatform()
      .then((platform) => platform.openExternal(url))
      .then(
        () => setPendingLink(null),
        () => setLinkError(strings.chat.linkFailed),
      );
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: 只拦截内部链接的点击，链接本身可用键盘聚焦并以 Enter 触发 click */}
      <div
        className={cn("md", className)}
        onClick={onClick}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it 关闭了 html，输入中的标签已转义
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {pendingLink !== null && (
        <GlassDialog open onOpenChange={(open) => !open && setPendingLink(null)}>
          <GlassDialogContent>
            <GlassDialogTitle>{strings.chat.linkTitle}</GlassDialogTitle>
            <GlassDialogDescription>{strings.chat.linkDescription}</GlassDialogDescription>
            <p className="mt-3 break-all font-mono text-[12px] text-muted">{pendingLink}</p>
            {linkError && <p className="mt-2 text-[13px] text-danger">{linkError}</p>}
            <div className="mt-5 flex justify-end gap-2 text-sm">
              <GlassDialogClose asChild>
                <button type="button" className="rounded-full bg-hover px-4 py-1.5">
                  {strings.chat.linkCancel}
                </button>
              </GlassDialogClose>
              <button
                type="button"
                onClick={openLink}
                className="rounded-full bg-hover px-4 py-1.5 font-medium ring-1 ring-border"
              >
                {strings.chat.linkOpen}
              </button>
            </div>
          </GlassDialogContent>
        </GlassDialog>
      )}
    </>
  );
});

/** 等待回复时的提示：流光文字 + 跳动的三个点 */
export function ThinkingIndicator({ label = strings.chat.thinkingNow }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="msg-in flex items-center gap-2 self-start text-[13px]"
    >
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="shimmer-text">{label}</span>
    </div>
  );
}
