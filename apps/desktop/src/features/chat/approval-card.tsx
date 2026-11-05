"use client";

// 扩展对话框（primus-guard 的操作确认等，RPC 的 extension_ui_request）：显示在输入框上方，回答后消失。
// select 显示为一排按钮；confirm 为“允许 / 拒绝”；input、editor 为文本框。关闭按钮回 cancelled。
import type { ExtensionUiDialogRequest, ExtensionUiResponse } from "@primus/protocol";
import { ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";

const t = strings.chat.approval;

/** 拒绝类选项用醒目的样式（primus-guard 的“拒绝”） */
const DENY = new Set(["拒绝", "No", "Deny"]);

export function ApprovalCard({
  request,
  onRespond,
}: {
  request: ExtensionUiDialogRequest;
  onRespond: (response: ExtensionUiResponse) => void;
}) {
  const [text, setText] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
  const cancel = () =>
    onRespond({ type: "extension_ui_response", id: request.id, cancelled: true });
  const button =
    "rounded-full px-3.5 py-1.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40";

  return (
    <section
      role="alertdialog"
      aria-label={t.label}
      className="mx-auto mb-2 flex w-full max-w-xl flex-col gap-2.5 rounded-[18px] bg-surface px-4 py-3 text-[13px] shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border"
    >
      <div className="flex items-start gap-2.5">
        <ShieldQuestion aria-hidden size={16} className="mt-0.5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">{t.title}</p>
          {/* 长命令（多行脚本、heredoc）限高滚动，卡片不撑高遮住对话 */}
          <div className="mt-0.5 max-h-[min(9rem,22vh)] overflow-y-auto overscroll-contain pr-1">
            <p className="whitespace-pre-wrap break-words font-mono text-[12px] text-muted">
              {request.title}
            </p>
            {request.method === "confirm" && request.message && (
              <p className="mt-1 whitespace-pre-wrap break-words text-muted">{request.message}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={t.dismiss}
          title={t.dismiss}
          onClick={cancel}
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
        >
          <X aria-hidden size={14} />
        </button>
      </div>
      {request.method === "select" && (
        <div className="flex flex-wrap justify-end gap-2">
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() =>
                onRespond({ type: "extension_ui_response", id: request.id, value: option })
              }
              className={cn(
                button,
                DENY.has(option)
                  ? "bg-hover text-danger ring-1 ring-danger/30 hover:bg-danger/10"
                  : option === request.options[0]
                    ? "bg-fg text-surface hover:opacity-90"
                    : "bg-hover text-fg hover:bg-black/10 dark:hover:bg-white/15",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {request.method === "confirm" && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() =>
              onRespond({ type: "extension_ui_response", id: request.id, confirmed: false })
            }
            className={cn(button, "bg-hover text-danger ring-1 ring-danger/30")}
          >
            {t.deny}
          </button>
          <button
            type="button"
            onClick={() =>
              onRespond({ type: "extension_ui_response", id: request.id, confirmed: true })
            }
            className={cn(button, "bg-fg text-surface hover:opacity-90")}
          >
            {t.allow}
          </button>
        </div>
      )}
      {(request.method === "input" || request.method === "editor") && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onRespond({ type: "extension_ui_response", id: request.id, value: text });
          }}
        >
          {request.method === "input" ? (
            <input
              aria-label={request.title}
              value={text}
              placeholder={request.placeholder}
              onChange={(e) => setText(e.target.value)}
              className="rounded-xl bg-hover px-3 py-1.5 outline-none"
            />
          ) : (
            <textarea
              aria-label={request.title}
              value={text}
              rows={4}
              onChange={(e) => setText(e.target.value)}
              className="resize-none rounded-xl bg-hover px-3 py-1.5 outline-none"
            />
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={cancel} className={cn(button, "bg-hover")}>
              {t.cancel}
            </button>
            <button type="submit" className={cn(button, "bg-fg text-surface")}>
              {t.submit}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
