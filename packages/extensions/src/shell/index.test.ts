import { describe, expect, it } from "vitest";
import shell, { POWERSHELL_PROMPT, powershellOnly } from "./index.ts";

type Handler = (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;

function setup(tools: () => string[]) {
  let handler: Handler | undefined;
  shell({
    on: (event: string, h: Handler) => {
      if (event === "before_agent_start") handler = h;
    },
    getActiveTools: tools,
  });
  return (systemPrompt: string) => handler?.({ systemPrompt });
}

describe("primus-shell", () => {
  it("命令工具只有 powershell 时追加 PowerShell 写法要点，只追加一次", () => {
    const run = setup(() => ["read", "powershell", "edit", "write"]);
    const first = run("base");
    expect(first?.systemPrompt).toBe(`base\n${POWERSHELL_PROMPT}`);
    expect(run(first?.systemPrompt ?? "")).toBeUndefined();
  });

  it("使用 bash（或两者都开）时不追加", () => {
    expect(setup(() => ["read", "bash", "edit"])("base")).toBeUndefined();
    expect(setup(() => ["bash", "powershell"])("base")).toBeUndefined();
  });

  it("工具列表每轮重新读取：中途切换后随之生效", () => {
    let tools = ["read", "bash"];
    const run = setup(() => tools);
    expect(run("base")).toBeUndefined();
    tools = ["read", "powershell"];
    expect(run("base")?.systemPrompt).toContain("PowerShell");
  });

  it("读取工具列表失败或没有事件 API 时什么也不做", () => {
    expect(
      setup(() => {
        throw new Error("x");
      })("base"),
    ).toBeUndefined();
    expect(() => shell({})).not.toThrow();
    expect(() => shell(null)).not.toThrow();
  });

  it("powershellOnly", () => {
    expect(powershellOnly(["powershell"])).toBe(true);
    expect(powershellOnly(["powershell", "bash"])).toBe(false);
    expect(powershellOnly([])).toBe(false);
  });
});
