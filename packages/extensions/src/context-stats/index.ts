// primus-context-stats：上下文卡片的分项统计（只读，不改动上下文；上下文管理仍只用 Core 内置机制，第 11 章）。
// 前端在会话打开后发一次 `/primus-context-stats`，这里从 Core 公开的扩展 API 读取当前的系统提示词、
// 工具定义、技能与记忆文件（AGENTS.md 等），按 Core 压缩时同样的方法（字符数 / 4）估算各分项 token，
// 并从会话记录统计本会话实际调用过的工具，经 setWidget("primus:context-stats") 推给前端。
// 之后每轮结束（agent_end）、切换模型（model_select）时主动重推，前端打开卡片时直接用缓存，不再现场请求。
// “消息”与“可用空间”由前端用 Core 给出的总量推出。

import {
  CONTEXT_STATS_COMMAND,
  CONTEXT_STATS_WIDGET,
  type ContextStatsCategory,
  type ContextStatsData,
  type ContextStatsItem,
  type ContextStatsUsedTool,
} from "@primus/protocol";

/** 与 Core 压缩时的估算一致：字符数 / 4，向上取整 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 扩展 API 中这里用到的部分（类型不从上游包导入，见 AGENTS.md 第 2.2 节） */
export interface StatsTool {
  name: string;
  description?: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  exposure?: string;
  namespace?: { name: string };
  sourceInfo?: { path?: string };
}

/** 工具列表在扩展 API（pi）上，不在命令上下文里 */
export interface StatsTools {
  getAllTools?: () => StatsTool[];
  getActiveTools?: () => string[];
}

/** 系统提示词的构建参数（只在命令上下文里有：getSystemPromptOptions） */
export interface StatsPromptOptions {
  contextFiles?: { path: string; content: string }[];
  skills?: {
    name: string;
    description: string;
    filePath: string;
    disableModelInvocation?: boolean;
  }[];
}

/** 会话记录中这里用到的部分：assistant 消息里的 toolCall */
export interface StatsEntry {
  type: string;
  message?: { role?: string; content?: unknown };
}

/** 命令 / 事件上下文中这里用到的部分 */
export interface StatsContext {
  getSystemPrompt?: () => string;
  getSystemPromptOptions?: () => StatsPromptOptions;
  sessionManager?: { getBranch?: () => StatsEntry[]; getEntries?: () => StatsEntry[] };
  ui: { setWidget?: (key: string, lines: string[] | undefined) => void };
}

interface StatsApi extends StatsTools {
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: StatsContext) => Promise<void> },
  ) => void;
  on?: (event: string, handler: (event: unknown, ctx: StatsContext) => unknown) => unknown;
}

/**
 * 本会话（当前分支，从根到最新一条）实际调用过的工具及次数，按次数从多到少、同次数按名称。
 * 读 assistant 消息里 `content[].type === "toolCall"` 的 name；没有会话记录时为空。
 */
export function countUsedTools(ctx: StatsContext): ContextStatsUsedTool[] {
  const sm = ctx.sessionManager;
  let entries: StatsEntry[] = [];
  try {
    entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
  } catch {
    entries = [];
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as { type?: unknown; name?: unknown }[]) {
      if (part?.type === "toolCall" && typeof part.name === "string" && part.name)
        counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** MCP 服务器提供的工具：命名空间或来源是 MCP */
export function isMcpTool(tool: StatsTool): boolean {
  return (
    tool.namespace?.name.startsWith("mcp__") === true ||
    tool.sourceInfo?.path === "builtin:mcp" ||
    tool.name.startsWith("mcp__")
  );
}

/** 一个工具声明给模型的大小：名称、说明与参数 JSON Schema */
function toolTokens(tool: StatsTool): number {
  let schema = "";
  try {
    schema = JSON.stringify(tool.parameters ?? {}) ?? "";
  } catch {
    schema = "";
  }
  return estimateTokens(`${tool.name}${tool.description ?? ""}${schema}`);
}

const byTokens = (a: ContextStatsItem, b: ContextStatsItem) => b.tokens - a.tokens;

/** 按当前会话估算各分项：`ctx` 为命令上下文（系统提示词），`tools` 为扩展 API（工具列表） */
export function collectContextStats(
  ctx: StatsContext,
  tools: StatsTools = {},
  /** 事件上下文没有 getSystemPromptOptions：沿用上一次命令里取到的 */
  fallbackOptions?: StatsPromptOptions,
): ContextStatsData {
  const prompt = ctx.getSystemPrompt?.() ?? "";
  const options = ctx.getSystemPromptOptions?.() ?? fallbackOptions ?? {};
  // 记忆文件（AGENTS.md 等）整段写进系统提示词
  const memory = (options.contextFiles ?? [])
    .filter((f) => prompt.includes(f.content))
    .map((f) => ({ name: f.path, tokens: estimateTokens(`${f.path}\n${f.content}`) }));
  // 技能：系统提示词里只列名称、说明与位置（模型按需再读技能文件）
  const skills = (options.skills ?? [])
    .filter((s) => !s.disableModelInvocation && prompt.includes(s.name))
    .map((s) => ({
      name: s.name,
      tokens: estimateTokens(
        `<skill><name>${s.name}</name><description>${s.description}</description><location>${s.filePath}</location></skill>`,
      ),
    }));
  const sum = (items: ContextStatsItem[]) => items.reduce((n, i) => n + i.tokens, 0);
  const systemPrompt = Math.max(0, estimateTokens(prompt) - sum(memory) - sum(skills));

  const all = tools.getAllTools?.() ?? [];
  const active = new Set(tools.getActiveTools?.() ?? all.map((t) => t.name));
  const declared = all.filter((t) => active.has(t.name) && t.exposure !== "hidden");
  const toItem = (t: StatsTool) => ({ name: t.name, tokens: toolTokens(t) });
  const mcp = declared.filter(isMcpTool).map(toItem);
  const builtin = declared.filter((t) => !isMcpTool(t)).map(toItem);

  const category = (
    key: ContextStatsCategory["key"],
    items: ContextStatsItem[],
    tokens = sum(items),
  ): ContextStatsCategory => ({ key, tokens, items: [...items].sort(byTokens) });
  return {
    estimator: "chars/4",
    categories: [
      category("systemPrompt", [], systemPrompt),
      category("systemTools", builtin),
      category("mcpTools", mcp),
      category("skills", skills),
      category("memoryFiles", memory),
    ],
    // 未启用的工具（延迟加载 / 只供代码模式 / 关闭）不在上下文里，不再列出；只给本会话实际调用过的
    usedTools: countUsedTools(ctx),
  };
}

export default function contextStats(pi: unknown): void {
  const api = pi as Partial<StatsApi> | null | undefined;
  if (typeof api?.registerCommand !== "function") return;
  // 技能与记忆文件只能在命令上下文里取（getSystemPromptOptions）：记下最近一次，供事件里重推时沿用
  let lastOptions: StatsPromptOptions | undefined;
  // 前端请求过一次之后才主动推送（没打开过的会话不白算）
  let requested = false;
  const push = (ctx: StatsContext) => {
    const data = collectContextStats(ctx, api, lastOptions);
    ctx.ui.setWidget?.(CONTEXT_STATS_WIDGET, [
      JSON.stringify({ v: 1, type: "context-stats", data }),
    ]);
  };
  api.registerCommand(CONTEXT_STATS_COMMAND, {
    description: "统计上下文窗口各分项的估算占用（上下文卡片用，只读）",
    handler: async (_args, ctx) => {
      requested = true;
      try {
        lastOptions = ctx.getSystemPromptOptions?.();
      } catch {
        lastOptions = undefined;
      }
      push(ctx);
    },
  });
  // 一轮结束（工具调用、tool_search 加载的工具都已落定）、切换模型（系统提示词可能变化）后主动重推
  if (typeof api.on === "function") {
    for (const event of ["agent_end", "model_select"]) {
      api.on(event, (_event, ctx) => {
        if (!requested || !ctx?.ui) return;
        try {
          push(ctx);
        } catch {
          // 统计失败不影响会话；前端保留上一次的数据
        }
      });
    }
  }
}
