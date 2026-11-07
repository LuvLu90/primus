// primus-auth：模型令牌直接取，不经 shell（技术方案第 9.4 节）。
//
// 薄壳写给 Core 的 models.json 里，每个渠道的 apiKey 是取密钥命令 `!"<Primus.exe>" --secret provider:<渠道 ID>`。
// Core 在 Windows 上把这类命令交给 shell 执行：优先 Git Bash，其次 PATH 上的 bash.exe（可能是 WSL 的
// System32\bash.exe，在 Linux 里根本找不到 D:\… 这样的 Windows 路径），bash 拉起原生程序时还可能脱离 Core 的
// 作业对象——任何一种都会让取令牌失败，对话报 “Failed to resolve API key … from shell command”。
//
// 这里在 Core 加载扩展时直接用 execFile 拉起 Primus.exe（不经任何 shell，子进程留在 Core 的作业里），
// 把取到的令牌经 registerProvider 覆盖到对应供应商（扩展层的 apiKey 优先于 models.json）。
// 取不到时什么也不做，Core 仍按 models.json 的命令重试，报错信息不变。令牌只留在 Core 进程内存中。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** models.json 中取令牌命令的格式（与薄壳 core_config::secret_command 一致） */
const SECRET_COMMAND = /^!"([^"]+)" --secret ([A-Za-z0-9._:-]+)$/;

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
  /** 直接拉起程序（不经 shell），返回 stdout */
  run: (exe: string, args: string[]) => string;
  warn: (message: string) => void;
}

const defaultDeps: AuthDeps = {
  platform: process.platform,
  env: process.env,
  readFile: (p) => readFileSync(p, "utf8"),
  exists: existsSync,
  run: (exe, args) =>
    execFileSync(exe, args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  warn: (m) => console.error(m),
};

interface ProviderApi {
  registerProvider: (name: string, config: { apiKey: string }) => void;
}

function hasRegisterProvider(pi: unknown): pi is ProviderApi {
  return (
    typeof pi === "object" &&
    pi !== null &&
    typeof (pi as { registerProvider?: unknown }).registerProvider === "function"
  );
}

/** 读 models.json，为使用取令牌命令的供应商直接取令牌；返回 供应商 → 令牌 */
export function resolveProviderKeys(deps: AuthDeps = defaultDeps): Map<string, string> {
  const keys = new Map<string, string>();
  // 取令牌模式只在 Windows 上可用（作业对象校验）；其他平台由开发配置直接给出密钥
  if (deps.platform !== "win32") return keys;
  const coreDir = deps.env.PRIMUS_CODING_AGENT_DIR;
  if (!coreDir) return keys;
  const file = join(coreDir, "models.json");
  if (!deps.exists(file)) return keys;
  let providers: Record<string, { apiKey?: unknown }>;
  try {
    providers = JSON.parse(deps.readFile(file)).providers ?? {};
  } catch {
    return keys;
  }
  // 同一条命令只执行一次
  const cache = new Map<string, string | null>();
  for (const [name, provider] of Object.entries(providers)) {
    const command = parseSecretCommand(provider?.apiKey);
    if (!command) continue;
    const cacheKey = `${command.exe}\u0000${command.id}`;
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

export function createAuth(deps: AuthDeps = defaultDeps) {
  return function auth(pi: unknown): void {
    if (!hasRegisterProvider(pi)) return;
    for (const [name, key] of resolveProviderKeys(deps)) {
      try {
        pi.registerProvider(name, { apiKey: literalConfigValue(key) });
      } catch {
        deps.warn(`primus-auth：无法为供应商 ${name} 设置模型令牌`);
      }
    }
  };
}

export default createAuth();
