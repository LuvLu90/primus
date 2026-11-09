import { CONTEXT_STATS_COMMAND, CONTEXT_STATS_WIDGET } from "@primus/protocol";
import { describe, expect, it, vi } from "vitest";
import contextStats, {
  collectContextStats,
  countUsedTools,
  isMcpTool,
  type StatsContext,
  type StatsEntry,
  type StatsTools,
} from "./index.ts";

const AGENTS = "# 项目约定\n".repeat(40);
const PROMPT = `你是乾元。\n${"基础规则。".repeat(100)}\n<project_context>\nAGENTS.md\n${AGENTS}\n</project_context>\n<available_skills><skill><name>pdf</name></skill></available_skills>`;

const toolCall = (name: string) => ({ type: "toolCall", id: name, name, arguments: {} });
const ENTRIES: StatsEntry[] = [
  { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  {
    type: "message",
    message: { role: "assistant", content: [toolCall("read"), toolCall("bash"), toolCall("read")] },
  },
  { type: "message", message: { role: "toolResult", content: [toolCall("fake")] } },
  { type: "compaction" },
  {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }, toolCall("lazy")] },
  },
];

function ctx(overrides: Partial<StatsContext> = {}): StatsContext {
  return {
    getSystemPrompt: () => PROMPT,
    getSystemPromptOptions: () => ({
      contextFiles: [{ path: "AGENTS.md", content: AGENTS }],
      skills: [
        { name: "pdf", description: "处理 PDF", filePath: "/s/pdf/SKILL.md" },
        {
          name: "hidden",
          description: "不给模型",
          filePath: "/s/h/SKILL.md",
          disableModelInvocation: true,
        },
      ],
    }),
    sessionManager: { getBranch: () => ENTRIES },
    ui: {},
    ...overrides,
  };
}

// 工具列表来自扩展 API（pi），不在命令上下文里
const TOOLS: StatsTools = {
  getAllTools: () => [
    {
      name: "read",
      description: "读取文件",
      parameters: { type: "object" },
      sourceInfo: { path: "builtin:read" },
    },
    { name: "bash", description: "运行命令".repeat(20), parameters: { type: "object" } },
    { name: "search", description: "搜索文档", namespace: { name: "mcp__docs" } },
    { name: "lazy", description: "延迟加载", exposure: "deferred" },
  ],
  getActiveTools: () => ["read", "bash", "search"],
};

describe("primus-context-stats 上下文清单", () => {
  it("区分 MCP 工具与其他工具", () => {
    expect(isMcpTool({ name: "x", namespace: { name: "mcp__docs" } })).toBe(true);
    expect(isMcpTool({ name: "x", sourceInfo: { path: "builtin:mcp" } })).toBe(true);
    expect(isMcpTool({ name: "mcp__a__b" })).toBe(true);
    expect(isMcpTool({ name: "read", sourceInfo: { path: "builtin:read" } })).toBe(false);
  });

  it("只列名称、不给 token 数；工具只列声明给模型的，未启用的不列出", () => {
    const data = collectContextStats(ctx(), TOOLS);
    expect(data.groups).toEqual([
      { key: "systemTools", items: ["bash", "read"] },
      { key: "mcpTools", items: ["search"] },
      // 不给模型调用的技能不在系统提示词里
      { key: "skills", items: ["pdf"] },
      { key: "memoryFiles", items: ["AGENTS.md"] },
    ]);
    // 不含任何估算字段
    expect(JSON.stringify(data)).not.toMatch(/tokens|estimat/);
    expect(data).not.toHaveProperty("deferredTools");
    // 只列本会话实际调用过的工具（含后来经 tool_search 加载的），按次数从多到少
    expect(data.usedTools).toEqual([
      { name: "read", count: 2 },
      { name: "bash", count: 1 },
      { name: "lazy", count: 1 },
    ]);
  });

  it("技能只认 <available_skills> 里列出的条目，提示词别处出现技能名不算", () => {
    const prompt = `你是乾元。\n<project_context>\nAGENTS.md\n${AGENTS}\n用 pdf 导出</project_context>`;
    const data = collectContextStats(ctx({ getSystemPrompt: () => prompt }), TOOLS);
    expect(data.groups.find((g) => g.key === "skills")?.items).toEqual([]);
  });

  it("统计调用过的工具：优先当前分支，退回全部记录；只看 assistant 的 toolCall；读取出错为空", () => {
    expect(countUsedTools({ ui: {}, sessionManager: { getEntries: () => ENTRIES } })).toHaveLength(
      3,
    );
    expect(
      countUsedTools({
        ui: {},
        sessionManager: {
          getBranch: () => {
            throw new Error("boom");
          },
        },
      }),
    ).toEqual([]);
    expect(countUsedTools({ ui: {} })).toEqual([]);
  });

  it("扩展 API 缺项时退化为空清单，不抛错", () => {
    const data = collectContextStats({ ui: {} });
    expect(data.groups.every((g) => g.items.length === 0)).toBe(true);
    expect(data.usedTools).toEqual([]);
  });

  it("注册 /primus-context-stats，执行后经 primus:context-stats 推给前端", async () => {
    const registerCommand = vi.fn();
    contextStats({ registerCommand, ...TOOLS });
    expect(registerCommand).toHaveBeenCalledWith(CONTEXT_STATS_COMMAND, expect.any(Object));
    const handler = registerCommand.mock.calls[0]?.[1].handler as (
      args: string,
      c: StatsContext,
    ) => Promise<void>;
    const setWidget = vi.fn();
    await handler("", ctx({ ui: { setWidget } }));
    expect(setWidget).toHaveBeenCalledWith(CONTEXT_STATS_WIDGET, [expect.any(String)]);
    const payload = JSON.parse(setWidget.mock.calls[0]?.[1][0]);
    expect(payload).toMatchObject({ v: 1, type: "context-stats" });
    expect(payload.data.groups).toHaveLength(4);
    expect(payload.data.usedTools[0]).toEqual({ name: "read", count: 2 });
  });

  it("请求过一次后，agent_end / model_select 时主动重推；技能与记忆文件沿用命令里取到的", async () => {
    const registerCommand = vi.fn();
    const handlers = new Map<string, (e: unknown, c: StatsContext) => unknown>();
    const on = vi.fn((event: string, h: (e: unknown, c: StatsContext) => unknown) => {
      handlers.set(event, h);
    });
    contextStats({ registerCommand, on, ...TOOLS });
    expect([...handlers.keys()]).toEqual(["agent_end", "model_select"]);
    const setWidget = vi.fn();
    // 事件上下文没有 getSystemPromptOptions
    const eventCtx = ctx({ ui: { setWidget }, getSystemPromptOptions: undefined });
    // 前端还没请求过：不推
    handlers.get("agent_end")?.({}, eventCtx);
    expect(setWidget).not.toHaveBeenCalled();
    const handler = registerCommand.mock.calls[0]?.[1].handler as (
      args: string,
      c: StatsContext,
    ) => Promise<void>;
    await handler("", ctx({ ui: { setWidget: vi.fn() } }));
    handlers.get("agent_end")?.({}, eventCtx);
    handlers.get("model_select")?.({}, eventCtx);
    expect(setWidget).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(setWidget.mock.calls[0]?.[1][0]);
    const memory = payload.data.groups.find((g: { key: string }) => g.key === "memoryFiles");
    expect(memory.items).toEqual(["AGENTS.md"]);
    // 统计出错不抛到 Core
    expect(() =>
      handlers.get("agent_end")?.(
        {},
        ctx({
          ui: { setWidget },
          getSystemPrompt: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).not.toThrow();
  });

  it("没有扩展 API 时什么也不做", () => {
    expect(() => contextStats(undefined)).not.toThrow();
    expect(() => contextStats({})).not.toThrow();
  });
});
