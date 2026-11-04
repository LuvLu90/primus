import { describe, expect, it, vi } from "vitest";
import {
  approvalKey,
  CHOICES,
  createGuard,
  describeCall,
  insideWorkspace,
  MODE_COMMAND,
  MODE_WIDGET,
  needsApproval,
} from "./index.ts";

const cwd = "/work/proj";

describe("primus-guard 权限判断", () => {
  it("判断路径是否在工作区内", () => {
    expect(insideWorkspace(cwd, "src/a.ts", "linux")).toBe(true);
    expect(insideWorkspace(cwd, "/work/proj", "linux")).toBe(true);
    expect(insideWorkspace(cwd, "../other/a.ts", "linux")).toBe(false);
    expect(insideWorkspace(cwd, "/etc/passwd", "linux")).toBe(false);
    expect(insideWorkspace(cwd, "/work/projX/a", "linux")).toBe(false);
  });

  it("每次询问：修改文件、命令、工作区外读取都询问，工作区内读取放行", () => {
    const n = (toolName: string, input: Record<string, unknown> = {}) =>
      needsApproval("ask", { toolName, input }, cwd, undefined, "linux");
    expect(n("read", { path: "a.ts" })).toBe(false);
    expect(n("grep", {})).toBe(false);
    expect(n("read", { path: "/etc/hosts" })).toBe(true);
    expect(n("write", { path: "a.ts" })).toBe(true);
    expect(n("edit", { path: "a.ts" })).toBe(true);
    expect(n("bash", { command: "ls" })).toBe(true);
    expect(n("web_fetch", { url: "https://x" })).toBe(true);
  });

  it("自动编辑：工作区内读写放行，命令与工作区外的修改仍询问", () => {
    const n = (toolName: string, input: Record<string, unknown> = {}) =>
      needsApproval("edit", { toolName, input }, cwd, undefined, "linux");
    expect(n("write", { path: "a.ts" })).toBe(false);
    expect(n("edit", { path: "src/b.ts" })).toBe(false);
    expect(n("write", { path: "/tmp/x" })).toBe(true);
    expect(n("bash", { command: "ls" })).toBe(true);
    expect(n("powershell", { command: "dir" })).toBe(true);
  });

  it("完全访问不询问；声明只读且不联网的工具放行", () => {
    expect(needsApproval("full", { toolName: "bash", input: {} }, cwd)).toBe(false);
    expect(
      needsApproval(
        "ask",
        { toolName: "mcp_x", input: {} },
        cwd,
        { readOnlyHint: true, openWorldHint: false },
        "linux",
      ),
    ).toBe(false);
    expect(
      needsApproval("ask", { toolName: "mcp_x", input: {} }, cwd, { readOnlyHint: true }, "linux"),
    ).toBe(true);
  });

  it("“始终允许”的记录键按命令文本或解析后的路径区分", () => {
    expect(approvalKey({ toolName: "bash", input: { command: "ls" } }, cwd)).not.toBe(
      approvalKey({ toolName: "bash", input: { command: "ls -la" } }, cwd),
    );
    expect(approvalKey({ toolName: "write", input: { path: "a.ts" } }, cwd)).toBe(
      approvalKey({ toolName: "write", input: { path: "/work/proj/a.ts" } }, cwd),
    );
    expect(approvalKey({ toolName: "write", input: { path: "a.ts" } }, cwd)).not.toBe(
      approvalKey({ toolName: "write", input: { path: "/etc/a.ts" } }, cwd),
    );
  });

  it("询问标题说明操作内容", () => {
    expect(describeCall({ toolName: "bash", input: { command: "npm test" } }, cwd)).toBe(
      "运行命令：npm test",
    );
    expect(describeCall({ toolName: "write", input: { path: "a.ts" } }, cwd)).toContain("a.ts");
  });
});

function fakePi() {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
  const pi = {
    on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = h;
    },
    registerCommand: (
      name: string,
      o: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      commands[name] = o.handler;
    },
    getAllTools: () => [],
  };
  return { pi, handlers, commands };
}

function ctx(choice?: string, hasUI = true) {
  return {
    hasUI,
    cwd,
    ui: { select: vi.fn(async () => choice), setWidget: vi.fn(), notify: vi.fn() },
  };
}

describe("primus-guard 扩展", () => {
  it("/primus-mode 切换模式并通过 primus:mode 告知前端", async () => {
    const { guard, state } = createGuard();
    const { pi, commands, handlers } = fakePi();
    guard(pi);
    const c = ctx();
    await commands[MODE_COMMAND]?.("edit", c);
    expect(state.mode).toBe("edit");
    expect(c.ui.setWidget).toHaveBeenCalledWith(MODE_WIDGET, [
      JSON.stringify({ v: 1, type: "mode", data: { mode: "edit" } }),
    ]);
    await commands[MODE_COMMAND]?.("bogus", c);
    expect(state.mode).toBe("edit");
    expect(c.ui.notify).toHaveBeenCalled();
    // 自动编辑下工作区内写入不询问
    const w = ctx();
    expect(await handlers.tool_call?.({ toolName: "write", input: { path: "a" } }, w)).toBe(
      undefined,
    );
    expect(w.ui.select).not.toHaveBeenCalled();
  });

  it("询问后按选择放行或拒绝；“始终允许”在本会话内记住；没有界面时拒绝", async () => {
    const { guard } = createGuard();
    const { pi, handlers } = fakePi();
    guard(pi);
    const call = { toolName: "bash", input: { command: "ls" } };
    const tool = handlers.tool_call;
    if (!tool) throw new Error("没有注册 tool_call");
    expect(await tool(call, ctx(CHOICES.deny))).toMatchObject({ block: true });
    expect(await tool(call, ctx(undefined))).toMatchObject({ block: true });
    expect(await tool(call, ctx(CHOICES.allow))).toBe(undefined);
    expect(await tool(call, ctx(CHOICES.allow, false))).toMatchObject({ block: true });
    expect(await tool(call, ctx(CHOICES.always))).toBe(undefined);
    const again = ctx(CHOICES.deny);
    expect(await tool(call, again)).toBe(undefined);
    expect(again.ui.select).not.toHaveBeenCalled();
    // 只记住完全相同的操作：其他命令、其他路径仍然询问
    const other = ctx(CHOICES.deny);
    expect(await tool({ toolName: "bash", input: { command: "rm -rf /" } }, other)).toMatchObject({
      block: true,
    });
    expect(other.ui.select).toHaveBeenCalledTimes(1);
  });
});
