// primus-auth：模型令牌直接取，不经 shell（技术方案第 9.4 节）。
//
// 薄壳写给 Core 的 models.json 里，每个渠道的 apiKey 是取密钥命令 `!"<Primus.exe>" --secret provider:<渠道 ID>`。
// Core 在 Windows 上把这类命令交给 shell 执行：优先 Git Bash，其次 PATH 上的 bash.exe（可能是 WSL 的
// System32\bash.exe，在 Linux 里根本找不到 D:\… 这样的 Windows 路径），bash 拉起原生程序时还可能脱离 Core 的
// 作业对象——任何一种都会让取令牌失败，对话报 “Failed to resolve API key … from shell command”。
//
// 这里直接用 execFile 拉起 Primus.exe（不经任何 shell，子进程留在 Core 的作业里），
// 把取到的令牌经 registerProvider 覆盖到对应供应商（扩展层的 apiKey 优先于 models.json）。
// 取不到时什么也不做，Core 仍按 models.json 的命令重试，报错信息不变。令牌只留在 Core 进程内存中。
//
// models.json 在 Core 运行期间会被薄壳重写（首次启动在后台获取内置渠道的模型列表、设置里增删改渠道或换密钥），
// 所以不只在加载时取一次：监听 models.json 的变化，并在每次对话开始前（before_agent_start）再核对一次。
// 文件变了（含内容没变只是被重写：薄壳保存新密钥时会重写一次）就为所有渠道重新取令牌——换密钥与改配置的两次写入
// 可能被防抖合并成一次；内容变了还让 Core 重新读取 models.json（modelRegistry.refresh），Core 报告读取出错时
// 下次核对再刷新。文件没变时只补取上次没取到令牌的渠道（首次直接取失败可能是暂时的）。
// 渠道被删除、或重新取令牌失败时撤销本扩展为它设置的令牌（Core 改按 models.json 的命令取）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";

/** models.json 中取令牌命令的格式（与薄壳 core_config::secret_command 一致） */
const SECRET_COMMAND = /^!"([^"]+)" --secret ([A-Za-z0-9._:-]+)$/;

const MODELS_FILE = "models.json";

export interface SecretCommand {
  exe: string;
  id: string;
}

/** 解析取令牌命令；不是该格式返回 null */
export function parseSecretCommand(apiKey: unknown): SecretCommand | null {
  if (typeof apiKey !== "string") return null;
  const m = SECRET_COMMAND.exec(apiKey.trim());
  return m?.[1] && m[2] ? { exe: m[1], id: m[2] } : null;
}

/**
 * 把令牌写成 Core 配置值里的字面量：配置值会做 `$ENV` 插值、以 `!` 开头会当成命令，
 * 按 Core 的转义规则把 `$` 写成 `$$`，开头的 `!` 写成 `$!`。
 */
export function literalConfigValue(value: string): string {
  const escaped = value.replaceAll("$", "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export interface AuthDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  /** 文件的修改戳（mtime + 大小）；读不到时返回 null */
  stamp: (path: string) => string | null;
  /** 直接拉起程序（不经 shell），返回 stdout */
  run: (exe: string, args: string[]) => string;
  /** 监听目录中某个文件的变化；返回停止监听。不支持时返回 null */
  watch: (dir: string, file: string, onChange: () => void) => (() => void) | null;
  warn: (message: string) => void;
}

/** 合并短时间内的多次文件事件（替换写入会连续触发几次） */
const WATCH_DEBOUNCE_MS = 200;

const defaultDeps: AuthDeps = {
  platform: process.platform,
  env: process.env,
  readFile: (p) => readFileSync(p, "utf8"),
  exists: existsSync,
  stamp: (p) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return null;
    }
  },
  run: (exe, args) =>
    execFileSync(exe, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  watch: (dir, file, onChange) => {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        // 部分平台不给文件名：当作可能变化
        if (name && String(name) !== file) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
        timer.unref?.();
      });
      watcher.on("error", () => watcher.close());
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    } catch {
      return null;
    }
  },
  warn: (m) => console.error(m),
};

interface ProviderApi {
  registerProvider: (name: string, config: { apiKey: string }) => void;
  unregisterProvider?: (name: string) => void;
  on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => unknown;
}

interface Registry {
  refresh: () => Promise<unknown>;
  getError?: () => string | undefined;
}

function hasRegisterProvider(pi: unknown): pi is ProviderApi {
  return (
    typeof pi === "object" &&
    pi !== null &&
    typeof (pi as { registerProvider?: unknown }).registerProvider === "function"
  );
}

/** 事件上下文里的模型注册表（用于让 Core 重新读取 models.json） */
function registryOf(ctx: unknown): Registry | null {
  const registry = (ctx as { modelRegistry?: { refresh?: unknown } } | null)?.modelRegistry;
  return registry && typeof registry.refresh === "function" ? (registry as Registry) : null;
}

/** models.json 的位置；只在 Windows（作业对象校验）且设置了 Core 目录时启用 */
function modelsFile(deps: AuthDeps): { dir: string; file: string } | null {
  if (deps.platform !== "win32") return null;
  const dir = deps.env.PRIMUS_CODING_AGENT_DIR;
  return dir ? { dir, file: join(dir, MODELS_FILE) } : null;
}

/** 解析 models.json 的内容：供应商 → 取令牌命令（只收录取令牌命令格式的）；解析失败返回 null，空内容为没有渠道 */
function parseCommands(content: string): Map<string, SecretCommand> | null {
  let providers: Record<string, { apiKey?: unknown }>;
  try {
    providers = content.trim() ? (JSON.parse(content).providers ?? {}) : {};
  } catch {
    return null;
  }
  const commands = new Map<string, SecretCommand>();
  for (const [name, provider] of Object.entries(providers)) {
    const command = parseSecretCommand(provider?.apiKey);
    if (command) commands.set(name, command);
  }
  return commands;
}

const commandKey = (c: SecretCommand) => `${c.exe}\u0000${c.id}`;

/** 为给定供应商取令牌（同一条命令只执行一次）；返回 供应商 → 令牌（取不到的不在其中） */
function resolveCommands(
  deps: AuthDeps,
  commands: Iterable<[string, SecretCommand]>,
): Map<string, string> {
  const keys = new Map<string, string>();
  const cache = new Map<string, string | null>();
  for (const [name, command] of commands) {
    const cacheKey = commandKey(command);
    if (!cache.has(cacheKey)) {
      let value: string | null = null;
      try {
        value = deps.run(command.exe, ["--secret", command.id]).trim() || null;
      } catch {
        // 不输出命令或令牌内容；Core 之后仍会按 models.json 的命令再试一次
        deps.warn(`primus-auth：直接读取模型令牌失败（供应商 ${name}），改由内核按配置命令读取`);
      }
      cache.set(cacheKey, value);
    }
    const value = cache.get(cacheKey);
    if (value) keys.set(name, value);
  }
  return keys;
}

/** 读 models.json，为使用取令牌命令的供应商直接取令牌；返回 供应商 → 令牌 */
export function resolveProviderKeys(deps: AuthDeps = defaultDeps): Map<string, string> {
  const location = modelsFile(deps);
  if (!location || !deps.exists(location.file)) return new Map();
  let commands: Map<string, SecretCommand> | null;
  try {
    commands = parseCommands(deps.readFile(location.file));
  } catch {
    return new Map();
  }
  return commands ? resolveCommands(deps, commands) : new Map();
}

/** 本扩展已经为各供应商设置的状态：取令牌命令与是否成功设置了令牌 */
interface Applied {
  command: string;
  registered: boolean;
}

export function createAuth(deps: AuthDeps = defaultDeps) {
  return function auth(pi: unknown): void {
    if (!hasRegisterProvider(pi)) return;
    const location = modelsFile(deps);
    if (!location) return;

    const applied = new Map<string, Applied>();
    let lastContent: string | null = null;
    let lastStamp: string | null = null;
    let registry: Registry | null = null;
    let stopWatch: (() => void) | null = null;
    let queue: Promise<void> = Promise.resolve();

    /** 撤销本扩展为渠道设置的令牌；成功（或 Core 不支持撤销）返回 true */
    const unregister = (name: string): boolean => {
      if (typeof pi.unregisterProvider !== "function") return true;
      try {
        pi.unregisterProvider(name);
        return true;
      } catch {
        return false;
      }
    };

    const register = (name: string, key: string): boolean => {
      try {
        pi.registerProvider(name, { apiKey: literalConfigValue(key) });
        return true;
      } catch {
        deps.warn(`primus-auth：无法为供应商 ${name} 设置模型令牌`);
        return false;
      }
    };

    const readContent = (): string | null => {
      try {
        return deps.exists(location.file) ? deps.readFile(location.file) : "";
      } catch {
        return null;
      }
    };

    /**
     * 按当前 models.json 设置令牌。`all` 为真时所有渠道都重新取（文件被重写：可能换了密钥），
     * 否则只取新出现、命令变了或上次没取到的渠道。返回内容是否与上次不同。
     */
    const apply = (content: string, all: boolean): boolean => {
      const changed = content !== lastContent;
      lastContent = content;
      const commands = parseCommands(content);
      // 写到一半或损坏：保持现状，下次变化再处理
      if (!commands) return changed;
      const pending: [string, SecretCommand][] = [];
      for (const [name, command] of commands) {
        const prev = applied.get(name);
        if (all || !prev || !prev.registered || prev.command !== commandKey(command)) {
          pending.push([name, command]);
        }
      }
      const keys = resolveCommands(deps, pending);
      for (const [name, command] of pending) {
        const key = keys.get(name);
        let registered = key !== undefined && register(name, key);
        // 重新取令牌失败：撤销之前设置的旧令牌（否则 Core 继续用旧密钥）；撤销失败时仍记为已设置，删除渠道时再撤销
        if (!registered && applied.get(name)?.registered) registered = !unregister(name);
        applied.set(name, { command: commandKey(command), registered });
      }
      // 渠道已删除，或不再使用取令牌命令：撤销本扩展设置的令牌
      for (const [name, state] of [...applied]) {
        if (commands.has(name)) continue;
        applied.delete(name);
        // 供应商已不存在时撤销会失败，忽略
        if (state.registered) unregister(name);
      }
      return changed;
    };

    /** Core 是否还需要重新读取 models.json（内容变了但还没刷新成功） */
    let refreshPending = false;

    const refresh = async (): Promise<void> => {
      if (!registry) return;
      try {
        await registry.refresh();
        // Core 读取 models.json 出错时不抛错、改用空配置：保留待刷新状态，下次核对再试
        const error = registry.getError?.();
        refreshPending = typeof error === "string" && error.includes(MODELS_FILE);
        if (refreshPending) deps.warn("primus-auth：内核读取模型配置出错，下次核对时重试");
      } catch {
        refreshPending = true;
        deps.warn("primus-auth：内核重新读取模型配置失败");
      }
    };

    /** 核对 models.json 是否变化；变化时让 Core 重新读取并补设令牌（串行执行） */
    const sync = (): Promise<void> => {
      queue = queue
        .then(async () => {
          const stamp = deps.stamp(location.file);
          if (stamp === lastStamp && stamp !== null) {
            if (lastContent !== null && [...applied.values()].some((a) => !a.registered))
              apply(lastContent, false);
            if (refreshPending) await refresh();
            return;
          }
          const content = readContent();
          if (content === null) return;
          lastStamp = stamp;
          if (apply(content, true)) refreshPending = true;
          if (refreshPending) await refresh();
        })
        .catch(() => {
          // 不让一次失败阻断之后的核对
        });
      return queue;
    };

    // 加载时同步设置一次（Core 在创建会话前应用这些注册）
    lastStamp = deps.stamp(location.file);
    const initial = readContent();
    if (initial !== null) apply(initial, true);

    if (typeof pi.on !== "function") return;
    pi.on("session_start", (_event, ctx) => {
      registry = registryOf(ctx) ?? registry;
      stopWatch?.();
      stopWatch = deps.watch(location.dir, MODELS_FILE, () => {
        void sync();
      });
      // 加载与会话开始之间文件可能已被改写
      return sync();
    });
    pi.on("before_agent_start", (_event, ctx) => {
      registry = registryOf(ctx) ?? registry;
      return sync();
    });
    pi.on("session_shutdown", () => {
      stopWatch?.();
      stopWatch = null;
    });
  };
}

export default createAuth();
