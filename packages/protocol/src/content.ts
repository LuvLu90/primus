// 消息与内容块（Core 文档 message-types.md）。
// 时间戳：消息上的 timestamp 是 Unix 毫秒；会话条目上的 timestamp 是 ISO 8601 字符串（见 session.ts）。
// 线上格式是 JSON：Core 侧值为 undefined 的字段在 JSON 里直接缺省，这里一律写成可选字段。

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** 思考强度。`xhigh`、`max` 只在所选模型支持时出现 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ---------- 内容块 ----------

export interface TextContent {
  type: "text";
  text: string;
  /** 供应商相关的元数据，按不透明值处理 */
  textSignature?: string;
}

export interface ImageContent {
  type: "image";
  /** base64 编码的图片数据 */
  data: string;
  /** 如 `image/png`、`image/jpeg` */
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** 供应商相关的回放数据，按不透明值处理 */
  thinkingSignature?: string;
  /** 被遮蔽的思考块：可能没有可见文本，加密内容在 thinkingSignature 中 */
  redacted?: boolean;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 供应商相关 */
  thoughtSignature?: string;
  /** OpenAI Responses 中动态加载或带命名空间的工具 */
  namespace?: string;
}

/** @deprecated 使用 {@link ToolCall}（与 Core 文档同名） */
export type ToolCallContent = ToolCall;

export type AssistantContent = TextContent | ThinkingContent | ToolCall;
export type UserContent = TextContent | ImageContent;

// ---------- 用量 ----------

export interface Usage {
  input: number;
  /** 已包含 reasoning */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheWrite 中按 1 小时保留写入的部分 */
  cacheWrite1h?: number;
  /** 已计入 output，不要重复相加 */
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ---------- 基础消息 ----------

/** 工具定义（系统消息的 toolsAdded）。`parameters` 是 JSON Schema */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  /** 受约束采样配置；`false` 表示关闭。内容按不透明值处理 */
  constrainedSampling?: false | JsonObject;
}

export interface ToolReference {
  name: string;
}

export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  /** 按名称替换的提示分段；`null` 表示删除该分段 */
  sections?: Record<string, string | null>;
  toolsAdded?: ToolDefinition[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string | UserContent[];
  timestamp: number;
}

export type StopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

export interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: JsonObject;
}

/** stopReason 为 `deferred` 时取回结果所需的数据 */
export interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: JsonValue;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api: string;
  provider: string;
  model: string;
  /** 与请求的模型不同时，供应商实际返回的模型 */
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  thinkingLevel?: ThinkingLevel;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  /** 流式中的部分消息为 `pending`；message_end 中是终止原因 */
  stopReason: StopReason;
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  /** 请求开始的时间（毫秒） */
  timestamp: number;
  /** 从 `timestamp` 到响应结束的毫秒数（ai/src/types.ts；旧消息与延后取回的结果缺省） */
  durationMs?: number;
}

export interface NestedToolCallRecord {
  id: string;
  name: string;
  /** 超过大小限制时缺省，此时 argumentsBytes 给出其大小 */
  arguments?: JsonObject;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}

export interface NestedToolCalls {
  calls: NestedToolCallRecord[];
  /** 有调用被丢弃、参数被省略或调用未结束时为 false */
  complete: boolean;
}

export interface ToolResultMessage<TDetails = unknown> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: UserContent[];
  details?: TDetails;
  /** 工具内部模型调用的用量，不计入主模型调用 */
  usage?: Usage;
  nestedCalls?: NestedToolCalls;
  isError: boolean;
  timestamp: number;
}

// ---------- Core 扩展的消息角色 ----------

/** RPC `bash` 命令（用户 ! 命令）产生的消息，不是模型的工具结果 */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  /** 被终止或取消时缺省 */
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

/** 扩展发送的上下文消息 */
export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | UserContent[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/**
 * Core 的消息联合，只列出锁定版本中已知的角色（本类型是封闭联合，不能通过声明合并扩展）。
 * 运行时仍可能出现不在此列的 role（Core 内部的扩展角色或升级新增的角色），
 * 消费方按 role 分派并忽略不认识的角色（可用 {@link isKnownAgentMessage} 判断）。
 */
export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

export type AgentMessageRole = AgentMessage["role"];

export const AGENT_MESSAGE_ROLES = [
  "system",
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
] as const satisfies readonly AgentMessageRole[];

export function isKnownAgentMessage(value: { role?: unknown }): value is AgentMessage {
  return (AGENT_MESSAGE_ROLES as readonly unknown[]).includes(value.role);
}
