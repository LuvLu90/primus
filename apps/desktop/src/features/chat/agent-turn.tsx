"use client";

import type { AgentMessage } from "@primus/protocol";
import {
  Brain,
  Check,
  ChevronRight,
  Copy,
  FilePen,
  FileText,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import type { SessionState, TimelineContent, ToolRun } from "@/stores/session-store";
import { type ErrorActions, ErrorCard, RetryNotice } from "./error-card";
import { MarkdownText } from "./message-content";

// 一轮回复（一条用户消息之后的全部助手消息与工具结果）按“工作过程 + 总结”展示：
// 业界一般叫 Chain of Thought / 推理与工具调用分组（Vercel AI Elements 的 ChainOfThought、
// assistant-ui 的 GroupedParts、Codex 桌面版的“Worked for 8m 28s”）。
// 中间的思考、过程说明、工具调用按顺序放进可折叠的工作过程，运行中展开、实时追加；
// 结束后自动收起成“用时 8m 28s”，最后一条不带工具调用的回复作为总结显示在下面。
//
// 性能：运行中只有计时器每秒刷新（独立组件），流光等动画只用 opacity/transform，交给合成器，
// 不触发重绘（WebView2 下背景裁剪文字的渐变动画会让 GPU 持续重绘磨砂玻璃）。

const t = strings.chat.work;

type ToolKind = keyof typeof t.tools;

const toolKinds: Record<string, ToolKind> = {
  read: "read",
  bash: "bash",
  powershell: "bash",
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
type ToolStatus = ToolRun["status"];

/** 一次工具调用的状态与输出：运行中取实时事件，历史会话取工具结果消息 */
interface CallInfo {
  status: ToolStatus;
  /** 输出内容（原始块）：只在展开时才拼成文本，流式过程中每次渲染不去拼接大段输出 */
  content: unknown;
}

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
  results: Map<string, { isError: boolean; content: unknown }>;
}

const hasText = (b: TimelineContent | undefined) => b?.type === "text" && b.text.trim() !== "";

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

function layoutTurn(messages: AgentMessage[], streaming: boolean): TurnLayout {
  const assistants = messages.filter(
    (m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant",
  );
  const results = new Map<string, { isError: boolean; content: unknown }>();
  for (const m of messages)
    if (m.role === "toolResult")
      results.set(m.toolCallId, { isError: m.isError, content: m.content });

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
  return {
    steps,
    answer,
    last,
    end: stamps.length ? Math.max(...stamps) : undefined,
    results,
  };
}

/** 8m 28s / 42s / 1h 3m（与 Codex 一致的紧凑写法） */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 计时：运行中每秒刷新，只重渲染这一小段文字 */
function Elapsed({ start, end, running }: { start: number; end?: number; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return (
    <span className="tabular-nums">{formatElapsed((running ? now : (end ?? now)) - start)}</span>
  );
}

/** 高度平滑展开/收起：grid 行从 0fr 过渡到 1fr，内容同时淡入 */
function Collapse({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  // 收起时不渲染内容：长工作过程里成百上千行输出不必常驻 DOM（等收起动画结束再卸载）
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), 400);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div id={id} className="collapse-grid" data-open={open || undefined} inert={!open}>
      <div className="min-h-0 overflow-hidden">{(open || mounted) && children}</div>
    </div>
  );
}

function argOf(call: ToolCallBlock): string {
  const a = call.arguments ?? {};
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  return (
    pick("command") ??
    pick("path") ??
    pick("file_path") ??
    pick("pattern") ??
    pick("query") ??
    pick("url") ??
    ""
  );
}

const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();

/** 输出最多显示这么多字符（取末尾）：长输出只看结尾 */
const OUTPUT_LIMIT = 6000;

function StepButton({
  open,
  onToggle,
  controls,
  icon: Icon,
  children,
  live,
  failed,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  icon: LucideIcon;
  children: ReactNode;
  live?: boolean;
  failed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="group/step -mx-1.5 flex max-w-full items-center gap-2 rounded-lg px-1.5 py-[3px] text-left text-[13px] text-muted outline-none transition-colors duration-200 hover:bg-hover/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <Icon
        aria-hidden
        size={14}
        strokeWidth={1.75}
        className={cn("shrink-0", failed && "text-danger")}
      />
      <span className={cn("min-w-0 truncate", live && "text-pulse")}>{children}</span>
      <ChevronRight
        aria-hidden
        size={13}
        className={cn(
          "shrink-0 opacity-0 transition-[rotate,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/step:opacity-60 group-focus-visible/step:opacity-60",
          open && "rotate-90 opacity-60",
        )}
      />
    </button>
  );
}

/** 一次工具调用：一行“已运行 git status”，展开看命令与输出 */
function ToolCallRow({ call, info }: { call: ToolCallBlock; info: CallInfo }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const kind = kindOf(call.name);
  const running = info.status === "running";
  const verb = running ? t.tools[kind].running : t.tools[kind].done;
  const arg = firstLine(argOf(call));
  const output = useMemo(() => {
    if (!open) return "";
    const text = textOfContent(info.content);
    return text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text;
  }, [open, info.content]);
  return (
    <div>
      <StepButton
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={id}
        icon={toolIcons[kind]}
        failed={info.status === "error"}
      >
        {kind === "other" ? `${verb} ${call.name}` : verb}
        {arg && <span className="ml-1.5 font-mono text-[12px] opacity-80">{arg}</span>}
      </StepButton>
      <Collapse open={open} id={id}>
        <div className="mt-1 mb-1.5 overflow-hidden rounded-xl bg-hover/70 ring-1 ring-border/60">
          <div className="px-3 pt-2 text-[11px] text-muted">
            {kind === "bash" ? "Shell" : call.name}
          </div>
          <pre className="output-fade max-h-64 overflow-auto px-3 pt-1.5 pb-3 font-mono text-[12px] leading-[1.6]">
            {argOf(call) && (
              <>
                <span className="text-muted">{kind === "bash" ? "$ " : ""}</span>
                <span className="text-fg">{argOf(call)}</span>
                {"\n"}
              </>
            )}
            <span className={cn("text-fg/70", info.status === "error" && "text-danger")}>
              {output || (running ? "…" : "")}
            </span>
          </pre>
        </div>
      </Collapse>
    </div>
  );
}

/** 连续的工具调用：一次只显示一行；多次时先一行汇总（“运行了命令、已读取文件 3”），展开列出每一次 */
function ToolGroup({
  calls,
  infoOf,
  turnRunning,
}: {
  calls: ToolCallBlock[];
  infoOf: (call: ToolCallBlock) => CallInfo;
  turnRunning: boolean;
}) {
  const infos = calls.map(infoOf);
  const running = infos.some((i) => i.status === "running");
  // 进行中的那组展开，看得到每一步；完成后收起成一行（用户点过则听用户的）
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (running && turnRunning);
  const id = useId();
  if (calls.length === 1) {
    const [call] = calls as [ToolCallBlock];
    return <ToolCallRow call={call} info={infos[0] as CallInfo} />;
  }
  const failed = infos.filter((i) => i.status === "error").length;
  const kinds = [...new Set(calls.map((c) => kindOf(c.name)))];
  const lastKind = kindOf(calls.at(-1)?.name ?? "");
  const label = kinds
    .map((k) => (running && k === lastKind ? t.groups[k].running : t.groups[k].done))
    .join("、");
  return (
    <div>
      <StepButton
        open={open}
        onToggle={() => setUserOpen(!open)}
        controls={id}
        icon={toolIcons[lastKind]}
        failed={failed > 0}
      >
        {label}
        <span className="ml-1.5 tabular-nums opacity-60">{calls.length}</span>
        {failed > 0 && (
          <span className="ml-1.5 text-danger">
            {failed} {t.failed}
          </span>
        )}
      </StepButton>
      <Collapse open={open} id={id}>
        <div className="mt-0.5 ml-[7px] flex flex-col border-border/80 border-l pl-3">
          {calls.map((c, i) => (
            <div key={c.id} className="step-in">
              <ToolCallRow call={c} info={infos[i] as CallInfo} />
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  );
}

/** 思考：进行中展开，实时滚动显示最新几行；结束后收起，可再展开 */
function ThoughtStep({ text, live }: { text: string; live: boolean }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const id = useId();
  const tailRef = useRef<HTMLDivElement>(null);
  // 进行中贴着最新内容
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变长时（text）也要滚到底
  useLayoutEffect(() => {
    const el = tailRef.current;
    if (live && open && el) el.scrollTop = el.scrollHeight;
  }, [text, live, open]);
  return (
    <div>
      <StepButton
        open={open}
        onToggle={() => setUserOpen(!open)}
        controls={id}
        icon={Brain}
        live={live}
      >
        {live ? t.thinkingNow : t.thought}
      </StepButton>
      <Collapse open={open} id={id}>
        <div
          ref={tailRef}
          className={cn(
            "mt-1 mb-1 ml-[7px] overflow-y-auto border-border/80 border-l pl-3 text-[12.5px] text-muted leading-relaxed",
            live ? "thought-live max-h-[7.5em]" : "max-h-80",
          )}
        >
          <MarkdownText text={text} streaming={live} />
        </div>
      </Collapse>
    </div>
  );
}

function StepView({
  step,
  infoOf,
  turnRunning,
}: {
  step: Step;
  infoOf: (call: ToolCallBlock) => CallInfo;
  turnRunning: boolean;
}) {
  if (step.kind === "tools")
    return <ToolGroup calls={step.calls} infoOf={infoOf} turnRunning={turnRunning} />;
  if (step.kind === "thought") return <ThoughtStep text={step.text} live={step.live} />;
  return (
    <MarkdownText
      text={step.text}
      streaming={step.live}
      className="py-0.5 text-[14px] text-fg/85 leading-relaxed"
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? strings.chat.copied : strings.chat.copy}
      title={copied ? strings.chat.copied : strings.chat.copy}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => {},
        );
      }}
      className="grid size-7 place-items-center rounded-lg text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {copied ? (
        <Check aria-hidden size={14} className="step-in" />
      ) : (
        <Copy aria-hidden size={14} />
      )}
    </button>
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
  /** Core 正在自动重试（只传给最后一轮） */
  retry?: SessionState["retry"];
  /** 最近一次自动重试的结果（只传给最后一轮） */
  retryResult?: SessionState["retryResult"];
  /** 停止自动重试（abort_retry） */
  onStopRetry?: () => Promise<boolean>;
  /** 错误卡片的操作（只传给最后一轮） */
  errorActions?: ErrorActions;
  /** 渠道 ID → 显示名 */
  providerNames?: Record<string, string>;
}

function sameTurn(a: AgentTurnProps, b: AgentTurnProps): boolean {
  if (
    a.running !== b.running ||
    a.streaming !== b.streaming ||
    a.startedAt !== b.startedAt ||
    a.messages.length !== b.messages.length ||
    a.retry !== b.retry ||
    a.retryResult !== b.retryResult ||
    a.onStopRetry !== b.onStopRetry ||
    a.errorActions !== b.errorActions ||
    a.providerNames !== b.providerNames
  )
    return false;
  for (let i = 0; i < a.messages.length; i++) if (a.messages[i] !== b.messages[i]) return false;
  // 工具运行状态只影响仍在进行的一轮；历史轮次的状态取自工具结果消息
  return a.toolRuns === b.toolRuns || !b.running;
}

export const AgentTurn = memo(function AgentTurn({
  messages,
  toolRuns,
  running,
  streaming,
  startedAt,
  retry,
  retryResult,
  onStopRetry,
  errorActions,
  providerNames,
}: AgentTurnProps) {
  const { steps, answer, last, end, results } = layoutTurn(messages, streaming);
  // 展开状态：用户点过就听用户的；否则运行中展开、结束后自动收起
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (running) setUserOpen(null);
  }, [running]);
  const open = userOpen ?? running;
  const [mountedAt] = useState(() => Date.now());
  const start = startedAt && startedAt > 0 ? startedAt : mountedAt;
  const id = useId();

  const infoOf = (call: ToolCallBlock): CallInfo => {
    const run = toolRuns[call.id];
    const result = results.get(call.id);
    // 工具结果消息是定稿：有它就以它为准（tool_execution_end 丢失时 toolRuns 会一直停在 running）
    const status: ToolStatus = result
      ? result.isError
        ? "error"
        : "done"
      : (run?.status ?? (running ? "running" : "done"));
    return { status, content: result?.content ?? run?.result?.content };
  };
  const answerText = answer.map((a) => a.text).join("\n\n");

  return (
    <article aria-label={strings.chat.assistant} className="msg-in group/turn flex flex-col gap-3">
      {/* 运行中始终显示“正在工作”：模型生成长工具参数时可能很久没有新内容，回复会停在半句话上 */}
      {(steps.length > 0 || running) && (
        <div className="flex flex-col">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? t.collapse : t.expand}
            onClick={() => setUserOpen(!open)}
            className="group/work -mx-1.5 flex items-center gap-1 self-start rounded-lg px-1.5 py-[3px] text-[13px] text-muted outline-none transition-colors duration-200 hover:bg-hover/60 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span className={cn(running && "text-pulse")}>{running ? t.running : t.elapsed}</span>
            <Elapsed start={start} end={end} running={running} />
            {steps.length > 0 && (
              <ChevronRight
                aria-hidden
                size={14}
                className={cn(
                  "transition-[rotate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  open && "rotate-90",
                )}
              />
            )}
          </button>
          <div
            className={cn(
              "mt-1.5 h-px origin-left bg-border transition-[opacity,scale] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
              open ? "scale-x-0 opacity-0" : "scale-x-100 opacity-100",
            )}
          />
          <Collapse open={open} id={id}>
            <ol className="flex flex-col gap-1.5 pt-1.5 pb-1">
              {steps.map((step) => (
                <li key={step.key} className="step-in">
                  <StepView step={step} infoOf={infoOf} turnRunning={running} />
                </li>
              ))}
            </ol>
          </Collapse>
        </div>
      )}
      {answer.map((a) => (
        <MarkdownText
          key={a.key}
          text={a.text}
          streaming={a.live}
          className="step-in font-serif text-[15px] leading-relaxed"
        />
      ))}
      {last?.stopReason === "aborted" && (
        <p className="self-start rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">
          {strings.chat.stopped}
        </p>
      )}
      {last?.stopReason === "length" && (
        <p className="text-danger text-xs">{strings.chat.replyTruncated}</p>
      )}
      {/* 自动重试中：显示进度与“停止重试”，不显示这次失败的错误卡片 */}
      {retry && <RetryNotice retry={retry} onStop={onStopRetry} />}
      {!retry && last?.stopReason === "error" && (
        <ErrorCard
          message={last}
          providerName={providerNames?.[last.provider]}
          retryResult={retryResult}
          actions={errorActions}
        />
      )}
      {!running && answerText && (
        <div className="-mt-1 -ml-1.5 flex opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/turn:opacity-100">
          <CopyButton text={answerText} />
        </div>
      )}
    </article>
  );
}, sameTurn);
