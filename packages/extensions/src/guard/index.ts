// primus-guard：权限模式与工具调用审批（技术方案附录 A）。
//
// 三种权限模式（界面输入框左下角的“权限”菜单，经 `/primus-mode <模式>` 设置）：
//   ask   每次询问：修改文件、运行命令、联网，以及读取工作区以外的文件，都先征求同意
//   edit  自动编辑：工作区内的读写直接执行；运行命令、联网与工作区以外的文件仍询问
//   full  完全访问：不再询问
// 询问走扩展 UI 的 select 对话框（RPC 的 extension_ui_request），用户可选“允许”“本会话内始终允许”或“拒绝”。
// 没有界面（hasUI 为 false）时需要询问的调用一律拒绝；处理出错时 Core 按失败即拦截处理。
// 当前模式经 setWidget("primus:mode") 告知前端。

import { isAbsolute, relative, resolve } from "node:path";

export const MODES = ["ask", "edit", "full"] as const;
export type PermissionMode = (typeof MODES)[number];

export const MODE_COMMAND = "primus-mode";
export const MODE_WIDGET = "primus:mode";

export const CHOICES = {
  allow: "允许",
  always: "本会话内始终允许",
  deny: "拒绝",
} as const;

/** 只读取文件内容的内置工具 */
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** 修改文件的内置工具 */
const EDIT_TOOLS = new Set(["write", "edit"]);

export function isMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** `target` 是否在工作区 `cwd` 之内（含工作区本身）；Windows 上不区分大小写 */
export function insideWorkspace(cwd: string, target: string, platform = process.platform): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const full = resolve(cwd, target);
  const rel = relative(norm(resolve(cwd)), norm(full));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** 工具调用涉及的路径（读写类工具）；没有则为 undefined */
function targetPath(call: ToolCall): string | undefined {
  const p = call.input?.path;
  return typeof p === "string" && p.trim() ? p : undefined;
}

/** 按模式判断一次工具调用是否需要询问 */
export function needsApproval(
  mode: PermissionMode,
  call: ToolCall,
  cwd: string,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (mode === "full") return false;
  const path = targetPath(call);
  const inside = path === undefined || insideWorkspace(cwd, path, platform);
  if (READ_TOOLS.has(call.toolName)) return !inside;
  if (EDIT_TOOLS.has(call.toolName)) return mode === "ask" || !inside;
  // 其他工具（命令、联网、MCP、子 Agent 等）：只有声明只读且不联网的才放行
  if (annotations?.readOnlyHint === true && annotations.openWorldHint === false) return false;
  return true;
}

/** 询问对话框的标题：说明要做什么 */
export function describeCall(call: ToolCall, cwd: string): string {
  const input = call.input ?? {};
  const path = targetPath(call);
  const where = path ? resolve(cwd, path) : "";
  switch (call.toolName) {
    case "bash":
    case "powershell":
      return `运行命令：${String(input.command ?? "")}`;
    case "write":
      return `写入文件：${where}`;
    case "edit":
      return `修改文件：${where}`;
    case "read":
    case "grep":
    case "find":
    case "ls":
      return `读取工作区以外的内容：${where}`;
    default: {
      let args = "";
      try {
        args = JSON.stringify(input);
      } catch {}
      if (args.length > 400) args = `${args.slice(0, 400)}…`;
      return `使用工具 ${call.toolName}${args && args !== "{}" ? `：${args}` : ""}`;
    }
  }
}

interface UiContext {
  hasUI: boolean;
  cwd: string;
  signal?: AbortSignal;
  ui: {
    select: (
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    setWidget?: (key: string, lines: string[] | undefined) => void;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

interface GuardApi {
  on: (event: string, handler: (event: never, ctx: UiContext) => unknown) => void;
  registerCommand: (
    name: string,
    options: { description: string; handler: (args: string, ctx: UiContext) => Promise<void> },
  ) => void;
  getAllTools?: () => {
    name: string;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  }[];
}

function isGuardApi(pi: unknown): pi is GuardApi {
  const p = pi as Partial<GuardApi> | null;
  return typeof p?.on === "function" && typeof p.registerCommand === "function";
}

function publishMode(ctx: UiContext, mode: PermissionMode): void {
  ctx.ui.setWidget?.(MODE_WIDGET, [JSON.stringify({ v: 1, type: "mode", data: { mode } })]);
}

export interface GuardState {
  mode: PermissionMode;
  /** 本会话内已“始终允许”的工具 */
  alwaysAllowed: Set<string>;
}

export function createGuard(initial: PermissionMode = "ask") {
  const state: GuardState = { mode: initial, alwaysAllowed: new Set() };
  function guard(pi: unknown): void {
    if (!isGuardApi(pi)) return;
    pi.registerCommand(MODE_COMMAND, {
      description: "设置权限模式：ask（每次询问）、edit（自动编辑）、full（完全访问）",
      handler: async (args, ctx) => {
        const mode = args.trim();
        if (!isMode(mode)) {
          ctx.ui.notify?.(`未知的权限模式：${mode || "（空）"}`, "error");
          return;
        }
        state.mode = mode;
        publishMode(ctx, mode);
      },
    });
    pi.on("session_start", (_event, ctx) => publishMode(ctx, state.mode));
    pi.on("tool_call", async (event: never, ctx) => {
      const call = event as ToolCall;
      const annotations = pi.getAllTools?.().find((t) => t.name === call.toolName)?.annotations;
      if (!needsApproval(state.mode, call, ctx.cwd, annotations)) return undefined;
      // 用户在本会话内已对这个工具选过“始终允许”
      if (state.alwaysAllowed.has(call.toolName)) return undefined;
      if (!ctx.hasUI) return { block: true, reason: "需要确认，但当前没有可以确认的界面，已拒绝" };
      const choice = await ctx.ui.select(
        describeCall(call, ctx.cwd),
        [CHOICES.allow, CHOICES.always, CHOICES.deny],
        { signal: ctx.signal },
      );
      if (choice === CHOICES.always) {
        state.alwaysAllowed.add(call.toolName);
        return undefined;
      }
      if (choice === CHOICES.allow) return undefined;
      return { block: true, reason: "用户拒绝了这次操作" };
    });
  }
  return { guard, state };
}

export default createGuard().guard;
