"use client";

import type { AgentMessage } from "@primus/protocol";
import {
  Brain,
  ChevronRight,
  FilePen,
  FileText,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useId, useState } from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { TimelineContent, ToolRun } from "@/stores/session-store";
import { MarkdownText, ThinkingIndicator } from "./message-content";

// 一轮回复（一条用户消息之后的全部助手消息与工具结果）按“工作过程 + 总结”展示：
// 业界一般叫 Chain of Thought / 推理与工具调用分组（Vercel AI Elements 的 ChainOfThought、
// assistant-ui 的 GroupedParts、Codex 桌面版的“Worked for 8m 28s”）。
// 中间的思考、过程说明、工具调用折叠进可展开的工作过程，运行中自动展开、实时追加；
// 结束后自动收起成“用时 8m 28s”，最后一条不带工具调用的回复作为总结显示在下面。

const t = strings.chat.work;

type ToolKind = keyof typeof t.tools;

const toolKinds: Record<string, ToolKind> = {
  read: "read",
  bash: "bash",
  edit: "edit",
  write: "write",
  grep: "search",
  find: "search",
  ls: "search",
  glob: "search",
};

const toolIcons: Record<ToolKind, LucideIcon> = {
  read: FileText,
  bash: SquareTerminal,
  edit: FilePen,
  write: FilePen,
  search: Search,
  other: Wrench,
};

const kindOf = (name: string): ToolKind => toolKinds[name] ?? "other";

type ToolCallBlock = Extract<TimelineContent, { type: "toolCall" }>;

type Step =
  | { kind: "note"; key: string; text: string; live: boolean }
  | { kind: "thought"; key: string; text: string; live: boolean }
  | { kind: "tools"; key: string; calls: ToolCallBlock[] };

interface TurnLayout {
  steps: Step[];
  /** 总结：最后一条不带工具调用的回复的正文 */
  answer: { key: string; text: string; live: boolean }[];
  /** 最后一条助手消息（停止、出错的标记跟在总结后面） */
  last?: Extract<AgentMessage, { role: "assistant" }>;
  end?: number;
}

const hasText = (b: TimelineContent | undefined) => b?.type === "text" && b.text.trim() !== "";

function layoutTurn(messages: AgentMessage[], streaming: boolean): TurnLayout {
  const assistants = messages.filter(
    (m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant",
  );
  const last = assistants.at(-1);
  const lastContent = ((last?.content as TimelineContent[]) ?? []).filter(Boolean);
  const lastIsAnswer =
    lastContent.length > 0 &&
    !lastContent.some((b) => b.type === "toolCall") &&
    lastContent.some(hasText);

  const steps: Step[] = [];
  const answer: TurnLayout["answer"] = [];
  assistants.forEach((m, mi) => {
    const content = ((m.content as TimelineContent[]) ?? []).filter(Boolean);
    const isLast = m === last;
    content.forEach((block, bi) => {
      const key = `${mi}-${bi}`;
      const live = streaming && isLast && bi === content.length - 1;
      if (block.type === "text") {
        if (!block.text.trim()) return;
        if (isLast && lastIsAnswer) answer.push({ key, text: block.text, live });
        else steps.push({ kind: "note", key, text: block.text, live });
      } else if (block.type === "thinking") {
        if (!block.thinking.trim()) return;
        steps.push({ kind: "thought", key, text: block.thinking, live });
      } else if (block.type === "toolCall") {
        const prev = steps.at(-1);
        if (prev?.kind === "tools") prev.calls.push(block);
        else steps.push({ kind: "tools", key, calls: [block] });
      }
    });
  });
  const stamps = messages
    .map((m) => (m as { timestamp?: number }).timestamp)
    .filter((n): n is number => typeof n === "number" && n > 0);
  return { steps, answer, last, end: stamps.length ? Math.max(...stamps) : undefined };
}

/** 8m 28s / 42s / 1h 3m（与 Codex 一致的紧凑写法） */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 运行中每秒刷新的当前时间 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** 高度平滑展开/收起：grid 行从 0fr 过渡到 1fr，内容同时淡入 */
function Collapse({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return (
    <div id={id} className="collapse-grid" data-open={open || undefined} inert={!open}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function argSummary(call: ToolCallBlock): string {
  const a = call.arguments ?? {};
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  const raw =
    pick("command") ??
    pick("path") ??
    pick("file_path") ??
    pick("pattern") ??
    pick("query") ??
    pick("url") ??
    "";
  return raw.split("\n")[0] ?? "";
}

function ToolGroup({
  calls,
  toolRuns,
}: {
  calls: ToolCallBlock[];
  toolRuns: Record<string, ToolRun>;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const statuses = calls.map((c) => toolRuns[c.id]?.status);
  const running = statuses.some((s) => s === "running" || s === undefined);
  const failed = statuses.filter((s) => s === "error").length;
  // 组标签：按出现顺序列出不同种类（“已读取文件、运行了命令”）；运行中的那一类用进行时
  const kinds = [...new Set(calls.map((c) => kindOf(c.name)))];
  const lastKind = kindOf(calls.at(-1)?.name ?? "");
  const label = kinds
    .map((k) => (running && k === lastKind ? t.tools[k].running : t.tools[k].done))
    .join("、");
  const Icon = toolIcons[lastKind];
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="group/step flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-[13px] text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Icon aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
        <span className={cn("truncate", running && "shimmer-text")}>{label}</span>
        {calls.length > 1 && <span className="tabular-nums opacity-70">{calls.length}</span>}
        {failed > 0 && (
          <span className="text-danger">
            · {failed} {t.failed}
          </span>
        )}
        <ChevronRight
          aria-hidden
          size={13}
          className={cn(
            "shrink-0 opacity-0 transition-[rotate,opacity] duration-300 ease-out group-hover/step:opacity-70",
            open && "rotate-90 opacity-70",
          )}
        />
      </button>
      <Collapse open={open} id={id}>
        <ul className="mt-1 mb-1 ml-[7px] flex flex-col gap-1 border-border border-l pl-3.5">
          {calls.map((c) => {
            const status = toolRuns[c.id]?.status ?? "running";
            const k = kindOf(c.name);
            return (
              <li key={c.id} className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    status === "running" && "animate-pulse bg-accent",
                    status === "done" && "bg-emerald-500/80",
                    status === "error" && "bg-danger",
                  )}
                />
                <span className="shrink-0">{k === "other" ? c.name : t.tools[k].done}</span>
                <code className="truncate font-mono text-[11.5px] opacity-80" title={argSummary(c)}>
                  {argSummary(c)}
                </code>
              </li>
            );
          })}
        </ul>
      </Collapse>
    </div>
  );
}

function ThoughtStep({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="group/step flex items-center gap-1.5 rounded-md py-0.5 text-[13px] text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Brain aria-hidden size={14} strokeWidth={1.75} />
        <span className={cn(live && "shimmer-text")}>{live ? t.thinkingNow : t.thought}</span>
        <ChevronRight
          aria-hidden
          size={13}
          className={cn(
            "opacity-0 transition-[rotate,opacity] duration-300 ease-out group-hover/step:opacity-70",
            open && "rotate-90 opacity-70",
          )}
        />
      </button>
      <Collapse open={open} id={id}>
        <p className="mt-1 mb-1 ml-[7px] whitespace-pre-wrap border-border border-l pl-3.5 text-[12.5px] text-muted leading-relaxed">
          {text}
        </p>
      </Collapse>
    </div>
  );
}

function StepView({ step, toolRuns }: { step: Step; toolRuns: Record<string, ToolRun> }) {
  if (step.kind === "tools") return <ToolGroup calls={step.calls} toolRuns={toolRuns} />;
  if (step.kind === "thought") return <ThoughtStep text={step.text} live={step.live} />;
  return (
    <MarkdownText
      text={step.text}
      streaming={step.live}
      className="text-[14px] text-fg/85 leading-relaxed"
    />
  );
}

export interface AgentTurnProps {
  /** 这一轮的助手消息与工具结果 */
  messages: AgentMessage[];
  toolRuns: Record<string, ToolRun>;
  /** 这一轮仍在进行（最后一轮且会话运行中） */
  running: boolean;
  /** 最后一条消息正在流式输出 */
  streaming: boolean;
  /** 用户消息的时间（计时起点） */
  startedAt?: number;
}

export const AgentTurn = memo(function AgentTurn({
  messages,
  toolRuns,
  running,
  streaming,
  startedAt,
}: AgentTurnProps) {
  const { steps, answer, last, end } = layoutTurn(messages, streaming);
  // 展开状态：用户点过就听用户的；否则运行中展开、结束后自动收起
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (running) setUserOpen(null);
  }, [running]);
  const open = userOpen ?? running;
  const now = useNow(running);
  const [mountedAt] = useState(() => Date.now());
  const start = startedAt && startedAt > 0 ? startedAt : mountedAt;
  const elapsed = formatElapsed((running ? now : (end ?? now)) - start);
  const id = useId();

  return (
    <article aria-label={strings.chat.assistant} className="msg-in flex flex-col gap-3">
      {steps.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? t.collapse : t.expand}
            onClick={() => setUserOpen(!open)}
            className="group/work flex items-center gap-1 self-start rounded-md py-0.5 text-[13px] text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {running ? <span className="shimmer-text">{t.running}</span> : <span>{t.elapsed}</span>}
            <span className="tabular-nums">{elapsed}</span>
            <ChevronRight
              aria-hidden
              size={14}
              className={cn(
                "transition-[rotate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                open && "rotate-90",
              )}
            />
          </button>
          <div
            className={cn(
              "mt-1.5 h-px bg-border transition-opacity duration-300",
              open ? "opacity-0" : "opacity-100",
            )}
          />
          <Collapse open={open} id={id}>
            <ol className="flex flex-col gap-2.5 pt-1 pb-1">
              {steps.map((step) => (
                <li key={step.key} className="msg-in">
                  <StepView step={step} toolRuns={toolRuns} />
                </li>
              ))}
            </ol>
          </Collapse>
        </div>
      )}
      {steps.length === 0 && answer.length === 0 && running && <ThinkingIndicator />}
      {answer.map((a) => (
        <MarkdownText
          key={a.key}
          text={a.text}
          streaming={a.live}
          className="msg-in font-serif text-[15px] leading-relaxed"
        />
      ))}
      {last?.stopReason === "aborted" && (
        <p className="self-start rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
          {strings.chat.stopped}
        </p>
      )}
      {last?.stopReason === "error" && (
        <p className="text-danger text-xs">
          {strings.chat.replyFailed}
          {last.errorMessage ? `：${last.errorMessage}` : ""}
        </p>
      )}
    </article>
  );
});
