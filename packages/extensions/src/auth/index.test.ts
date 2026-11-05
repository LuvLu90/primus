import { describe, expect, it, vi } from "vitest";
import {
  type AuthDeps,
  createAuth,
  literalConfigValue,
  parseSecretCommand,
  resolveProviderKeys,
} from "./index.ts";

const exe = String.raw`D:\Primus\Primus.exe`;
const command = `!"${exe}" --secret model-token`;

function deps(over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    platform: "win32",
    env: { PRIMUS_CODING_AGENT_DIR: String.raw`D:\Primus\data\users\S-1\core` },
    exists: () => true,
    readFile: () =>
      JSON.stringify({
        providers: {
          "primus-messages": { apiKey: command },
          "primus-responses": { apiKey: command },
          other: { apiKey: "literal" },
        },
      }),
    run: vi.fn(() => "tok-123\n"),
    warn: vi.fn(),
    ...over,
  };
}

describe("primus-auth", () => {
  it("解析薄壳写入的取令牌命令", () => {
    expect(parseSecretCommand(command)).toEqual({ exe, id: "model-token" });
    expect(
      parseSecretCommand(String.raw`!"C:\Program Files\Primus\Primus.exe" --secret a.b`),
    ).toEqual({ exe: String.raw`C:\Program Files\Primus\Primus.exe`, id: "a.b" });
    for (const bad of ["literal", "$ENV", `!${exe} --secret x`, `!"${exe}" --secret x; rm`, 42]) {
      expect(parseSecretCommand(bad)).toBeNull();
    }
  });

  it("令牌按 Core 配置值的转义规则写成字面量", () => {
    expect(literalConfigValue("abc")).toBe("abc");
    expect(literalConfigValue("a$b")).toBe("a$$b");
    expect(literalConfigValue("!x")).toBe("$!x");
  });

  it("不经 shell 直接拉起 Primus.exe，同一命令只执行一次", () => {
    const d = deps();
    const keys = resolveProviderKeys(d);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledWith(exe, ["--secret", "model-token"]);
    expect([...keys]).toEqual([
      ["primus-messages", "tok-123"],
      ["primus-responses", "tok-123"],
    ]);
  });

  it("非 Windows、缺少目录或 models.json、取令牌失败时不覆盖", () => {
    expect(resolveProviderKeys(deps({ platform: "linux" })).size).toBe(0);
    expect(resolveProviderKeys(deps({ env: {} })).size).toBe(0);
    expect(resolveProviderKeys(deps({ exists: () => false })).size).toBe(0);
    expect(resolveProviderKeys(deps({ readFile: () => "{" })).size).toBe(0);
    const failing = deps({
      run: () => {
        throw new Error("denied");
      },
    });
    expect(resolveProviderKeys(failing).size).toBe(0);
    expect(failing.warn).toHaveBeenCalled();
    expect(resolveProviderKeys(deps({ run: () => "  " })).size).toBe(0);
  });

  it("把令牌注册到对应供应商；没有 registerProvider 时忽略", () => {
    const registerProvider = vi.fn();
    createAuth(deps({ run: () => "a$b" }))({ registerProvider });
    expect(registerProvider).toHaveBeenCalledWith("primus-messages", { apiKey: "a$$b" });
    expect(registerProvider).toHaveBeenCalledWith("primus-responses", { apiKey: "a$$b" });
    expect(() => createAuth(deps())({})).not.toThrow();
  });
});
