// primus-guard：权限模式与工具调用审批（技术方案附录 A）。
//
// 三种权限模式（界面输入框左下角的“权限”菜单，经 `/primus-mode <模式>` 设置）：
//   ask   每次询问：修改文件、运行命令、联网，以及读取工作区以外的文件，都先征求同意
//   edit  自动编辑：工作区内的读写直接执行；运行命令、联网与工作区以外的文件仍询问
//   full  完全访问：不再询问
// 询问走扩展 UI 的 select 对话框（RPC 的 extension_ui_request），用户可选“允许”“本会话内始终允许”或“拒绝”。
// 受保护路径（.env*、.git/、~/.ssh、<安装目录>\data）的写入不论模式一律拒绝，读取需要确认；
// 强制推送与下载后直接执行的命令在完全访问下也询问，且不能“始终允许”。路径按 Core 的规则解析并跟随符号链接比较。
// 没有界面（hasUI 为 false）时需要询问的调用一律拒绝；处理出错时 Core 按失败即拦截处理。
// 当前模式经 setWidget("primus:mode") 告知前端。

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** 与 Core 一致地把 Git Bash / MSYS / Cygwin / WSL 的盘符路径（`/d/…`、`/mnt/d/…`）转成 `D:\…` */
function windowsShellPath(p: string): string {
  if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
  const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
  if (!m?.[1]) return p;
  return `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * 把工具参数里的路径解析成绝对路径，规则与 Core 的工具一致（packages/coding-agent/src/utils/paths.ts）：
 * 去掉开头的 `@`，Windows 上转换 shell 盘符路径，展开 `~` 与 `file://`，再相对工作区解析。
 */
export function resolveToolPath(
  input: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  let p = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (platform === "win32") p = windowsShellPath(p);
  if (p === "~") p = home;
  else if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\")))
    p = join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {}
  }
  return resolve(cwd, p);
}

/**
 * 跟随符号链接后的真实路径。目标还不存在时，取最近的已存在祖先目录的真实路径，再接上其余部分；
 * 悬空符号链接按链接目标解析。这样工作区内指向外部的符号链接（含悬空链接）不会被当成工作区内。
 */
export function realPath(
  p: string,
  real: (p: string) => string = realpathSync.native,
  depth = 0,
): string {
  const rest: string[] = [];
  let current = resolve(p);
  for (;;) {
    try {
      return rest.length > 0 ? join(real(current), ...rest.reverse()) : real(current);
    } catch {
      // 悬空符号链接：realpath 失败，按链接目标继续解析（限制层数防止链接成环）
      if (depth < 32) {
        try {
          if (lstatSync(current).isSymbolicLink()) {
            const target = resolve(dirname(current), readlinkSync(current));
            return join(realPath(target, real, depth + 1), ...rest.reverse());
          }
        } catch {}
      }
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** `target`（绝对路径）是否在工作区 `cwd` 之内（含工作区本身），比较真实路径；Windows 上不区分大小写 */
export function insideWorkspace(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
  real?: (p: string) => string,
): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(realPath(cwd, real)), norm(realPath(resolve(cwd, target), real)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 受保护路径（技术方案第 17.4 节）：`.env*`、`.git/` 内部、`~/.ssh`、App 的数据目录 `<安装目录>\data`。
 * 写入一律拒绝（不论权限模式），读取需要确认。
 */
export function isProtectedPath(
  abs: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): boolean {
  const norm = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const parts = norm(abs).split(/[\\/]+/);
  if (parts.includes(".git")) return true;
  if ((parts.at(-1) ?? "").startsWith(".env")) return true;
  const within = (root: string) => {
    const rel = relative(norm(resolve(root)), norm(abs));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (within(join(home, ".ssh"))) return true;
  // PRIMUS_CODING_AGENT_DIR 为 <安装目录>\data\users\<SID>\core：往上三级是 data
  const coreDir = env.PRIMUS_CODING_AGENT_DIR;
  if (coreDir) {
    const data = resolve(coreDir, "..", "..", "..");
    if (basename(data).toLowerCase() === "data" && within(data)) return true;
  }
  return false;
}

/**
 * 始终询问的命令（技术方案第 17.4 节）：强制推送、下载后直接执行。完全访问模式下也询问，且不能“始终允许”。
 * 管道与 `&&`、`;` 拆开后逐段检查。
 */
export function isAlwaysAskCommand(command: string): boolean {
  const text = command.replace(/\s+/g, " ");
  if (
    /\bgit\b[^|;&]*\bpush\b[^|;&]*(\s--force(-with-lease)?\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/i.test(text)
  )
    return true;
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i.test(text)) return true;
  if (
    /\b(iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(iex|invoke-expression)\b/i.test(
      text,
    )
  )
    return true;
  return false;
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

export interface GuardEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  real?: (p: string) => string;
}

const defaultEnv = (): GuardEnv => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

export type Decision = "allow" | "ask" | "deny";

/** 按模式判断一次工具调用：放行、询问或拒绝（受保护路径的写入不论模式一律拒绝） */
export function decide(
  mode: PermissionMode,
  call: ToolCall,
  cwd: string,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  ge: GuardEnv = defaultEnv(),
): Decision {
  const raw = targetPath(call);
  const abs = raw === undefined ? undefined : resolveToolPath(raw, cwd, ge.platform, ge.home);
  const isRead = READ_TOOLS.has(call.toolName);
  const isEdit = EDIT_TOOLS.has(call.toolName);
  if (abs !== undefined && (isRead || isEdit)) {
    const real = realPath(abs, ge.real);
    const protectedPath =
      isProtectedPath(abs, ge.env, ge.platform, ge.home) ||
      isProtectedPath(real, ge.env, ge.platform, ge.home);
    if (protectedPath) return isEdit ? "deny" : "ask";
  }
  const command = call.input?.command;
  if (
    (call.toolName === "bash" || call.toolName === "powershell") &&
    typeof command === "string" &&
    isAlwaysAskCommand(command)
  )
    return "ask";
  if (mode === "full") return "allow";
  const inside = abs === undefined || insideWorkspace(cwd, abs, ge.platform, ge.real);
  if (isRead) return inside ? "allow" : "ask";
  if (isEdit) return mode === "edit" && inside ? "allow" : "ask";
  // 其他工具（命令、联网、MCP、子 Agent 等）：只有声明只读且不联网的才放行
  if (annotations?.readOnlyHint === true && annotations.openWorldHint === false) return "allow";
  return "ask";
}

/** 按模式判断一次工具调用是否需要询问（拒绝也算需要处理） */
export function needsApproval(
  mode: PermissionMode,
  call: ToolCall,
  cwd: string,
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  return decide(mode, call, cwd, annotations, { ...defaultEnv(), platform }) !== "allow";
}

/**
 * “本会话内始终允许”记住的范围：命令类工具按完整命令文本，读写类工具按解析后的绝对路径，其他工具按工具名加参数。
 * 只放行与当时确认的完全相同的操作，不会因为允许过一条命令就放行之后所有命令或其他路径的写入。
 */
export function approvalKey(call: ToolCall, cwd: string): string {
  const input = call.input ?? {};
  if (call.toolName === "bash" || call.toolName === "powershell")
    return `${call.toolName}\u0000${String(input.command ?? "")}`;
  const path = targetPath(call);
  if (path) return `${call.toolName}\u0000${resolveToolPath(path, cwd)}`;
  let args = "";
  try {
    args = JSON.stringify(input);
  } catch {}
  return `${call.toolName}\u0000${args}`;
}

/** 询问对话框的标题：说明要做什么 */
export function describeCall(call: ToolCall, cwd: string): string {
  const input = call.input ?? {};
  const path = targetPath(call);
  const where = path ? resolveToolPath(path, cwd) : "";
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
  /** 本会话内已“始终允许”的操作（见 approvalKey） */
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
      const decision = decide(state.mode, call, ctx.cwd, annotations);
      if (decision === "allow") return undefined;
      if (decision === "deny")
        return {
          block: true,
          reason: "受保护的路径（.env、.git、~/.ssh、应用数据目录）不允许写入",
        };
      const command = call.input?.command;
      const alwaysAsk = typeof command === "string" && isAlwaysAskCommand(command);
      // 用户在本会话内已对完全相同的操作选过“始终允许”（始终询问的命令除外）
      const key = approvalKey(call, ctx.cwd);
      if (!alwaysAsk && state.alwaysAllowed.has(key)) return undefined;
      if (!ctx.hasUI) return { block: true, reason: "需要确认，但当前没有可以确认的界面，已拒绝" };
      const choice = await ctx.ui.select(
        describeCall(call, ctx.cwd),
        alwaysAsk ? [CHOICES.allow, CHOICES.deny] : [CHOICES.allow, CHOICES.always, CHOICES.deny],
        { signal: ctx.signal },
      );
      if (choice === CHOICES.always) {
        state.alwaysAllowed.add(key);
        return undefined;
      }
      if (choice === CHOICES.allow) return undefined;
      return { block: true, reason: "用户拒绝了这次操作" };
    });
  }
  return { guard, state };
}

export default createGuard().guard;
