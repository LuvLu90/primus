import { describe, expect, it, vi } from "vitest";
import {
  type AuthDeps,
  createAuth,
  literalConfigValue,
  parseSecretCommand,
  resolveProviderKeys,
} from "./index.ts";

const exe = String.raw`D:\Primus\Primus.exe`;
const command = `!"${exe}" --secret provider:ioply`;

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
    stamp: () => "1:1",
    run: vi.fn(() => "tok-123\n"),
    watch: () => null,
    warn: vi.fn(),
    ...over,
  };
}

describe("primus-auth", () => {
  it("解析薄壳写入的取令牌命令", () => {
    expect(parseSecretCommand(command)).toEqual({ exe, id: "provider:ioply" });
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
    expect(d.run).toHaveBeenCalledWith(exe, ["--secret", "provider:ioply"]);
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

  describe("models.json 在运行中变化", () => {
    /** 可改写的 models.json + 记录事件处理器的 pi 替身 */
    function harness(initial: Record<string, unknown>) {
      let content = JSON.stringify({ providers: initial });
      let mtime = 1;
      let onWatch: (() => void) | undefined;
      const stopWatch = vi.fn();
      const run = vi.fn((_exe: string, args: string[]) => `key-${args[1]}-v${mtime}`);
      const d = deps({
        readFile: () => content,
        stamp: () => `${mtime}:${content.length}`,
        run,
        watch: (_dir, file, cb) => {
          expect(file).toBe("models.json");
          onWatch = cb;
          return stopWatch;
        },
      });
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const refresh = vi.fn(async () => {});
      const ctx = { modelRegistry: { refresh } };
      const pi = {
        registerProvider: vi.fn(),
        unregisterProvider: vi.fn(),
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          handlers.set(event, handler);
        },
      };
      createAuth(d)(pi);
      return {
        pi,
        run,
        refresh,
        stopWatch,
        /** 薄壳重写 models.json（providers 为 null 时内容不变，只更新修改时间） */
        write(providers: Record<string, unknown> | null) {
          if (providers) content = JSON.stringify({ providers });
          mtime += 1;
        },
        emit: (event: string) => handlers.get(event)?.({ type: event }, ctx),
        fireWatch: () => onWatch?.(),
      };
    }
    const cmd = (id: string) => `!"${exe}" --secret provider:${id}`;

    it("加载时没有的渠道（首次启动后台获取模型）在对话开始前补取令牌并让内核重新读取", async () => {
      const h = harness({});
      expect(h.run).not.toHaveBeenCalled();
      await h.emit("session_start");
      expect(h.refresh).not.toHaveBeenCalled();

      h.write({ ioply: { apiKey: cmd("ioply") } });
      await h.emit("before_agent_start");
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.run).toHaveBeenCalledWith(exe, ["--secret", "provider:ioply"]);
      expect(h.pi.registerProvider).toHaveBeenCalledWith("ioply", {
        apiKey: "key-provider:ioply-v2",
      });
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    it("文件监听到变化时就补取（不必等到发送），并只取新增的渠道", async () => {
      const h = harness({ a: { apiKey: cmd("a") } });
      expect(h.run).toHaveBeenCalledTimes(1);
      await h.emit("session_start");
      h.write({ a: { apiKey: cmd("a") }, b: { apiKey: cmd("b") } });
      h.fireWatch();
      await h.emit("before_agent_start"); // 串行队列：等监听触发的核对完成
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.run).toHaveBeenLastCalledWith(exe, ["--secret", "provider:b"]);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      h.emit("session_shutdown");
      expect(h.stopWatch).toHaveBeenCalled();
    });

    it("取令牌命令变了重新取；内容不变但被重写（换了密钥）时全部重新取", async () => {
      const h = harness({ a: { apiKey: cmd("a") } });
      h.write({ a: { apiKey: `!"${exe}x" --secret provider:a` } });
      await h.emit("before_agent_start");
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.run).toHaveBeenLastCalledWith(`${exe}x`, ["--secret", "provider:a"]);

      h.write(null);
      await h.emit("before_agent_start");
      expect(h.run).toHaveBeenCalledTimes(3);
      expect(h.pi.registerProvider).toHaveBeenLastCalledWith("a", { apiKey: "key-provider:a-v3" });
      // 内容没变，内核不必重新读取
      expect(h.refresh).toHaveBeenCalledTimes(1);
    });

    it("没有变化时不拉起任何进程、不刷新", async () => {
      const h = harness({ a: { apiKey: cmd("a") } });
      await h.emit("session_start");
      await h.emit("before_agent_start");
      await h.emit("before_agent_start");
      h.fireWatch();
      await h.emit("before_agent_start");
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.pi.registerProvider).toHaveBeenCalledTimes(1);
      expect(h.refresh).not.toHaveBeenCalled();
    });

    it("上次没取到的渠道在文件变化后重试；渠道删除后撤销令牌", async () => {
      const h = harness({ a: { apiKey: cmd("a") }, b: { apiKey: cmd("b") } });
      h.run.mockImplementation(() => {
        throw new Error("denied");
      });
      h.write({ a: { apiKey: cmd("a") }, b: { apiKey: cmd("b") }, c: { apiKey: cmd("c") } });
      await h.emit("before_agent_start");
      // a、b 加载时已取到，只取新增的 c（失败）
      expect(h.run).toHaveBeenCalledTimes(3);
      h.run.mockImplementation(() => "ok");
      h.write({ a: { apiKey: cmd("a") }, c: { apiKey: cmd("c") } });
      await h.emit("before_agent_start");
      expect(h.run).toHaveBeenCalledTimes(4);
      expect(h.run).toHaveBeenLastCalledWith(exe, ["--secret", "provider:c"]);
      expect(h.pi.unregisterProvider).toHaveBeenCalledWith("b");
      expect(h.pi.unregisterProvider).toHaveBeenCalledTimes(1);
    });
  });
});
