"use client";

import { type AgentMessage, type ImageContent, splitFileTags } from "@primus/protocol";
import { useRouter } from "next/navigation";
import {
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons";
import { glassButtonClass, useGlassStyle } from "@/components/layout/glass-panel";
import { useMediaQuery } from "@/components/theme/appearance-controller";
import { GlassButton } from "@/components/ui/glass-button";
import { Tooltip } from "@/components/ui/tooltip";
import { showPreview } from "@/features/files/preview-store";
import { lastWrittenFile } from "@/features/files/written-file";
import { type ChatTab, useSessionsStore } from "@/features/sessions/sessions-store";
import { useSessionDefaultWorkspace } from "@/features/sessions/use-default-workspace";
import { getFileDrop, getPlatform, isTauriRuntime } from "@/lib/platform";
import type { SpeechSettingsPage, WorkspaceInfo } from "@/lib/platform/types";
import { strings } from "@/lib/strings";
import { useModelsInfo, useProviderNames } from "@/lib/use-models";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { AgentTurn } from "./agent-turn";
import { ApprovalCard } from "./approval-card";
import { AttachmentStrip } from "./attachments/attachment-strip";
import { useAttachments } from "./attachments/use-attachments";
import { composerGhostClass } from "./composer-ghost";
import { ComposerLip } from "./composer-lip";
import {
  failure,
  PermissionPicker,
  permissionMeta,
  useCanPickFiles,
  useCanUseWorkspaces,
  withAttachments,
} from "./composer-menus";
import { ContextButton } from "./context-card";
import type { ErrorActions } from "./error-card";
import { resolveFileRefPath } from "./file-ref";
import { FileRefBase } from "./file-ref-actions";
import { ThinkingIndicator } from "./message-content";
import { type IndexItem, MessageIndex } from "./message-index";
import { ModelPicker, withCoreCaps } from "./model-picker";
import { DEFAULT_THINKING_LEVEL, useChatSession } from "./use-chat-session";
import { UserBubble } from "./user-bubble";
import { SETTINGS_URLS, useVoiceInput } from "./voice/use-voice-input";
import { VoiceButton } from "./voice/voice-button";

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

/** 消息索引里的一行：正文；只有附件时列出文件名 */
function indexText(text: string): string {
  const { message, files } = splitFileTags(text);
  return message || files.map((f) => f.path.split(/[\\/]/).pop() ?? f.path).join("、");
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

// 欢迎页：标志 + 标题 + 三个液态玻璃建议按钮
function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const glass = useGlassStyle();
  return (
    <div className="m-auto flex max-w-2xl flex-col items-center gap-5 text-center">
      <LogoMark size={60} className="text-fg/80" />
      <h2 className="font-serif text-3xl font-medium tracking-tight">{t.welcomeTitle}</h2>
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
            <span className="text-sm font-normal">{s}</span>
          </GlassButton>
        ))}
      </div>
    </div>
  );
}

/** 发送成功后等待 Core 回显用户消息的最长时间 */
const PENDING_ECHO_TIMEOUT_MS = 3000;
/** 距底部小于该值视为"停在底部" */
const STICK_THRESHOLD_PX = 48;
/** 输入框行高与行数范围 */
const INPUT_LINE_PX = 22;
const INPUT_MIN_LINES = 2;
const INPUT_MAX_LINES = 6;
/** 时间线底部在悬浮输入框之上再留出的间距；也是输入框上沿渐隐带的高度（滚到底时最后一行不被淡化） */
const COMPOSER_GAP_PX = 20;
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
 * 模型配置是否可用于对话（首次引导与第 9.8 节）：没有任何可用的模型时不能发送，
 * 输入框上方提示并提供“去设置添加渠道”。随 `models_watch` 更新，在设置里添加渠道后立即恢复。
 * 读取失败（如浏览器预览缺少该接口）时不拦截。
 */
function useModelConfigGate() {
  const { info } = useModelsInfo();
  const providerNames = useProviderNames(info);
  const unavailable = info !== null && info.error !== null && info.models.length === 0;
  return { info, providerNames, unavailable, reason: info?.error ?? null };
}

/** 语音输入被系统隐私设置拒绝时打开对应的 Windows 设置页 */
function openVoiceSettings(page: SpeechSettingsPage | undefined) {
  if (!page) return;
  void getPlatform()
    .then((p) => p.openExternal(SETTINGS_URLS[page]))
    .catch(() => {});
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
    abortRetry,
    restarting,
    restart,
    respondUi,
    selectModel,
    refreshModels,
    pendingModel,
    modelLocked,
    connected,
    refreshStats,
    requestContextStats,
    compact,
    setAutoCompaction,
  } = useChatSession({
    sessionPath: tab?.sessionPath,
    workspace: tab?.workspace,
    onOpening: tabId ? (opening) => setTabOpening(tabId, opening) : undefined,
    onOpened: tabId ? (opened) => markOpened(tabId, opened) : undefined,
  });
  const modelConfig = useModelConfigGate();
  const router = useRouter();
  const openModelSettings = () => router.push("/settings/?group=models");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [composerRef, composerHeight] = useElementHeight<HTMLDivElement>();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const workspace = useAppStore((s) => s.workspace);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const permissionMode = useAppStore((s) => s.permissionMode);
  const setPermissionMode = useAppStore((s) => s.setPermissionMode);
  // 提交中（等待会话打开与 prompt 响应）：阻止重复提交，并锁定输入，避免成功后清掉期间新增的内容
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // 当前模型：Core 报告的 > 打开前选的 > 账号配置的默认模型
  const currentModel = state.model
    ? `${state.model.provider}/${state.model.id}`
    : (pendingModel.model ?? modelConfig.info?.defaultModel ?? null);
  // 模型列表来自设置的渠道；会话打开后能力（能否看图、是否支持思考、上下文长度）以 Core 的 get_available_models 为准
  const settingsModels = modelConfig.info?.models;
  const models = useMemo(
    () => withCoreCaps(settingsModels ?? [], state.modelCaps),
    [settingsModels, state.modelCaps],
  );
  const currentModelInfo = models.find((m) => m.key === currentModel);
  // 渠道变化（models_watch）后 Core 会重新读取 models.json（primus-auth 合并 200ms 内的文件事件后才读）：
  // 会话已打开时立即取一次能力，1 秒后再取一次，免得拿到 Core 重读之前的旧值
  useEffect(() => {
    if (!connected || !settingsModels) return;
    refreshModels();
    const timer = setTimeout(refreshModels, 1000);
    return () => clearTimeout(timer);
  }, [connected, settingsModels, refreshModels]);
  // 附件：图片排队读取（当前模型能看图时），其余按路径引用；提交中不能移除
  const attachments = useAttachments({
    imagesSupported: currentModelInfo?.image ?? false,
    locked: submitting,
  });

  // 语音输入：开始时记下光标前后的文字，定稿的文本插到光标处，识别中的临时文本以灰色显示在光标处
  const voiceCtx = useRef<{ before: string; after: string } | null>(null);
  const [voiceFinal, setVoiceFinal] = useState<{ text: string; key: number } | null>(null);
  const voice = useVoiceInput({
    onStart: () => {
      const el = inputRef.current;
      const start = el?.selectionStart ?? draft.length;
      const end = el?.selectionEnd ?? draft.length;
      voiceCtx.current = { before: draft.slice(0, start), after: draft.slice(end) };
      setVoiceFinal(null);
    },
    onFinal: (text) => {
      const ctx = voiceCtx.current;
      if (!ctx) return;
      ctx.before += text;
      setDraft(ctx.before + ctx.after);
      setVoiceFinal((v) => ({ text, key: (v?.key ?? 0) + 1 }));
    },
    onEnd: () => {
      const ctx = voiceCtx.current;
      voiceCtx.current = null;
      setVoiceFinal(null);
      if (!ctx) return;
      // 光标放到插入的文字之后
      const caret = ctx.before.length;
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
  });
  const voiceText = voiceCtx.current;
  // 录音中输入框显示：光标前文字 + 临时文本 + 光标后文字（临时文本在上层镜像里染成灰色）
  const shownDraft =
    voice.recording && voiceText ? voiceText.before + voice.interim + voiceText.after : draft;

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
  }, [shownDraft, expanded]);

  // 附件只取本地路径（不复制文件），去重后追加
  const [pickError, setPickError] = useState<string | null>(null);
  const { addPaths, addBlobs } = attachments;
  const pickFiles = () =>
    getPlatform()
      .then((p) => p.dialogPickFiles())
      .then((paths) => {
        setPickError(null);
        addPaths(paths);
      })
      .catch((e) => setPickError(failure(t.pickFilesFailed, e)));

  // 粘贴图片：剪贴板里只有图片时接管粘贴（同时有文字时照常粘贴文字）
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0 || submitting) return;
    if (e.clipboardData.getData("text/plain")) return;
    if (addBlobs(files) > 0) e.preventDefault();
  };

  // 拖放文件：Tauri 窗口内由原生拖放给出本地路径（命中输入框时才接收），浏览器预览用 HTML5 drop 读图片内容
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [nativeDrop, setNativeDrop] = useState(false);
  const hitComposer = useCallback((pos?: { x: number; y: number }) => {
    const el = composerBoxRef.current;
    if (!pos || !el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;
  }, []);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getFileDrop().then((source) => {
      if (!source || disposed) return;
      setNativeDrop(true);
      void source
        .listen((e) => {
          if (e.type === "leave") return setDragOver(false);
          const inside = hitComposer(e.position);
          if (e.type === "drop") {
            setDragOver(false);
            if (inside && !submittingRef.current && e.paths.length > 0) addPaths(e.paths);
          } else setDragOver(inside);
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths, hitComposer]);
  const htmlDrag = {
    onDragOver: (e: DragEvent) => {
      if (nativeDrop || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (nativeDrop) return;
      e.preventDefault();
      setDragOver(false);
      if (!submittingRef.current) addBlobs([...e.dataTransfer.files]);
    },
  };

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
  // 未选工作区时 Agent 在默认会话目录里工作：相对路径（文件引用、写入预览）按它解析
  const defaultWorkspace = useSessionDefaultWorkspace();
  const fileRefBase = shownWorkspace?.path ?? defaultWorkspace ?? null;
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
  // 回显后清除；发送失败在 submit 里清除。发送成功后 Core 的确认可能早于 agent_start 和回显，
  // 中间那一下既不在发送也不在运行：不能据此清除，否则欢迎页和气泡会消失再出现（闪一下）。
  // 只在发送成功、一段时间后仍没开始运行也没回显（如由扩展处理、不产生消息的命令）时兜底清除。
  useEffect(() => {
    if (!pendingUser) return;
    if (state.messages.length > pendingUser.index) {
      setPendingUser(null);
      return;
    }
    if (submitting || state.running) return;
    const id = setTimeout(() => setPendingUser(null), PENDING_ECHO_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [pendingUser, state.messages.length, submitting, state.running]);

  // 运行中、提交中（prompt 已发出但 agent_start 未到）、以及命令超时（Core 可能已受理、仍在执行）的标签
  // 都不会因标签上限被关闭，否则卸载会关掉它的 RPC 客户端与 Core，提交被中断
  const busy = state.running || submitting || pendingUser !== null || unresponsive;
  useEffect(() => {
    if (tabId) setTabRunning(tabId, busy);
  }, [tabId, busy, setTabRunning]);

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
      (!text && !attachments.hasContent) ||
      attachments.pending ||
      voice.recording ||
      state.running ||
      unresponsive ||
      modelConfig.unavailable ||
      submittingRef.current
    )
      return;
    submittingRef.current = true;
    setSubmitting(true);
    stickToBottom.current = true;
    // 能看图的模型：读取好的图片随 prompt 发送；其余文件（及不看图时的图片）按路径引用
    const { images, paths } = attachments.build();
    const message = withAttachments(text, paths);
    setPendingUser({ text: message, index: state.messages.length });
    // 发送成功后才清空输入，失败时保留草稿和附件以便重试
    void send(message, images)
      .then((sent) => {
        if (!sent) {
          setPendingUser(null);
          return;
        }
        setDraft("");
        attachments.clear();
        setExpanded(false);
      })
      .finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
  };

  // 错误卡片的“重试”：重新发送上一条用户消息（Core 没有“重新生成”命令；出错的回复不进入模型上下文，
  // 见 ai/src/api/transform-messages.ts）。附件按空标签重发，文本文件由 primus-attach 重新读取；图片随 images 重发
  const resendLast = () => {
    if (busy || modelConfig.unavailable || submittingRef.current) return;
    const lastUser = state.messages.findLast((m) => m.role === "user");
    if (lastUser?.role !== "user") return;
    const { message: body, files } = splitFileTags(textOf(lastUser.content));
    const message = withAttachments(
      body,
      files.map((f) => f.path),
    );
    const images = Array.isArray(lastUser.content)
      ? lastUser.content.filter((c): c is ImageContent => c.type === "image")
      : [];
    submittingRef.current = true;
    setSubmitting(true);
    stickToBottom.current = true;
    setPendingUser({ text: message, index: state.messages.length });
    void send(message, images.length > 0 ? images : undefined)
      .then((sent) => {
        if (!sent) setPendingUser(null);
      })
      .finally(() => {
        submittingRef.current = false;
        setSubmitting(false);
      });
  };
  const resendRef = useRef(resendLast);
  resendRef.current = resendLast;
  const openSettingsRef = useRef(openModelSettings);
  openSettingsRef.current = openModelSettings;
  const canRetry = !busy && !modelConfig.unavailable;
  // 稳定的引用：历史轮次的 memo 不因每次渲染新建的回调而重渲
  const errorActions = useMemo<ErrorActions>(
    () => ({
      onRetry: canRetry ? () => resendRef.current() : undefined,
      onOpenSettings: () => openSettingsRef.current(),
    }),
    [canRetry],
  );
  // 历史轮次只能去设置里检查渠道（重试只针对最后一轮）
  const settingsOnly = useMemo<ErrorActions>(
    () => ({ onOpenSettings: () => openSettingsRef.current() }),
    [],
  );

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

  // 一轮结束（运行中 → 空闲）：把 Agent 这一轮最后写出的文件在右栏打开预览。
  // 在后台标签结束的轮次先记下，切回该标签时再预览；新一轮开始时作废。
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  const wasRunning = useRef(false);
  const pendingPreview = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在运行状态或当前标签变化时判断
  useEffect(() => {
    const finished = wasRunning.current && !state.running;
    wasRunning.current = state.running;
    if (state.running) {
      pendingPreview.current = false;
      return;
    }
    if (finished) pendingPreview.current = true;
    if (!pendingPreview.current || (tabId !== undefined && tabId !== activeTabId)) return;
    pendingPreview.current = false;
    const written = lastWrittenFile(state.messages);
    const path = written && resolveFileRefPath(written, fileRefBase);
    if (path) showPreview(path);
  }, [state.running, activeTabId]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) submit(e);
  };

  const shownError = error ?? state.lastError;
  const pendingUi = state.uiRequests[0];
  const turns = useMemo(() => groupTurns(state.messages), [state.messages]);
  const indexItems = useMemo<IndexItem[]>(
    () =>
      turns.flatMap((turn) =>
        turn.user
          ? [{ index: turn.user.index, text: indexText(textOf(turn.user.message.content)) }]
          : [],
      ),
    [turns],
  );

  return (
    // 回复里文件引用的相对路径按会话工作区解析（file-ref-actions.tsx）
    <FileRefBase.Provider value={fileRefBase}>
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
          className="scroll-none flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--paper)] px-6 pt-12 text-base"
          style={{ paddingBottom: (composerHeight ?? COMPOSER_FALLBACK_PX) + COMPOSER_GAP_PX }}
        >
          <div
            ref={timelineRef}
            className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4"
          >
            {preview && (
              <p className="self-center rounded-full bg-hover px-2.5 py-0.5 text-2xs text-muted">
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
                      providerNames={modelConfig.providerNames}
                      {...(lastTurn
                        ? {
                            retry: state.retry,
                            retryResult: state.retryResult,
                            onStopRetry: abortRetry,
                            errorActions,
                          }
                        : { errorActions: settingsOnly })}
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
            {(submitting || state.running || pendingUser !== null) &&
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
                  <p className="text-muted">
                    {coreStopped ? t.coreStoppedHint : t.unresponsiveHint}
                  </p>
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

        {/* 底部渐隐（.composer-fade）：纸面色盖层，时间线在输入框上沿之上淡出、输入框后面不显示文字。
            用盖层而不是给滚动容器加遮罩：遮罩会把整条时间线放进合成层，正文失去 ClearType 而发虚 */}
        <div
          aria-hidden
          className="composer-fade pointer-events-none absolute inset-x-0 bottom-0"
          style={
            {
              "--composer-h": `${composerHeight ?? COMPOSER_FALLBACK_PX}px`,
              "--composer-fade": `${COMPOSER_GAP_PX}px`,
            } as CSSProperties
          }
        />
        <div
          ref={composerRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4"
        >
          <div className="pointer-events-auto mx-auto max-w-3xl">
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
                  onClick={openModelSettings}
                  className="shrink-0 rounded-full bg-hover px-3 py-1 font-medium"
                >
                  {t.openModelSettings}
                </button>
              </div>
            )}
            {pendingUi && (
              <ApprovalCard key={pendingUi.id} request={pendingUi} onRespond={respondUi} />
            )}
            {/* 唇条：输入框上沿后面的灰色小舌，显示 Git 分支与工作区（选择工作区也在这里） */}
            {canUseWorkspaces && (
              <ComposerLip
                workspace={shownWorkspace}
                locked={workspaceLocked}
                onPicked={setWorkspace}
                onClear={() => {
                  setPickError(null);
                  setWorkspace(null);
                }}
                onError={setPickError}
              />
            )}
            {/* 中央已是玻璃，输入框保持实色白底（深色为实色面），保证输入区清晰 */}
            <div
              ref={composerBoxRef}
              data-drop={dragOver || undefined}
              {...htmlDrag}
              className="relative rounded-[24px] bg-surface shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border transition-[box-shadow] duration-200 focus-within:shadow-[0_14px_44px_-12px_rgb(0_0_0/0.4)] data-[drop]:ring-2 data-[drop]:ring-accent/45"
            >
              <form onSubmit={submit} className="flex flex-col gap-2 px-3.5 pt-3.5 pb-3">
                {pickError ? (
                  <p role="alert" className="text-xs text-danger">
                    {pickError}
                  </p>
                ) : (
                  voice.error && (
                    <p role="alert" className="flex items-center gap-2 text-xs text-danger">
                      <span className="min-w-0">{voice.error.message}</span>
                      {voice.error.settings && (
                        <button
                          type="button"
                          onClick={() => openVoiceSettings(voice.error?.settings)}
                          className="shrink-0 rounded-full px-2 py-0.5 font-medium text-danger underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-danger/40"
                        >
                          {t.voice.openSettings}
                        </button>
                      )}
                    </p>
                  )
                )}
                <AttachmentStrip
                  items={attachments.items}
                  onRemove={attachments.remove}
                  onRemoved={attachments.finalizeRemove}
                />
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    aria-label={t.inputLabel}
                    placeholder={t.inputPlaceholder}
                    value={shownDraft}
                    readOnly={submitting || voice.recording}
                    aria-busy={submitting}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    onScroll={(e) => {
                      if (mirrorRef.current)
                        mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
                    }}
                    rows={1}
                    style={{ height: inputHeight }}
                    className={cn(
                      "scroll-none block w-full resize-none bg-transparent px-1 text-base leading-input caret-accent outline-none placeholder:text-muted/55",
                      (overflowing || expanded) && "pr-8",
                      voice.recording && voiceText && "text-transparent",
                    )}
                  />
                  {voice.recording && voiceText && (
                    // 镜像层：与输入框同样排版，把识别中的临时文本染成灰色、刚定稿的一段从灰色过渡到正文色
                    <div
                      ref={mirrorRef}
                      aria-hidden
                      style={{ height: inputHeight }}
                      className={cn(
                        "scroll-none pointer-events-none absolute inset-x-0 top-0 overflow-hidden px-1 text-base leading-input break-words whitespace-pre-wrap text-fg",
                        (overflowing || expanded) && "pr-8",
                      )}
                    >
                      {voiceFinal && voiceText.before.endsWith(voiceFinal.text) ? (
                        <>
                          {voiceText.before.slice(
                            0,
                            voiceText.before.length - voiceFinal.text.length,
                          )}
                          <span key={voiceFinal.key} className="voice-final">
                            {voiceFinal.text}
                          </span>
                        </>
                      ) : (
                        voiceText.before
                      )}
                      <span className="text-muted transition-colors">{voice.interim}</span>
                      {voiceText.after}
                    </div>
                  )}
                  {(overflowing || expanded) && (
                    <Tooltip content={expanded ? t.collapseInput : t.expandInput}>
                      <button
                        type="button"
                        aria-label={expanded ? t.collapseInput : t.expandInput}
                        onClick={() => {
                          setExpanded((v) => !v);
                          inputRef.current?.focus();
                        }}
                        className="absolute top-0 right-0 grid size-7 place-items-center rounded-lg text-muted outline-none transition-colors hover:bg-hover hover:text-fg"
                      >
                        {expanded ? (
                          <Icon name="minimize" size="sm" />
                        ) : (
                          <Icon name="maximize" size="sm" />
                        )}
                      </button>
                    </Tooltip>
                  )}
                </div>
                <div className="@container/bar flex min-w-0 items-center gap-2.5 text-xs text-muted">
                  {/* 附件：系统文件对话框选文件，只引用本地路径；薄壳未接入对话框时隐藏 */}
                  {canPickFiles && (
                    <Tooltip content={t.attach} wrap>
                      <button
                        type="button"
                        aria-label={t.attach}
                        disabled={submitting}
                        onClick={() => void pickFiles()}
                        className={composerGhostClass({ icon: true })}
                      >
                        <Icon name="plus" size="sm" />
                      </button>
                    </Tooltip>
                  )}
                  <PermissionPicker mode={permissionMode} onChange={setPermissionMode}>
                    {/* 完全访问：文字与图标用警示色；其他档位是普通的弱化幽灵按钮 */}
                    <button
                      type="button"
                      aria-label={`${t.permissionMode}：${t.permissions[permissionMode].label}`}
                      className={composerGhostClass({
                        tone: permissionMode === "full" ? "warning" : "muted",
                      })}
                    >
                      <Icon
                        name={permissionMeta[permissionMode].icon}
                        size="sm"
                        className={permissionMeta[permissionMode].tone}
                      />
                      <span>{t.permissions[permissionMode].short}</span>
                    </button>
                  </PermissionPicker>
                  <span className="flex-1" />
                  <ModelPicker
                    models={models}
                    onOpenChange={(open) => open && refreshModels()}
                    providerNames={modelConfig.providerNames}
                    onOpenSettings={openModelSettings}
                    current={currentModel}
                    thinkingLevel={
                      state.thinkingLevel ?? pendingModel.thinkingLevel ?? DEFAULT_THINKING_LEVEL
                    }
                    thinkingLevels={state.model ? state.thinkingLevels : undefined}
                    modelLocked={conversationStarted || modelLocked}
                    onSelectModel={(model) => void selectModel({ model })}
                    onSelectThinking={(thinkingLevel) => void selectModel({ thinkingLevel })}
                  />
                  {/* 上下文：紧挨模型按钮的小圆环（百分比只在无障碍名称里），点开是上下文卡片；底栏窄时隐藏 */}
                  <span className="hidden @min-[30rem]/bar:contents">
                    <ContextButton
                      usage={state.contextUsage}
                      sessionUsage={state.sessionUsage}
                      autoCompaction={state.autoCompaction}
                      compacting={state.compacting}
                      stats={state.contextStats}
                      connected={connected}
                      busy={state.running || submitting}
                      onOpen={() => {
                        // 已缓存的数据直接显示（每条回复、压缩、切换模型后已刷新；清单由扩展每轮结束重推）；
                        // 只补取还没有的
                        if (!state.contextUsage) refreshStats();
                        if (!state.contextStats) requestContextStats();
                      }}
                      onCompact={() => void compact()}
                      onAutoCompactionChange={(enabled) => void setAutoCompaction(enabled)}
                    />
                  </span>
                  {voice.available && (
                    <VoiceButton
                      recording={voice.recording}
                      levels={voice.levels}
                      elapsed={voice.elapsed}
                      disabled={submitting}
                      onStart={voice.start}
                      onStop={voice.stop}
                    />
                  )}
                  {state.running ? (
                    <Tooltip content={stopping ? t.stopping : t.stop} wrap>
                      <button
                        type="button"
                        aria-label={stopping ? t.stopping : t.stop}
                        aria-busy={stopping}
                        disabled={stopping}
                        onClick={stop}
                        className="grid aspect-square size-8 shrink-0 place-items-center rounded-full bg-fg text-surface transition-opacity disabled:opacity-40"
                      >
                        <Icon name="stop" size="xs" />
                      </button>
                    </Tooltip>
                  ) : (
                    <Tooltip
                      content={attachments.pending ? t.attachments.readingBlocksSend : undefined}
                      wrap
                    >
                      <button
                        type="submit"
                        aria-label={t.send}
                        disabled={
                          submitting ||
                          unresponsive ||
                          modelConfig.unavailable ||
                          attachments.pending ||
                          voice.recording ||
                          (!draft.trim() && !attachments.hasContent)
                        }
                        className="grid aspect-square size-8 shrink-0 place-items-center rounded-full bg-fg text-surface transition-[opacity,transform] active:scale-95 disabled:opacity-20 disabled:active:scale-100"
                      >
                        <Icon name="arrow-up" />
                      </button>
                    </Tooltip>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </FileRefBase.Provider>
  );
}
