"use client";

import type { AgentMessage, ContextUsage } from "@primus/protocol";
import { ArrowUp, Folder, FolderOpen, Maximize2, Minimize2, Plus, Square, X } from "lucide-react";
import {
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LogoMark } from "@/components/brand/logo";
import { glassButtonClass, useGlassStyle } from "@/components/layout/glass-panel";
import { useMediaQuery } from "@/components/theme/appearance-controller";
import { GlassButton } from "@/components/ui/glass-button";
import {
  GlassPopover,
  GlassPopoverContent,
  GlassPopoverTrigger,
} from "@/components/ui/glass-popover";
import { GlassSurface } from "@/components/ui/glass-surface";
import { type ChatTab, useSessionsStore } from "@/features/sessions/sessions-store";
import { getPlatform, isTauriRuntime } from "@/lib/platform";
import type { ModelsInfo, WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { AgentTurn } from "./agent-turn";
import { ApprovalCard } from "./approval-card";
import {
  AttachmentChips,
  failure,
  PermissionPicker,
  permissionMeta,
  useCanPickFiles,
  useCanUseWorkspaces,
  WorkspacePicker,
  withAttachments,
} from "./composer-menus";
import { ThinkingIndicator } from "./message-content";
import { type IndexItem, MessageIndex } from "./message-index";
import { ModelPicker } from "./model-picker";
import { useChatSession } from "./use-chat-session";

// 中央对话区：实色"纸面"上的时间线 + 悬浮在其上的玻璃输入框（滚动内容从玻璃下方折射穿过）。
// 回复按 Markdown 渲染，流式输出平滑揭示；代码高亮、虚拟列表在后续任务补上。

const t = strings.chat;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** 一轮：一条用户消息 + 其后的助手消息与工具结果（会话开头若没有用户消息，user 为空） */
interface Turn {
  user?: { message: Extract<AgentMessage, { role: "user" }>; index: number };
  replies: AgentMessage[];
  /** 第一条回复在时间线中的位置（作 key） */
  start: number;
}

function groupTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user")
      turns.push({ user: { message: m, index: i }, replies: [], start: i + 1 });
    else {
      let turn = turns.at(-1);
      if (!turn) {
        turn = { replies: [], start: i };
        turns.push(turn);
      }
      turn.replies.push(m);
    }
  });
  return turns;
}

const UserBubble = memo(function UserBubble({ text, index }: { text: string; index: number }) {
  return (
    <article
      aria-label={t.you}
      data-msg-index={index}
      className="msg-in max-w-[80%] scroll-mt-6 self-end rounded-[18px] rounded-br-md bg-bubble px-3.5 py-2 text-fg"
    >
      <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
    </article>
  );
});

// 欢迎页：标志 + 标题 + 三个液态玻璃建议按钮
function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const glass = useGlassStyle();
  return (
    <div className="m-auto flex max-w-2xl flex-col items-center gap-5 text-center">
      <LogoMark size={60} className="text-fg/80" />
      <h2 className="font-serif text-[28px] font-medium tracking-tight">{t.welcomeTitle}</h2>
      <p className="sr-only">{strings.layout.emptyTimeline}</p>
      <div className="flex flex-wrap justify-center gap-2.5">
        {t.suggestions.map((s) => (
          <GlassButton
            key={s}
            variant="capsule"
            size={36}
            {...glass}
            className={glassButtonClass}
            onClick={() => onPick(s)}
          >
            <span className="text-[13px] font-normal">{s}</span>
          </GlassButton>
        ))}
      </div>
    </div>
  );
}

/**
 * 输入框上方附着的液态玻璃条：未选择工作区时提示选择文件夹（可不选直接对话）。
 * 选好工作区或开始对话后收起（高度与透明度过渡）。
 */
function WorkspaceBar({
  visible,
  current,
  onPicked,
  onError,
}: {
  visible: boolean;
  current: WorkspaceInfo | null;
  onPicked: (ws: WorkspaceInfo) => void;
  onError: (message: string | null) => void;
}) {
  const glass = useGlassStyle(0.2);
  return (
    <div
      aria-hidden={!visible}
      inert={!visible}
      className={cn(
        "grid transition-[grid-template-rows,opacity,transform] duration-300 ease-out",
        visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] translate-y-3 opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden px-4">
        <GlassSurface
          blur={24}
          radius={18}
          {...glass}
          // 不要立体高光与投影（投影被外层裁切后只在两侧露出一截）；边框用内描边，
          // 外描边的上沿会被外层 overflow-hidden 裁掉
          specular={false}
          className="-mb-5 pb-5 ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1]"
        >
          <div className="flex h-10 items-center px-4">
            <WorkspacePicker current={current} onPicked={onPicked} onError={onError}>
              <button
                type="button"
                className="flex items-center gap-2 text-[13px] text-muted outline-none transition-colors hover:text-fg focus-visible:text-fg data-[state=open]:text-fg"
              >
                <FolderOpen aria-hidden size={15} />
                <span className="font-medium">{t.chooseFolder}</span>
              </button>
            </WorkspacePicker>
          </div>
        </GlassSurface>
      </div>
    </div>
  );
}

/** 1.2k / 128k / 1M：上下文 token 的紧凑写法 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(".0M", "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}k`.replace(".0k", "k");
  return String(n);
}

/** 上下文占用：只显示小圆环，点击展开详情（tokens / 上下文窗口）。压缩后、下一次回复前占用未知 */
function ContextRing({ usage }: { usage?: ContextUsage }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const known = usage?.percent != null && usage.tokens != null;
  const percent = known ? Math.min(100, Math.max(0, usage?.percent ?? 0)) : 0;
  const shown = known ? `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%` : "—";
  const tone =
    percent >= 90 ? "stroke-danger" : percent >= 75 ? "stroke-amber-500" : "stroke-accent";
  return (
    <GlassPopover>
      <GlassPopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t.context} ${shown}`}
          className="grid size-8 place-items-center rounded-full outline-none transition-colors hover:bg-hover data-[state=open]:bg-hover"
        >
          <svg aria-hidden width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
            <circle
              cx="9"
              cy="9"
              r={r}
              fill="none"
              strokeWidth="2.25"
              className="stroke-black/10 dark:stroke-white/15"
            />
            <circle
              cx="9"
              cy="9"
              r={r}
              fill="none"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - percent / 100)}
              className={cn("transition-[stroke-dashoffset] duration-500 ease-out", tone)}
            />
          </svg>
        </button>
      </GlassPopoverTrigger>
      <GlassPopoverContent side="top" align="end" sideOffset={8} tint={0.75} minWidth={200}>
        <div className="flex flex-col gap-1.5 px-4 py-1.5 text-[13px]">
          <div className="flex items-baseline justify-between gap-6">
            <span className="font-medium">{t.context}</span>
            <span className="tabular-nums text-muted">{shown}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500 ease-out",
                percent >= 90 ? "bg-danger" : percent >= 75 ? "bg-amber-500" : "bg-accent",
              )}
              style={{ width: `${percent}%` }}
            />
          </div>
          {usage && (
            <p className="text-[12px] text-muted tabular-nums">
              {known ? formatTokens(usage.tokens ?? 0) : "—"} / {formatTokens(usage.contextWindow)}{" "}
              tokens
            </p>
          )}
          <p className="text-[12px] text-muted">{known ? t.contextDetail : t.contextUnknown}</p>
        </div>
      </GlassPopoverContent>
    </GlassPopover>
  );
}

/** 距底部小于该值视为"停在底部" */
const STICK_THRESHOLD_PX = 48;
/** 输入框行高与行数范围 */
const INPUT_LINE_PX = 22;
const INPUT_MIN_LINES = 2;
const INPUT_MAX_LINES = 6;
/** 时间线底部在悬浮输入框之上再留出的间距 */
const COMPOSER_GAP_PX = 16;
/** 首帧（尚未量到输入框高度）时的底部留白，约等于两行输入框的静止高度 */
const COMPOSER_FALLBACK_PX = 128;

/**
 * 量取悬浮输入框的实际高度（含其下边距），随输入行数增减实时更新。
 * 时间线据此留出底部空间：欢迎页与最后一条消息永远不会被玻璃输入框盖住，放不下时可滚动。
 */
function useElementHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 高度为 0（尚未布局或被隐藏）时视为未量到，沿用首帧留白
    const read = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      setHeight(h > 0 ? h : null);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/**
 * 模型配置是否可用于对话（首次引导与第 9.8 节）：没有任何已生效的模型配置时不能发送，
 * 输入框上方提示并提供“重试”（调用 `models_refresh`）。读取失败（如浏览器预览缺少该接口）时不拦截。
 */
function useModelConfigGate() {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getPlatform()
      .then((p) => p.modelsGet())
      .then((i) => !cancelled && setInfo(i))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const unavailable = info !== null && info.error !== null && info.models.length === 0;
  const retry = () => {
    setRetrying(true);
    getPlatform()
      .then((p) => p.modelsRefresh())
      .then(setInfo)
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  return { info, unavailable, reason: info?.error ?? null, retrying, retry };
}

/** 路径最后一段（工作区显示名） */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** 一个会话标签的对话区；不传 `tab` 时为独立的新会话（测试与单会话场景） */
export function ChatPanel({ tab }: { tab?: ChatTab } = {}) {
  const tabId = tab?.id;
  const markOpened = useSessionsStore((s) => s.markOpened);
  const setTabOpening = useSessionsStore((s) => s.setOpening);
  const setTabRunning = useSessionsStore((s) => s.setRunning);
  const {
    state,
    error,
    unresponsive,
    coreStopped,
    send,
    abort,
    restarting,
    restart,
    respondUi,
    selectModel,
    pendingModel,
  } = useChatSession({
    sessionPath: tab?.sessionPath,
    workspace: tab?.workspace,
    onOpening: tabId ? (opening) => setTabOpening(tabId, opening) : undefined,
    onOpened: tabId ? (opened) => markOpened(tabId, opened) : undefined,
  });
  // 运行中的标签不会因标签上限被关闭
  useEffect(() => {
    if (tabId) setTabRunning(tabId, state.running);
  }, [tabId, state.running, setTabRunning]);
  const modelConfig = useModelConfigGate();
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [composerRef, composerHeight] = useElementHeight<HTMLDivElement>();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const glass = useGlassStyle();
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const permissionMode = useAppStore((s) => s.permissionMode);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  const [attachments, setAttachments] = useState<string[]>([]);
  // 提交中（等待会话打开与 prompt 响应）：阻止重复提交，并锁定输入，避免成功后清掉期间新增的内容
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const PermissionIcon = permissionMeta[permissionMode].icon;

  // 输入框随内容伸缩：最少 2 行、最多 6 行；超出后可展开编辑（更高），仍超出则在框内滚动（不显示滚动条）
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [inputHeight, setInputHeight] = useState(INPUT_LINE_PX * INPUT_MIN_LINES);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容变化时重新测量
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const prev = el.style.height;
    el.style.height = "0px";
    const content = el.scrollHeight;
    el.style.height = prev;
    const max = expanded ? Math.round(window.innerHeight * 0.5) : INPUT_LINE_PX * INPUT_MAX_LINES;
    setOverflowing(content > INPUT_LINE_PX * INPUT_MAX_LINES);
    setInputHeight(Math.min(Math.max(content, INPUT_LINE_PX * INPUT_MIN_LINES), max));
  }, [draft, expanded]);

  // 附件只取本地路径（不复制文件），去重后追加
  const [pickError, setPickError] = useState<string | null>(null);
  const pickFiles = () =>
    getPlatform()
      .then((p) => p.dialogPickFiles())
      .then((paths) => {
        setPickError(null);
        setAttachments((prev) => [...new Set([...prev, ...paths])]);
      })
      .catch((e) => setPickError(failure(t.pickFilesFailed, e)));

  // 只在客户端判断运行环境，避免水合不一致
  useEffect(() => setPreview(!isTauriRuntime()), []);

  // 贴底：只有用户停在底部附近或刚发送消息时，新内容到达才滚到底部；
  // 用户向上翻看历史时，流式更新不打断阅读（后续换成虚拟列表的"贴底"逻辑）
  const stickToBottom = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };
  const lastMessage = state.messages.at(-1);
  const started = state.messages.length > 0;
  // 会话已打开或是历史会话：工作区锁定为会话自己的工作区（空串为未选工作区）；否则跟随输入框上方的选择
  const lockedPath = tab?.workspace ?? null;
  const shownWorkspace: WorkspaceInfo | null =
    lockedPath === null
      ? workspace
      : lockedPath
        ? { path: lockedPath, name: baseName(lockedPath), trusted: false, needsTrust: false }
        : null;
  const workspaceLocked = started || lockedPath !== null;
  const canPickFiles = useCanPickFiles();
  const canUseWorkspaces = useCanUseWorkspaces();
  useEffect(() => {
    if (!lastMessage || !stickToBottom.current) return;
    const el = scrollRef.current;
    el?.scrollTo?.({ top: el.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [lastMessage, reducedMotion]);
  // 平滑输出时正文逐帧变高，记录本身没有变化：内容高度一变就贴底（用户没往上翻时）
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const inner = timelineRef.current;
    if (!inner || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // 刚发出、Core 还没回显的用户消息：先按它将来的位置显示，回显后同一个 key 原地替换，不闪烁
  const [pendingUser, setPendingUser] = useState<{ text: string; index: number } | null>(null);
  useEffect(() => {
    if (!pendingUser) return;
    if (state.messages.length > pendingUser.index || (!submitting && !state.running))
      setPendingUser(null);
  }, [pendingUser, state.messages.length, submitting, state.running]);

  // 欢迎页离场：开始对话后先淡出上移，动画结束再卸载
  const conversationStarted = started || pendingUser !== null;
  const [welcomeGone, setWelcomeGone] = useState(conversationStarted);
  useEffect(() => {
    if (!conversationStarted) {
      setWelcomeGone(false);
      return;
    }
    if (reducedMotion) {
      setWelcomeGone(true);
      return;
    }
    const id = setTimeout(() => setWelcomeGone(true), 280);
    return () => clearTimeout(id);
  }, [conversationStarted, reducedMotion]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (
      (!text && attachments.length === 0) ||
      state.running ||
      unresponsive ||
      modelConfig.unavailable ||
      submittingRef.current
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    stickToBottom.current = true;
    const message = withAttachments(text, attachments);
    setPendingUser({ text: message, index: state.messages.length });
    // 发送成功后才清空输入，失败时保留草稿和附件以便重试
    void send(message)
      .then((sent) => {
        if (!sent) {
          setPendingUser(null);
          return;
        }
        setDraft("");
        setAttachments([]);
        setExpanded(false);
      })
      .finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
  };

  // 停止：发出 abort 后到本轮结束（agent_settled，running 变为 false）之间按钮显示“正在停止”，不重复发送。
  // abort 成功时保持到 running 结束；只有失败（失败响应或超时）才提前恢复按钮以便重试。
  // 每次停止一个令牌：旧的 abort 迟到失败时不清除新一轮的停止状态
  const [stopping, setStopping] = useState(false);
  const stopToken = useRef<symbol | null>(null);
  const stop = () => {
    if (!state.running || stopToken.current) return;
    const token = Symbol("stop");
    stopToken.current = token;
    setStopping(true);
    void abort().then((ok) => {
      if (ok || stopToken.current !== token) return;
      stopToken.current = null;
      setStopping(false);
    });
  };
  useEffect(() => {
    if (state.running) return;
    stopToken.current = null;
    setStopping(false);
  }, [state.running]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) submit(e);
    else if (e.key === "Escape" && state.running) {
      e.preventDefault();
      stop();
    }
  };

  const shownError = error ?? state.lastError;
  // 当前模型：Core 报告的 > 打开前选的 > 账号配置的默认模型
  const currentModel = state.model
    ? `${state.model.provider}/${state.model.id}`
    : (pendingModel.model ?? modelConfig.info?.defaultModel ?? null);
  const pendingUi = state.uiRequests[0];
  const turns = useMemo(() => groupTurns(state.messages), [state.messages]);
  const indexItems = useMemo<IndexItem[]>(
    () =>
      turns.flatMap((turn) =>
        turn.user ? [{ index: turn.user.index, text: textOf(turn.user.message.content) }] : [],
      ),
    [turns],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MessageIndex items={indexItems} scrollRef={scrollRef} />
      {/* 顶部渐隐：滚上去的内容在左右栏开关下方淡出，不和按钮叠在一起 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-12 bg-linear-to-b from-[var(--paper)] from-40% to-transparent"
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-none flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-12 text-sm"
        style={{ paddingBottom: (composerHeight ?? COMPOSER_FALLBACK_PX) + COMPOSER_GAP_PX }}
      >
        <div
          ref={timelineRef}
          className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4"
        >
          {preview && (
            <p className="self-center rounded-full bg-hover px-2.5 py-0.5 text-[11px] text-muted">
              {t.previewBadge}
            </p>
          )}
          {!welcomeGone && (
            <div
              inert={conversationStarted}
              className={cn("flex flex-1", conversationStarted && "welcome-out absolute inset-0")}
            >
              <Welcome
                onPick={(s) => {
                  setDraft(s);
                  inputRef.current?.focus();
                }}
              />
            </div>
          )}
          {turns.map((turn, ti) => {
            const lastTurn = ti === turns.length - 1;
            return (
              <Fragment key={turn.start}>
                {turn.user && (
                  <UserBubble
                    key={`${turn.user.index}-user`}
                    index={turn.user.index}
                    text={textOf(turn.user.message.content)}
                  />
                )}
                {turn.replies.length > 0 && (
                  <AgentTurn
                    key={`${turn.start}-turn`}
                    messages={turn.replies}
                    toolRuns={state.toolRuns}
                    running={lastTurn && state.running}
                    streaming={lastTurn && state.streamingMessage}
                    startedAt={
                      (turn.user?.message as { timestamp?: number } | undefined)?.timestamp
                    }
                  />
                )}
              </Fragment>
            );
          })}
          {pendingUser && state.messages.length <= pendingUser.index && (
            // 与回显后那一轮同样的 key：回显时原地替换，不重播进场动画
            <Fragment key={pendingUser.index + 1}>
              <UserBubble
                key={`${pendingUser.index}-user`}
                index={pendingUser.index}
                text={pendingUser.text}
              />
            </Fragment>
          )}
          {/* 已发出、回复还没开始：最后一条是用户消息（或还在等回显） */}
          {(submitting || state.running) &&
            !unresponsive &&
            (state.messages.length === 0 || state.messages.at(-1)?.role === "user") && (
              <ThinkingIndicator />
            )}
          {unresponsive && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-danger/40 px-3 py-2 text-xs"
            >
              <div className="flex-1">
                <p className="font-medium text-danger">
                  {coreStopped ? t.coreStopped : t.unresponsive}
                </p>
                <p className="text-muted">{coreStopped ? t.coreStoppedHint : t.unresponsiveHint}</p>
              </div>
              <button
                type="button"
                onClick={() => void restart()}
                disabled={restarting}
                className="rounded-full bg-hover px-3 py-1 font-medium disabled:opacity-50"
              >
                {t.restartCore}
              </button>
            </div>
          )}
          {shownError && (
            <p role="alert" className="text-xs text-danger">
              {shownError}
            </p>
          )}
        </div>
      </div>

      <div ref={composerRef} className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4">
        <div className="pointer-events-auto mx-auto max-w-3xl">
          <WorkspaceBar
            visible={canUseWorkspaces && !shownWorkspace && !workspaceLocked}
            current={shownWorkspace}
            onPicked={setWorkspace}
            onError={setPickError}
          />
          {modelConfig.unavailable && (
            <div
              role="alert"
              className="mb-2 flex items-center gap-3 rounded-xl bg-surface px-3 py-2 text-xs ring-1 ring-danger/40"
            >
              <div className="flex-1">
                <p className="text-danger">{t.modelConfigUnavailable}</p>
                {modelConfig.reason && <p className="text-muted">{modelConfig.reason}</p>}
              </div>
              <button
                type="button"
                onClick={modelConfig.retry}
                disabled={modelConfig.retrying}
                className="rounded-full bg-hover px-3 py-1 font-medium disabled:opacity-50"
              >
                {t.retryModelConfig}
              </button>
            </div>
          )}
          {pendingUi && (
            <ApprovalCard key={pendingUi.id} request={pendingUi} onRespond={respondUi} />
          )}
          {/* 中央已是玻璃，输入框保持实色白底（深色为实色面），保证输入区清晰 */}
          <div className="relative rounded-[24px] bg-surface shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border transition-shadow focus-within:shadow-[0_14px_44px_-12px_rgb(0_0_0/0.4)]">
            <form onSubmit={submit} className="flex flex-col gap-2 px-3.5 pt-3.5 pb-3">
              {pickError && (
                <p role="alert" className="text-xs text-danger">
                  {pickError}
                </p>
              )}
              <AttachmentChips
                paths={attachments}
                onRemove={(p) => {
                  if (!submittingRef.current) setAttachments((prev) => prev.filter((x) => x !== p));
                }}
              />
              <div className="relative">
                <textarea
                  ref={inputRef}
                  aria-label={t.inputLabel}
                  placeholder={t.inputPlaceholder}
                  value={draft}
                  readOnly={submitting}
                  aria-busy={submitting}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  style={{ height: inputHeight }}
                  className={cn(
                    "scroll-none block w-full resize-none bg-transparent px-1 text-[14px] leading-[22px] caret-accent outline-none placeholder:text-muted/55",
                    (overflowing || expanded) && "pr-8",
                  )}
                />
                {(overflowing || expanded) && (
                  <button
                    type="button"
                    aria-label={expanded ? t.collapseInput : t.expandInput}
                    title={expanded ? t.collapseInput : t.expandInput}
                    onClick={() => {
                      setExpanded((v) => !v);
                      inputRef.current?.focus();
                    }}
                    className="absolute top-0 right-0 grid size-7 place-items-center rounded-lg text-muted outline-none transition-colors hover:bg-hover hover:text-fg"
                  >
                    {expanded ? (
                      <Minimize2 aria-hidden size={14} />
                    ) : (
                      <Maximize2 aria-hidden size={14} />
                    )}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted">
                {/* 附件：系统文件对话框选文件，只引用本地路径；薄壳未接入对话框时隐藏 */}
                {canPickFiles && (
                  <GlassButton
                    size={30}
                    {...glass}
                    aria-label={t.attach}
                    title={t.attach}
                    disabled={submitting}
                    onClick={() => void pickFiles()}
                    className={glassButtonClass}
                  >
                    <Plus aria-hidden size={16} />
                  </GlassButton>
                )}
                <PermissionPicker mode={permissionMode} onChange={setPermissionMode}>
                  <GlassButton
                    variant="capsule"
                    size={30}
                    {...glass}
                    aria-label={`${t.permissionMode}：${t.permissions[permissionMode].label}`}
                    className={glassButtonClass}
                  >
                    <PermissionIcon
                      aria-hidden
                      size={14}
                      strokeWidth={1.9}
                      className={permissionMeta[permissionMode].tone}
                    />
                    <span
                      className={cn(
                        "text-[12px] font-normal",
                        permissionMode === "full" && permissionMeta.full.tone,
                      )}
                    >
                      {t.permissions[permissionMode].short}
                    </span>
                  </GlassButton>
                </PermissionPicker>
                {canUseWorkspaces &&
                  shownWorkspace &&
                  (workspaceLocked ? (
                    // 会话已绑定到开始时的工作区，之后不能切换，避免界面与 Core 实际工作区不一致
                    <span
                      title={`${t.currentWorkspace}：${shownWorkspace.path}\n${t.workspaceLocked}`}
                      className="flex h-[30px] items-center gap-1.5 px-2 text-muted"
                    >
                      <Folder aria-hidden size={14} />
                      <span className="max-w-40 truncate text-[12px]">{shownWorkspace.name}</span>
                    </span>
                  ) : (
                    // 悬停（或键盘聚焦）时文件夹图标换成关闭按钮（在名称左侧），取消已选的工作区。
                    // 关闭按钮是触发器的兄弟元素、叠在图标位置上（按钮里不能嵌套按钮），点它不会打开菜单
                    <span className="group/ws relative flex">
                      <WorkspacePicker
                        current={shownWorkspace}
                        onPicked={setWorkspace}
                        onError={setPickError}
                      >
                        <GlassButton
                          variant="capsule"
                          size={30}
                          {...glass}
                          title={`${t.currentWorkspace}：${shownWorkspace.path}`}
                          className={glassButtonClass}
                        >
                          <Folder
                            aria-hidden
                            size={14}
                            className="transition-opacity group-focus-within/ws:opacity-0 group-hover/ws:opacity-0"
                          />
                          <span className="max-w-40 truncate text-[12px] font-normal">
                            {shownWorkspace.name}
                          </span>
                        </GlassButton>
                      </WorkspacePicker>
                      <button
                        type="button"
                        aria-label={`${t.clearWorkspace} ${shownWorkspace.name}`}
                        title={t.clearWorkspace}
                        onClick={() => {
                          setPickError(null);
                          setWorkspace(null);
                        }}
                        className="absolute left-[12px] top-1/2 z-10 grid size-[18px] -translate-y-1/2 place-items-center rounded-full text-muted opacity-0 outline-none transition-opacity hover:bg-black/[0.07] hover:text-fg focus-visible:opacity-100 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100 dark:hover:bg-white/[0.1]"
                      >
                        <X aria-hidden size={13} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                <span className="flex-1" />
                <ModelPicker
                  models={modelConfig.info?.models ?? []}
                  current={currentModel}
                  thinkingLevel={state.thinkingLevel ?? pendingModel.thinkingLevel}
                  thinkingLevels={state.model ? state.thinkingLevels : undefined}
                  disabled={state.running || submitting}
                  onSelectModel={(model) => void selectModel({ model })}
                  onSelectThinking={(thinkingLevel) => void selectModel({ thinkingLevel })}
                />
                <ContextRing usage={state.contextUsage} />
                {state.running ? (
                  <button
                    type="button"
                    aria-label={stopping ? t.stopping : t.stop}
                    title={stopping ? t.stopping : t.stop}
                    aria-busy={stopping}
                    disabled={stopping}
                    onClick={stop}
                    className="grid size-8 place-items-center rounded-full bg-fg text-surface transition-opacity disabled:opacity-40"
                  >
                    <Square aria-hidden size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label={t.send}
                    disabled={
                      submitting ||
                      unresponsive ||
                      modelConfig.unavailable ||
                      (!draft.trim() && attachments.length === 0)
                    }
                    className="grid size-8 place-items-center rounded-full bg-fg text-surface transition-[opacity,transform] active:scale-95 disabled:opacity-20 disabled:active:scale-100"
                  >
                    <ArrowUp aria-hidden size={16} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
