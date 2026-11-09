import type { AgentMessage, AssistantMessage, CoreRecord, Usage } from "@primus/protocol";

// 脚本化的假 Core 事件流：按 Core JSON 事件流规范（json.md）生成一轮完整运行，
// 包含思考、文本流式输出、一次工具调用与工具结果、第二轮回答，最后 agent_end + agent_settled。

const MODEL = { provider: "mock", model: "mock-model", api: "mock" };

export function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 把文本切成若干增量片段，模拟流式输出 */
export function chunk(text: string, size = 6): string[] {
  const parts: string[] = [];
  const chars = Array.from(text); // 按码点切分，不拆开代理对
  for (let i = 0; i < chars.length; i += size) parts.push(chars.slice(i, i + size).join(""));
  return parts;
}

function streamText(
  records: CoreRecord[],
  kind: "text" | "thinking",
  contentIndex: number,
  text: string,
  u: Usage,
): void {
  records.push({
    type: "message_update",
    usage: u,
    assistantMessageEvent: { type: `${kind}_start`, contentIndex },
  });
  for (const delta of chunk(text)) {
    records.push({
      type: "message_update",
      usage: u,
      assistantMessageEvent: { type: `${kind}_delta`, contentIndex, delta },
    });
  }
  records.push({
    type: "message_update",
    usage: u,
    assistantMessageEvent: { type: `${kind}_end`, contentIndex, content: text },
  });
}

export interface ScenarioResult {
  records: CoreRecord[];
  /** 本轮新增的消息（供 get_messages 使用） */
  messages: AgentMessage[];
}

/** 消息里带 `#排版` 时，最终回答换成一段覆盖常见 Markdown 元素的中文示例，用于检查字号层级 */
export const TYPOGRAPHY_TAG = "#排版";
const TYPOGRAPHY_ANSWER = [
  "## 数据说明",
  "",
  "本次共分析 **2,981 条客诉**，时间跨度为 2026 年 1–10 月，字段来自 `complaints_2026.csv` 的 `类别` 与 `created_at` 两列。",
  "",
  "### 月度趋势",
  "",
  "- 3 月达到峰值 **412 条**，主要是 `物流延迟` 类；",
  "- 6 月起回落到每月 250 条左右；",
  "- 运行 `pnpm analyze --month 10` 可以重新生成本节数据。",
  "",
  "| 月份 | 客诉数 | 环比 |",
  "| --- | ---: | ---: |",
  "| 3 月 | 412 | +38% |",
  "| 4 月 | 306 | -26% |",
  "",
  "```ts",
  'const total = rows.filter((r) => r.类别 !== "咨询").length; // 2981',
  "```",
  "",
  "> 注：咨询类工单不计入客诉。",
].join("\n");

/** 消息里带 `#引用` 时，最终回答换成文件引用与网页链接混排的示例，用于检查两者的区分 */
export const REFERENCES_TAG = "#引用";
const REFERENCES_ANSWER = [
  "## 改动位置",
  "",
  "发送逻辑在 [chat-panel.tsx](apps/desktop/src/features/chat/chat-panel.tsx#L42-L58)，回复渲染在 `apps/desktop/src/features/chat/message-content.tsx:120`。",
  "",
  "- 样式：`apps/desktop/src/app/globals.css`；文案：[strings.ts](apps/desktop/src/lib/strings.ts:55)",
  "- 安装包：`C:\\Program Files\\Primus\\Primus.exe`，配置目录 `apps/desktop/src-tauri/`",
  "- 数据与报告：`complaints_2026.csv`、`docs/用户手册.pdf`、`assets/icon.png`、[发布说明](docs/release-notes.md)",
  "- 各类文件：`src-tauri/src/main.rs`、`scripts/render.py`、`package.json`、`Cargo.toml`、`.github/workflows/ci.yml`、`scripts/install.ps1`、`scripts/build.sh`、`db/schema.sql`、`public/index.html`",
  "- 办公与媒体：`docs/方案.docx`、`reports/月报.xlsx`、`slides/汇报.pptx`、`release/primus.zip`、`media/demo.mp4`、`media/提示音.mp3`、`assets/logo.svg`、`notes.txt`、`src/`",
  "",
  "参考资料：[Markdown 规范](https://spec.commonmark.org/0.31.2/) 与 https://github.com/markdown-it/markdown-it 。",
  "",
  "普通代码不会被当成文件：`console.log`、`pnpm install`、`rows.filter`。",
].join("\n");

/** 为一次 prompt 生成完整事件序列 */
export function promptScenario(prompt: string, now: number): ScenarioResult {
  const records: CoreRecord[] = [];
  const messages: AgentMessage[] = [];
  const toolCallId = `call_mock_${now}`;
  const thinking = "用户发来了一条消息。先看看工作区里有什么，再回答。";
  const firstText = "我先查看一下工作区的文件。";
  const toolArgs = { path: "README.md" };
  const toolOutput = "# 示例工作区\n\n这是 mock 平台返回的假文件内容。";
  const answer = prompt.includes(TYPOGRAPHY_TAG)
    ? TYPOGRAPHY_ANSWER
    : prompt.includes(REFERENCES_TAG)
      ? REFERENCES_ANSWER
      : `这是来自 mock 平台的模拟回答（浏览器预览模式，没有连接真实内核）。\n\n你刚才说：「${prompt}」\n\n工作区里有一个 README.md，内容是示例文本。`;

  const user: AgentMessage = { role: "user", content: prompt, timestamp: now };
  messages.push(user);
  records.push({ type: "agent_start" }, { type: "turn_start" });
  records.push({ type: "message_start", message: user }, { type: "message_end", message: user });

  // 第一轮：思考 + 文本 + 工具调用
  const u1 = usage(120, 40);
  const first: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text: firstText },
      { type: "toolCall", id: toolCallId, name: "read", arguments: toolArgs },
    ],
    stopReason: "toolUse",
    usage: u1,
    timestamp: now + 1,
    ...MODEL,
  };
  records.push({
    type: "message_start",
    message: { ...first, content: [], stopReason: "pending" },
  });
  streamText(records, "thinking", 0, thinking, u1);
  streamText(records, "text", 1, firstText, u1);
  records.push({
    type: "message_update",
    usage: u1,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 2,
      id: toolCallId,
      toolName: "read",
    },
  });
  for (const delta of chunk(JSON.stringify(toolArgs), 8)) {
    records.push({
      type: "message_update",
      usage: u1,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta },
    });
  }
  records.push({
    type: "message_update",
    usage: u1,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 2,
      toolCall: { type: "toolCall", id: toolCallId, name: "read", arguments: toolArgs },
    },
  });
  records.push({ type: "message_end", message: first });
  messages.push(first);

  // 工具执行
  const result = { content: [{ type: "text" as const, text: toolOutput }], details: {} };
  records.push({ type: "tool_execution_start", toolCallId, toolName: "read", args: toolArgs });
  records.push({
    type: "tool_execution_update",
    toolCallId,
    toolName: "read",
    args: toolArgs,
    partialResult: { content: [{ type: "text", text: "# 示例工作区" }], details: {} },
  });
  records.push({
    type: "tool_execution_end",
    toolCallId,
    toolName: "read",
    result,
    isError: false,
  });
  const toolResult: AgentMessage = {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: result.content,
    isError: false,
    timestamp: now + 2,
  };
  records.push({ type: "message_start", message: toolResult });
  records.push({ type: "message_end", message: toolResult });
  messages.push(toolResult);
  records.push({ type: "turn_end", message: first, toolResults: [toolResult] });

  // 第二轮：最终回答
  const u2 = usage(220, 80);
  const second: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: answer }],
    stopReason: "stop",
    usage: u2,
    timestamp: now + 3,
    ...MODEL,
  };
  records.push({ type: "turn_start" });
  records.push({
    type: "message_start",
    message: { ...second, content: [], stopReason: "pending" },
  });
  streamText(records, "text", 0, answer, u2);
  records.push({ type: "message_end", message: second });
  messages.push(second);
  records.push({ type: "turn_end", message: second, toolResults: [] });

  records.push({ type: "agent_end", messages: messages.slice(), willRetry: false });
  records.push({ type: "agent_settled", aborted: false });
  return { records, messages };
}

// ---------- 回复出错（浏览器预览演示错误卡片与自动重试） ----------

/**
 * 消息里带 `#错误:<类别>` 时 mock 返回对应的失败回复。错误文本仿照 Core 的真实写法
 * （`{provider} API error ({status}): {body}`，连接错误只剩 `Connection error.`）。
 * `重试` 演示自动重试 3 次后仍失败（可点“停止重试”），`重试成功` 演示重试一次后成功
 */
export const MOCK_ERROR_KINDS = [
  "连接",
  "拒绝",
  "认证",
  "限流",
  "服务端",
  "请求",
  "未知",
  "重试",
  "重试成功",
] as const;
export type MockErrorKind = (typeof MOCK_ERROR_KINDS)[number];

export function mockErrorKind(prompt: string): MockErrorKind | undefined {
  const m = /#错误[:：](\S+)/.exec(prompt);
  return MOCK_ERROR_KINDS.find((k) => k === m?.[1]);
}

/** 这些演示属于网络不通：mock 的“检测连接”（providerFetchModels）同样失败 */
export const MOCK_NETWORK_DOWN: ReadonlySet<MockErrorKind> = new Set(["连接", "拒绝", "重试"]);

function errorText(kind: MockErrorKind, provider: string): string {
  switch (kind) {
    case "拒绝":
      return "Connection error. (connect ECONNREFUSED 127.0.0.1:3304)";
    case "认证":
      return `${provider} API error (401): {"error":{"message":"Incorrect API key provided: mock****c74e","type":"invalid_request_error","code":"invalid_api_key"}}`;
    case "限流":
      return `${provider} API error (429): {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50 requests per minute."}}`;
    case "服务端":
      return `${provider} API error (529): {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;
    case "请求":
      return `${provider} API error (400): {"error":{"message":"The model \`mock-9\` does not exist or you do not have access to it.","type":"invalid_request_error"}}`;
    case "未知":
      return "Unexpected end of JSON input";
    default:
      return "Connection error.";
  }
}

/** 一段延时后推送的记录；`cancel` 为在这段等待中被 abort_retry / abort 时补上的记录 */
export interface ScenarioStep {
  delayMs: number;
  records: CoreRecord[];
  cancel?: CoreRecord[];
}

/** 失败回复的事件序列：第一段立即推送，其余按 delayMs 依次推送 */
export function errorScenario(
  kind: MockErrorKind,
  prompt: string,
  now: number,
  model: { provider: string; id: string },
): { steps: ScenarioStep[]; user: AgentMessage } {
  const user: AgentMessage = { role: "user", content: prompt, timestamp: now };
  const failed = (attempt: number, text: string): AssistantMessage => ({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: text,
    usage: usage(0, 0),
    timestamp: now + attempt * 10,
    durationMs: kind === "连接" || kind === "重试" ? 10_412 : 1_284,
    api: "openai-responses",
    provider: model.provider,
    model: model.id,
    ...(kind === "服务端"
      ? {
          diagnostics: [
            {
              type: "provider_error",
              timestamp: now + 5,
              error: { name: "APIError", message: "Overloaded", code: 529 },
              details: { requestId: "req_mock_8f3a", retryAfter: "2" },
            },
          ],
        }
      : {}),
  });
  const attemptRecords = (m: AssistantMessage): CoreRecord[] => [
    { type: "message_start", message: { ...m, stopReason: "pending" } },
    { type: "message_end", message: m },
    { type: "turn_end", message: m, toolResults: [] },
  ];
  const start: CoreRecord[] = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: user },
    { type: "message_end", message: user },
  ];
  const settled = (m: AssistantMessage): CoreRecord[] => [
    { type: "agent_end", messages: [user, m], willRetry: false },
    { type: "agent_settled", aborted: false },
  ];
  const text = errorText(kind, model.provider);

  if (kind !== "重试" && kind !== "重试成功") {
    const m = failed(0, text);
    return {
      user,
      steps: [{ delayMs: 0, records: [...start, ...attemptRecords(m), ...settled(m)] }],
    };
  }

  // 自动重试：与 Core 默认设置一致（最多 3 次，间隔 2s 起指数递增）；预览放慢一点便于观察
  const maxAttempts = kind === "重试" ? 3 : 1;
  const delays = [3000, 6000, 12000];
  const steps: ScenarioStep[] = [];
  let records: CoreRecord[] = [...start];
  let last = failed(0, text);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    records.push(...attemptRecords(last), {
      type: "auto_retry_start",
      attempt,
      maxAttempts: 3,
      delayMs: delays[attempt - 1] ?? 2000,
      errorMessage: text,
    });
    // 等待这次重试期间被停止：Core 补上 auto_retry_end（Retry cancelled），本轮以这次失败结束
    steps.push({
      delayMs: attempt === 1 ? 0 : (delays[attempt - 2] ?? 2000),
      records,
      cancel: [
        { type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" },
        ...settled(last),
      ],
    });
    records = [{ type: "turn_start" }];
    last = failed(attempt, text);
  }
  const delay = delays[maxAttempts - 1] ?? 2000;
  if (kind === "重试成功") {
    const answer = "重试成功：这是重新请求后得到的回答（mock）。";
    const ok: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: answer }],
      stopReason: "stop",
      usage: usage(120, 30),
      timestamp: now + 100,
      durationMs: 2_310,
      api: "openai-responses",
      provider: model.provider,
      model: model.id,
    };
    steps.push({
      delayMs: delay,
      records: [
        { type: "turn_start" },
        { type: "message_start", message: { ...ok, content: [], stopReason: "pending" } },
        {
          type: "message_update",
          usage: ok.usage,
          assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        },
        {
          type: "message_update",
          usage: ok.usage,
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: answer },
        },
        { type: "message_end", message: ok },
        { type: "auto_retry_end", success: true, attempt: maxAttempts },
        { type: "turn_end", message: ok, toolResults: [] },
        ...settled(ok),
      ],
    });
  } else {
    steps.push({
      delayMs: delay,
      records: [
        { type: "turn_start" },
        ...attemptRecords(last),
        { type: "auto_retry_end", success: false, attempt: maxAttempts, finalError: text },
        ...settled(last),
      ],
    });
  }
  return { user, steps };
}
